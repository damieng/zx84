/**
 * Port I/O dispatch and memory hooks.
 *
 * Wires the Z80 CPU's port-in/port-out handlers and memory read/write hooks
 * to the appropriate Spectrum subsystems (ULA, AY, memory banking, FDC,
 * Kempston joystick, contention, and floating bus).
 */

import type { Spectrum } from '@/spectrum.ts';
import { is128kClass, isPlus2AClass, isPlus3 } from '@/spectrum.ts';

/**
 * Override Z80 read8/write8 to apply per-access ULA contention and
 * silently discard writes to ROM (0x0000-0x3FFF).
 */
export function installMemoryHooks(s: Spectrum): void {
  const memory = s.memory;
  const contention = s.contention;

  s.cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    if (contention.isContended(addr)) {
      s.cpu.tStates += contention.contentionDelay(s.cpu.tStates);
    }
    return s.cpu.memory[addr];
  };

  s.cpu.write8 = (addr: number, val: number): void => {
    addr &= 0xFFFF;
    if (contention.isContended(addr)) {
      s.cpu.tStates += contention.contentionDelay(s.cpu.tStates);
    }
    if (addr < 0x4000 && !memory.specialPaging) return; // ROM — silently discard
    // Log VRAM writes for sub-frame rendering replay
    if (s.subFrameRendering && addr >= 0x4000 && addr < 0x5B00) {
      s.logVRAMWrite(addr, val);
    }
    // Count attribute writes for rainbow detection
    if (addr >= 0x5800 && addr < 0x5B00) s.activity.attrWrites++;
    s.cpu.memory[addr] = val & 0xFF;
  };

  s.cpu.portIn = (port: number): number => {
    contention.applyIOContention(port, s.cpu);
    const val = s.cpu.portInHandler ? s.cpu.portInHandler(port) : 0xFF;
    if (s.tracing && s.traceMode !== 'full') s.logPortAccess('IN', port, val);
    return val;
  };

  s.cpu.portOut = (port: number, val: number): void => {
    contention.applyIOContention(port, s.cpu);
    if (s.tracing && s.traceMode !== 'full') s.logPortAccess('OUT', port, val);
    if (s.cpu.portOutHandler) s.cpu.portOutHandler(port, val);
  };
}

