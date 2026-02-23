/**
 * Port I/O dispatch and memory hooks.
 *
 * Wires the Z80 CPU's port-in/port-out handlers and memory read/write hooks
 * to the appropriate Spectrum subsystems (ULA, AY, memory banking, FDC,
 * Kempston joystick, contention, and floating bus).
 */

import type { Spectrum } from '@/spectrum.ts';

/**
 * Override Z80 read8/write8 to apply per-access ULA contention and
 * silently discard writes to ROM (0x0000-0x3FFF).
 */
export function installMemoryHooks(s: Spectrum): void {
  const memory = s.memory;
  const contention = s.contention;
  const v = s.variant;

  s.cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    if (contention.isContended(addr)) {
      s.cpu.tStates += contention.contentionDelay(s.cpu.tStates);
    }
    return s.cpu.memory[addr];
  };

  // Internal bus contention (no MREQ). On Ferranti ULA (48K/128K/+2),
  // internal processing cycles get contended when the address is in
  // contended memory. On Amstrad gate array (+2A/+3), MREQ must be
  // asserted for contention, so internal cycles are never contended.
  //
  // Only 0x4000-0x7FFF is checked here. The Ferranti ULA directly snoops
  // A14/A15 to contend that range. On 128K, the 0xC000+ contention is a
  // side-effect of the banking circuit (odd banks share IC15 with the
  // screen bank), but that circuit is gated by MREQ without RFSH — so
  // internal cycles (including M1 refresh putting IR on the bus) don't
  // trigger it. This matches observed behaviour: programs using I=0xFE
  // with an odd bank at 0xC000 (very common IM 2 setup) work correctly
  // without the extra 6T-per-M1 penalty that full isContended() would add.
  s.cpu.contend = v.hasIOContention ? (addr: number): void => {
    if (addr >= 0x4000 && addr < 0x8000) {
      s.cpu.tStates += contention.contentionDelay(s.cpu.tStates);
    }
  } : () => {};

  // 48K: flush beam on all VRAM writes (bitmap + attr) for correct multicolor.
  // Non-48K: flush only on bitmap writes; attr writes handled by per-instruction render.
  const vramFlushEnd = v.vramFlushEnd;

  s.cpu.write8 = (addr: number, val: number): void => {
    addr &= 0xFFFF;
    if (contention.isContended(addr)) {
      s.cpu.tStates += contention.contentionDelay(s.cpu.tStates);
    }
    if (addr < 0x4000) {
      if (s.multiface.pagedIn) {
        if (addr < 0x2000) return; // MF ROM — discard
        // 0x2000-0x3FFF: MF RAM — allow through
      } else if (!memory.specialPaging) {
        return; // Normal ROM — discard
      }
    }
    // Flush beam before VRAM writes so completed scanlines see old data.
    // 48K: flush on ALL VRAM writes (bitmap + attributes).  Multicolor demos
    //   like Shock write attributes at/behind the beam; the flush ensures cells
    //   already passed are rendered with the old attribute value.
    // Non-48K: flush only on bitmap writes (0x4000-0x57FF).  Engines like
    //   Bifrost write attributes ahead of the beam; flushing would capture
    //   stale attrs before the engine finishes writing.
    if (addr >= 0x4000 && addr < vramFlushEnd) {
      s.flushBeam();
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
  const v = s.variant;

  s.cpu.portOutHandler = (port: number, val: number) => {
    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      const newBeeperBit = (val >> 4) & 1;
      if (newBeeperBit !== s.mixer.prevBeeperBit) {
        s.activity.beeperToggled = true;
        s.mixer.prevBeeperBit = newBeeperBit;
      }
      s.flushBeam();
      s.ula.writePort(val);
    }

    // 128K bank switching: port 0x7FFD
    if (v.hasBanking) {
      if (v.decodes7FFD(port)) {
        if (s.multiface.pagedIn) {
          // Sync live MF RAM before bank switch — bankSwitch() may
          // overwrite slot 0 (ROM change), clobbering flat[0x2000-0x3FFF]
          s.multiface.mfRam.set(s.cpu.memory.subarray(0x2000, 0x4000));
        }
        s.memory.bankSwitch(val);
        s.cpu.memory = s.memory.flat;
        if (s.multiface.pagedIn) {
          s.cpu.memory.set(s.multiface.mfRom, 0);
          s.cpu.memory.set(s.multiface.mfRam, 0x2000);
        }
      }

      // +2A: port 0x1FFD
      if (v.decodes1FFD(port)) {
        if (s.multiface.pagedIn) {
          s.multiface.mfRam.set(s.cpu.memory.subarray(0x2000, 0x4000));
        }
        s.memory.bankSwitch1FFD(val, s.multiface.pagedIn);
        if (v.hasFDC) s.fdc.motorOn = (val & 0x08) !== 0;
        s.cpu.memory = s.memory.flat;
        if (s.multiface.pagedIn) {
          s.cpu.memory.set(s.multiface.mfRom, 0);
          s.cpu.memory.set(s.multiface.mfRam, 0x2000);
        }
      }

      // FDC data write: port 0x3FFD
      if (v.decodesFDCData(port)) {
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
    if (v.hasAY) {
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

    // General port watchpoint (covers all ports: 7FFD, 1FFD, 3FFD, etc.)
    if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
      s.portWatchHit = { port: port & 0xFFFF, value: val, dir: 'out' };
    }

  };

  s.cpu.portInHandler = (port: number): number => {
    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      s.activity.ulaReads++;

      // Advance tape to current T-state BEFORE reading the EAR bit.
      // This ensures the ROM's IN A,($FE) sees the correct tape signal
      // at the exact T-state of the read, not one instruction behind.
      s.advanceTapeTo();
      // Count as an EAR read only when no keyboard row is selected (high
      // byte = 0xFF).  Tape loaders use IN A,(0xFE) with A=0xFF to sample
      // EAR; keyboard scans select specific half-rows (0xFE, 0xFD, etc.).
      if (s.ula.tapeActive && (port >> 8) === 0xFF) s.activity.earReads++;

      // Loader detection: auto-start tape when code reads EAR in a tight loop.
      // Works for both ROM loaders (LD-BYTES reading EAR) and custom loaders
      // (Speedlock etc.). The LoaderDetector filters out normal keyboard polling
      // by requiring 10+ rapid consecutive reads with B delta ±1/0.
      if (s.tape.loaded && !s.tape.finished) {
        if (!s.tape.playing || s.tape.paused) {
          if (s.loaderDetector.onPortRead(s.cpu.tStates, s.cpu.b)) {
            s.tape.paused = false;
            s.tape.startPlayback();
            s.loaderDetector.reset();
          }
        }
      }

      return s.ula.readPort((port >> 8) & 0xFF);
    }

    // AY register read: port 0xFFFD — 128K only
    if (v.hasAY && (port & 0xC002) === 0xC000) {
      return s.ay.readRegister(s.ay.selectedReg);
    }

    // FDC ports (A13=1, A12=0/1, A1=0): 0x2FFD status, 0x3FFD data
    // +3: routed to uPD765A. +2A: chip absent, bus returns 0xFF.
    // FDC operates normally in both FDC and BIOS modes — un-trapped ROM
    // code (DD_LOGIN, DD_INIT, etc.) needs valid FDC responses. The BIOS
    // traps intercept DD_ routines before they reach the FDC hardware.
    if (v.hasSpecialPaging) {
      if (v.decodesFDCStatus(port)) {
        if (!v.hasFDC) return 0xFF;
        return s.fdc.readStatus();
      }
      if (v.decodesFDCData(port)) {
        if (!v.hasFDC) return 0xFF;
        s.activity.fdcAccesses++;
        const fdcByte = s.fdc.readData();
        if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
          s.portWatchHit = { port: port & 0xFFFF, value: fdcByte, dir: 'in' };
        }
        return fdcByte;  // early return — watchpoint already handled above
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

    // MF3 port latches: the MF3 hardware snoops writes to 0x7FFD/0x1FFD
    // and makes the latched values readable at ports 0x7F3F and 0x1F3F.
    // These are always active when the MF3 is present, regardless of
    // paging state, and must be checked before paging port decode.
    if (s.multiface.enabled && s.multiface.variant === 'MF3'
        && (port & 0xFF) === 0x3F) {
      const hi = (port >> 8) & 0xFF;
      if (hi === 0x7F) return s.memory.port7FFD;
      if (hi === 0x1F) return s.memory.port1FFD;
    }

    // Multiface port handling (IN-triggered paging)
    // Must come before Kempston since MF1's page-out port (0x1F) overlaps
    if (s.multiface.enabled && s.multiface.romLoaded) {
      const mfPort = s.multiface.matchPort(port);
      // Only intercept page-in when paged out, page-out when paged in.
      // When paging state already matches, the IN falls through to normal
      // port handling (the MF hardware is a flip-flop, not edge-triggered).
      if (mfPort === 'in' && !s.multiface.pagedIn) {
        s.multiface.pageIn(s.cpu.memory, s.memory.slot0Bank);
        return 0xFF;
      }
      if (mfPort === 'out' && s.multiface.pagedIn) {
        s.multiface.pageOut(s.cpu.memory);
        // After pageOut, flat[0..16383] has savedSlot0 data.
        // Slots 1-3 are already correct — bankSwitch handlers updated
        // them in real-time during MF operation. Only slot 0 needs fixing.
        const currentSlot0 = s.memory.slot0Bank;
        const saved0Bank = s.multiface.savedSlot0Bank;
        if (saved0Bank >= 0 && saved0Bank === currentSlot0) {
          // savedSlot0 is valid RAM bank data for current banking —
          // sync it to ramBanks so future bank switches see it.
          s.memory.syncFlatToBank(saved0Bank, 0);
        }
        // Fix slot 0 for the current banking state
        if (currentSlot0 < 0) {
          // Normal paging: slot 0 should have ROM
          s.cpu.memory.set(s.memory.romPages[s.memory.currentROM], 0);
        } else if (saved0Bank !== currentSlot0) {
          // Special paging with different bank — load correct one
          s.cpu.memory.set(s.memory.getRamBank(currentSlot0), 0);
        }
        // (else: savedSlot0 data is already correct for this bank)
        s.cpu.memory = s.memory.flat;
        // MF1 shares 0x1F with Kempston — return joystick state
        if (s.multiface.variant === 'MF1') return s.joystick.state;
        return 0xFF;
      }
    }

    // Kempston joystick: bits 5-7 of low byte all zero
    if ((port & 0x00E0) === 0) {
      s.activity.kempstonReads++;
      return s.joystick.state;
    }

    // Unattached port — return floating bus value (ULA VRAM data or 0xFF)
    const floatVal = s.contention.floatingBusRead(s.cpu.tStates, s.memory.flat);
    // General port watchpoint for IN (FDC data port handled above with early return)
    if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
      s.portWatchHit = { port: port & 0xFFFF, value: floatVal, dir: 'in' };
    }
    return floatVal;
  };
}
