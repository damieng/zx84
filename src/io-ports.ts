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

  s.cpu.portInHandler = (port: number): number => {
    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      s.activity.ulaReads++;

      // Advance tape to current T-state BEFORE reading the EAR bit.
      // This ensures the ROM's IN A,($FE) sees the correct tape signal
      // at the exact T-state of the read, not one instruction behind.
      s.advanceTapeTo();
      if (s.ula.tapeActive) s.activity.earReads++;

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