export function wirePortIO(s: Spectrum): void {
  s.cpu.portOutHandler = (port: number, val: number) => {
    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      const newBeeperBit = (val >> 4) & 1;
      if (newBeeperBit !== s.mixer.prevBeeperBit) {
        s.activity.beeperToggled = true;
        s.mixer.prevBeeperBit = newBeeperBit;
      }
      // Log border color changes for sub-frame rendering
      if (s.subFrameRendering) {
        const newBorder = val & 0x07;
        if (newBorder !== s.ula.borderColor) {
          const frameTStates = s.cpu.tStates - s.contention.frameStartTStates;
          s.borderChanges.push([frameTStates, newBorder]);
        }
      }
      s.ula.writePort(val);
    }

    // 128K bank switching: port 0x7FFD
    if (is128kClass(s.model)) {
      // +2A: strict decode (port & 0xC002) === 0x4000 to avoid 0x1FFD collision
      // 128K/+2: loose decode (port & 0x8002) === 0
      const match7FFD = isPlus2AClass(s.model)
        ? (port & 0xC002) === 0x4000
        : (port & 0x8002) === 0;
      if (match7FFD) {
        s.memory.bankSwitch(val);
        s.cpu.memory = s.memory.flat;
      }

      // +2A: port 0x1FFD (port & 0xF002) === 0x1000
      if (isPlus2AClass(s.model) && (port & 0xF002) === 0x1000) {
        s.memory.bankSwitch1FFD(val);
        if (isPlus3(s.model)) s.fdc.motorOn = (val & 0x08) !== 0;
        s.cpu.memory = s.memory.flat;
      }

      // +3 FDC data write: port 0x3FFD (A13=1, A12=1, A1=0)
      if (isPlus3(s.model) && (port & 0xF002) === 0x3000) {
        s.fdc.writeData(val);
        s.activity.fdcAccesses++;
      }
    }

    // AMX mouse PIO control ports (active when AMX enabled, A7=0)
    if (s.amxMouse.enabled && (port & 0x80) === 0) {
      const lo = port & 0xE0;
      if (lo === 0x40) { s.amxMouse.pioControlWrite('A', val); }  // 0x5F: Port A control
      if (lo === 0x60) { s.amxMouse.pioControlWrite('B', val); }  // 0x7F: Port B control
    }

    // AY ports — 128K only (48K has no AY chip)
    if (is128kClass(s.model)) {
      // AY register select: port 0xFFFD (A15=1, A14=1, A1=0)
      if ((port & 0xC002) === 0xC000) {
        s.ay.selectedReg = val & 0x0F;
      }

      // AY data write: port 0xBFFD (A15=1, A14=0, A1=0)
      if ((port & 0xC002) === 0x8000) {
        s.ay.writeRegister(s.ay.selectedReg, val);
        s.activity.ayWrites++;
      }
    }
  };

  // DEBUG: tape loading diagnostics — per-read timing in DATA phase
  let _dbgPhase = '';
  let _dbgLastReadT = 0;
  let _dbgLastEar = -1;
  let _dbgLastEdgeT = 0;
  let _dbgEdges = 0;
  let _dbgReads = 0;         // consecutive reads in current phase
  let _dbgDataLogs = 0;
  const _dbgMaxDataLogs = 3000;
  let _dbgRomDumped = false;
  let _dbgDataStartIX = 0;   // IX at start of DATA phase
  let _dbgBlockNum = 0;      // which block we're loading

  s.cpu.portInHandler = (port: number): number => {
    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      s.activity.ulaReads++;

      // Advance tape to current T-state BEFORE reading the EAR bit.
      // This ensures the ROM's IN A,($FE) sees the correct tape signal
      // at the exact T-state of the read, not one instruction behind.
      s.advanceTapeTo();
      if (s.ula.tapeActive) s.activity.earReads++;

      // DEBUG: log tape loading with per-read timing
      if (s.ula.tapeActive) {
        const ear = s.ula.tapeEarBit;
        const t = s.cpu.tStates;
        const ds = s.tape.debugState();
        const isEdge = ear !== _dbgLastEar && _dbgLastEar !== -1;
        if (isEdge) _dbgEdges++;
        _dbgReads++;

        // Log phase transitions (always, regardless of log limit)
        if (ds.phase !== _dbgPhase) {
          const prevPhase = _dbgPhase;
          _dbgPhase = ds.phase;
          _dbgReads = 0;
          console.log(`[TAPE-DBG] === Phase ${prevPhase || '?'} -> ${ds.phase} === T=${t} edges=${_dbgEdges} turbo=${s.tapeTurbo}`);
          if (ds.phase === 'DATA') {
            _dbgEdges = 0;
            _dbgBlockNum++;
            _dbgDataStartIX = s.cpu.ix;
            console.log(`[TAPE-DBG] BLOCK #${_dbgBlockNum} rawLen=${ds.rawLen} bit0=${ds.bBit0}T bit1=${ds.bBit1}T`);
            console.log(`[TAPE-DBG] IX=${_dbgDataStartIX.toString(16).padStart(4, '0')} DE=${(s.cpu.d * 256 + s.cpu.e).toString(16).padStart(4, '0')}`)
            console.log(`[TAPE-DBG] Expected: ${s.tape.debugRawBytes(32)}`);
            // Dump ROM tape routine bytes (one-time)
            if (!_dbgRomDumped) {
              _dbgRomDumped = true;
              const rom = s.cpu.memory;
              const dumpHex = (start: number, len: number) =>
                Array.from(rom.slice(start, start + len), b => b.toString(16).padStart(2, '0')).join(' ');
              console.log(`[ROM-DBG] 0x05C8: ${dumpHex(0x05C8, 16)}`);
              console.log(`[ROM-DBG] 0x05D8: ${dumpHex(0x05D8, 16)}`);
              console.log(`[ROM-DBG] 0x05E8: ${dumpHex(0x05E8, 16)}`);
              console.log(`[ROM-DBG] IX=${s.cpu.ix.toString(16).padStart(4, '0')} DE=${(s.cpu.d * 256 + s.cpu.e).toString(16).padStart(4, '0')}`);
            }
          }
          if (ds.phase === 'PAUSE' && prevPhase === 'DATA') {
            const ix = s.cpu.ix;
            const de = s.cpu.d * 256 + s.cpu.e;
            const h = s.cpu.h;
            const carry = s.cpu.f & 1;
            const bytesLoaded = ix - _dbgDataStartIX;
            console.log(`[TAPE-DBG] BLOCK #${_dbgBlockNum} DATA->PAUSE: IX=${ix.toString(16).padStart(4, '0')} startIX=${_dbgDataStartIX.toString(16).padStart(4, '0')} DE=${de.toString(16).padStart(4, '0')} H(chk)=${h.toString(16).padStart(2, '0')} loaded=${bytesLoaded}`);
            console.log(`[TAPE-DBG] CPU: A=${s.cpu.a.toString(16).padStart(2, '0')} carry=${carry} B=${s.cpu.b.toString(16).padStart(2, '0')} C=${s.cpu.c.toString(16).padStart(2, '0')} F=${s.cpu.f.toString(16).padStart(2, '0')}`);
            // Compare expected vs actual stored data byte-by-byte
            const expectedHex = s.tape.debugRawBytes(ds.rawLen);
            const expArr = expectedHex.split(' ').map((x: string) => parseInt(x, 16));
            const startAddr = _dbgDataStartIX;
            // ROM loads: flag byte first (checked, not stored), then DE bytes stored at IX
            // So stored[0] = expected[1], stored[1] = expected[2], etc.
            const cmpLen = Math.min(bytesLoaded, expArr.length - 1);
            let firstBad = -1;
            let mismatches = 0;
            for (let i = 0; i < cmpLen; i++) {
              const actual = s.cpu.memory[startAddr + i];
              const expected = expArr[i + 1]; // +1 to skip flag byte
              if (actual !== expected) {
                mismatches++;
                if (firstBad === -1) firstBad = i;
                if (mismatches <= 5) {
                  console.log(`[TAPE-DBG] MISMATCH byte[${i}] @${(startAddr + i).toString(16)}: got=0x${actual.toString(16).padStart(2, '0')} want=0x${expected.toString(16).padStart(2, '0')}`);
                }
              }
            }
            console.log(`[TAPE-DBG] Compared ${cmpLen} bytes: ${mismatches} mismatches${firstBad >= 0 ? ` (first at byte ${firstBad})` : ''}`);
          }
        }

        // In DATA phase: log EVERY read for the first 200 reads (per-iteration timing)
        if (ds.phase === 'DATA' && _dbgReads <= 200 && _dbgDataLogs < _dbgMaxDataLogs) {
          const readDelta = _dbgLastReadT > 0 ? t - _dbgLastReadT : 0;
          const pc = s.cpu.pc;
          console.log(
            `[READ#${_dbgReads}] T=${t} d=${readDelta} ` +
            `PC=${pc.toString(16).padStart(4, '0')} ` +
            `ear=${ear} B=0x${s.cpu.b.toString(16).padStart(2, '0')} ` +
            `${isEdge ? 'EDGE' : ''}` +
            ` tape=${ds.tInPulse}/${ds.pulseLen}`
          );
          _dbgDataLogs++;
        }

        // After first 200 reads, log edges only
        if (ds.phase === 'DATA' && _dbgReads > 200 && isEdge && _dbgDataLogs < _dbgMaxDataLogs) {
          const edgeGap = _dbgLastEdgeT > 0 ? t - _dbgLastEdgeT : 0;
          console.log(
            `[TAPE-DBG] EDGE#${_dbgEdges} T=${t} edgeGap=${edgeGap} ` +
            `PC=${s.cpu.pc.toString(16).padStart(4, '0')} ear=${ear} ` +
            `B=0x${s.cpu.b.toString(16).padStart(2, '0')} ` +
            `byte[${ds.byteIdx}] bit=${ds.bitIdx} half=${ds.pulseHalf}`
          );
          _dbgDataLogs++;
        }

        if (isEdge) _dbgLastEdgeT = t;
        _dbgLastReadT = t;

        // In PILOT: count silently, summary every 500
        if (ds.phase === 'PILOT' && isEdge && _dbgEdges % 500 === 0) {
          console.log(`[TAPE-DBG] PILOT: ${_dbgEdges} edges, ~${ds.pulseLen}T/pulse`);
        }

        _dbgLastEar = ear;
      }

      // Loader detection: auto-start tape for custom loaders (Speedlock etc.)
      if (s.tape.loaded && !s.tape.finished) {
        if (!s.tape.playing || s.tape.paused) {
          // Tape not playing: detect edge-detection loops to auto-start.
          // Only when the next blocks are custom-loader blocks (not
          // ROM-loadable) and code is running from RAM (not ROM routines).
          if (!s.tape.hasRomBlock() && s.cpu.pc >= 0x4000 &&
              s.loaderDetector.onPortRead(s.cpu.tStates, s.cpu.b)) {
            s.tape.paused = false;
            // Always call startPlayback(): if the tape isn't playing yet,
            // this starts it; if already playing, it's a no-op.
            s.tape.startPlayback();
            s.loaderDetector.reset();
          }
        }
      }

      return s.ula.readPort((port >> 8) & 0xFF);
    }

    // AY register read: port 0xFFFD — 128K only
    if (is128kClass(s.model) && (port & 0xC002) === 0xC000) {
      return s.ay.readRegister(s.ay.selectedReg);
    }

    // FDC ports (A13=1, A12=0/1, A1=0): 0x2FFD status, 0x3FFD data
    // +3: routed to uPD765A. +2A: chip absent, bus returns 0xFF.
    // FDC operates normally in both FDC and BIOS modes — un-trapped ROM
    // code (DD_LOGIN, DD_INIT, etc.) needs valid FDC responses. The BIOS
    // traps intercept DD_ routines before they reach the FDC hardware.
    if (isPlus2AClass(s.model)) {
      if ((port & 0xF002) === 0x2000) {
        if (!isPlus3(s.model)) return 0xFF;
        return s.fdc.readStatus();
      }
      if ((port & 0xF002) === 0x3000) {
        if (!isPlus3(s.model)) return 0xFF;
        s.activity.fdcAccesses++;
        return s.fdc.readData();
      }
    }

    // AMX mouse PIO data ports (A7=0) and button port (0xDF)
    if (s.amxMouse.enabled) {
      if ((port & 0x80) === 0) {
        const lo = port & 0xE0;
        if (lo === 0x00) { s.activity.mouseReads++; return s.amxMouse.dirX & 1; }  // 0x1F: X direction
        if (lo === 0x20) { s.activity.mouseReads++; return s.amxMouse.dirY & 1; }  // 0x3F: Y direction
      }
      if ((port & 0xFF) === 0xDF) {
        s.activity.mouseReads++;
        return s.amxMouse.buttons;
      }
    }

    // Kempston mouse: port low byte = 0xDF, high byte selects X/Y/buttons
    if (s.kempstonMouse.enabled && (port & 0xFF) === 0xDF) {
      const hi = (port >> 8) & 0xFF;
      if (hi === 0xFB) { s.activity.mouseReads++; return s.kempstonMouse.x & 0xFF; }
      if (hi === 0xFF) { s.activity.mouseReads++; return s.kempstonMouse.y & 0xFF; }
      if (hi === 0xFA) { s.activity.mouseReads++; return s.kempstonMouse.buttons; }
    }

    // Kempston joystick: bits 5-7 of low byte all zero
    if ((port & 0x00E0) === 0) {
      s.activity.kempstonReads++;
      return s.joystick.state;
    }

    // Unattached port — return floating bus value (ULA VRAM data or 0xFF)
    return s.contention.floatingBusRead(s.cpu.tStates, s.memory.flat);
  };
}
