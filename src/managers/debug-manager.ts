/**
 * Debug Manager - handles debugging operations, tracing, and breakpoints.
 *
 * Responsibilities:
 * - Step into/over/out execution
 * - Breakpoint management
 * - Execution tracing (full/portio modes)
 * - CPU state inspection and disassembly
 */

import type { Spectrum } from '@/spectrum.ts';
import { Z80 } from '@/cores/Z80.ts';
import { disasmOne } from '@/debug/z80-disasm.ts';
import { hex8, hex16 } from '@/utils/hex.ts';

export type TraceMode = 'full' | 'portio';

export class DebugManager {
  /** Address of a temporary "run to" breakpoint to clean up on hit */
  private pendingRunTo = -1;

  /**
   * Get the pending "run to" breakpoint address.
   */
  getPendingRunTo(): number {
    return this.pendingRunTo;
  }

  /**
   * Clear the pending "run to" breakpoint.
   */
  clearPendingRunTo(): void {
    this.pendingRunTo = -1;
  }

  /**
   * Execute a single instruction.
   */
  stepInto(spectrum: Spectrum, onUpdate: () => void): void {
    spectrum.cpu.step();
    onUpdate();
  }

  /**
   * Step over CALL/RST instructions and block repeats.
   * Executes until the next instruction at the same stack level.
   */
  stepOver(spectrum: Spectrum, onUpdate: () => void): void {
    const cpu = spectrum.cpu;
    const op = cpu.memory[cpu.pc];

    // CALL nn / CALL cc,nn / RST: step until SP returns to current level
    const isCall = op === 0xCD ||                                           // CALL nn
      (op & 0xC7) === 0xC4 ||                                              // CALL cc,nn
      (op & 0xC7) === 0xC7 ||                                              // RST
      (op === 0xED && ((cpu.memory[(cpu.pc + 1) & 0xFFFF] & 0xC7) === 0xB0)); // block repeat (LDIR etc)

    // Conditional jumps: run to the next instruction (skip if taken)
    const isCondJump =
      op === 0x10 ||                  // DJNZ e        (2 bytes)
      (op & 0xE7) === 0x20 ||        // JR cc,e        (2 bytes: 20/28/30/38)
      (op & 0xC7) === 0xC2;          // JP cc,nn       (3 bytes: C2/CA/D2/DA/E2/EA/F2/FA)

    if (isCondJump) {
      const instrLen = (op & 0xC7) === 0xC2 ? 3 : 2;
      const nextPC = (cpu.pc + instrLen) & 0xFFFF;
      const limit = cpu.tStates + 5_000_000;
      cpu.step();
      while (cpu.pc !== nextPC && cpu.tStates < limit) {
        cpu.step();
      }
    } else if (!isCall) {
      cpu.step();
    } else {
      const targetSP = cpu.sp;
      const limit = cpu.tStates + 5_000_000; // safety: max ~1.4 seconds
      cpu.step(); // execute the CALL/RST
      while (cpu.sp < targetSP && cpu.tStates < limit) {
        cpu.step();
      }
    }

    onUpdate();
  }

  /**
   * Step out of current function (run until RET brings SP back).
   */
  stepOut(spectrum: Spectrum, onUpdate: () => void): void {
    const cpu = spectrum.cpu;
    const targetSP = cpu.sp + 2; // SP after RET pops return address
    const limit = cpu.tStates + 10_000_000; // safety: max ~2.8 seconds

    // Run until we execute a RET that brings SP back to or above target
    while (cpu.sp < targetSP && cpu.tStates < limit) {
      cpu.step();
    }

    onUpdate();
  }

  /**
   * Run exactly one frame (to the next frame boundary) and update the display.
   */
  stepFrame(spectrum: Spectrum, onUpdate: () => void): void {
    spectrum.tick();
    if (spectrum.display) spectrum.display.updateTexture(spectrum.ula.pixels);
    onUpdate();
  }

  /**
   * Toggle breakpoint at address.
   */
  toggleBreakpoint(
    spectrum: Spectrum,
    addr: number,
    onStatus: (msg: string) => void,
    onUpdate: () => void
  ): void {
    if (spectrum.breakpoints.has(addr)) {
      spectrum.breakpoints.delete(addr);
      onStatus(`Breakpoint removed at ${hex16(addr)}`);
    } else {
      spectrum.breakpoints.add(addr);
      onStatus(`Breakpoint set at ${hex16(addr)}`);
    }
    onUpdate();
  }

  /**
   * Run to address (set temporary breakpoint).
   */
  runTo(
    spectrum: Spectrum,
    addr: number,
    emulationPaused: boolean,
    onResume: () => void
  ): void {
    const wasSet = spectrum.breakpoints.has(addr);
    spectrum.breakpoints.add(addr);

    if (!wasSet) {
      this.pendingRunTo = addr;
    }

    if (emulationPaused) {
      spectrum.start();
      onResume();
    }
  }

  /**
   * Start execution tracing.
   */
  startTrace(spectrum: Spectrum, mode: TraceMode = 'full', onStart: () => void): void {
    spectrum.startTrace(mode);
    onStart();
  }

  /**
   * Stop execution tracing and return trace text.
   */
  stopTrace(spectrum: Spectrum, onStop: (text: string, lineCount: number) => void): void {
    const text = spectrum.stopTrace();
    const lines = text.split('\n').length;
    onStop(text, lines);
  }

  /**
   * Copy CPU state and disassembly to clipboard.
   */
  copyCpuState(spectrum: Spectrum, onStatus: (msg: string) => void): void {
    const cpu = spectrum.cpu;
    const f = cpu.f;
    const flags = [
      `Sign=${(f & Z80.FLAG_S) ? 1 : 0}`,
      `Zero=${(f & Z80.FLAG_Z) ? 1 : 0}`,
      `Half=${(f & Z80.FLAG_H) ? 1 : 0}`,
      `P/V=${(f & Z80.FLAG_PV) ? 1 : 0}`,
      `Sub=${(f & Z80.FLAG_N) ? 1 : 0}`,
      `Carry=${(f & Z80.FLAG_C) ? 1 : 0}`,
    ].join('  ');

    const iff = cpu.iff1 ? 'EI' : 'DI';
    const halt = cpu.halted ? ' HALT' : '';

    const lines = [
      `AF  ${hex16(cpu.af)}  AF' ${hex16((cpu.a_ << 8) | cpu.f_)}`,
      `BC  ${hex16(cpu.bc)}  BC' ${hex16((cpu.b_ << 8) | cpu.c_)}`,
      `DE  ${hex16(cpu.de)}  DE' ${hex16((cpu.d_ << 8) | cpu.e_)}`,
      `HL  ${hex16(cpu.hl)}  HL' ${hex16((cpu.h_ << 8) | cpu.l_)}`,
      `IX  ${hex16(cpu.ix)}  IY  ${hex16(cpu.iy)}`,
      `PC  ${hex16(cpu.pc)}  SP  ${hex16(cpu.sp)}`,
      `I   ${hex8(cpu.i)}    R   ${hex8(cpu.r)}  IM ${cpu.im}  ${iff}${halt}`,
      `Flags: ${flags}`,
      '',
      'Disassembly:',
    ];

    // Disassemble 16 instructions around PC
    let addr = cpu.pc;
    for (let i = 0; i < 16; i++) {
      const dl = disasmOne(cpu.memory, addr);
      const bytesStr = Array.from(cpu.memory.slice(dl.addr, dl.addr + dl.length))
        .map(b => hex8(b))
        .join(' ')
        .padEnd(12, ' ');
      const mnem = dl.text.padEnd(24, ' ');
      lines.push(`${dl.addr === cpu.pc ? '>' : ' '} ${hex16(addr)}  ${bytesStr}  ${mnem}`);
      addr = (addr + dl.length) & 0xFFFF;
    }

    navigator.clipboard.writeText(lines.join('\n'));
    onStatus('CPU state + disassembly copied to clipboard');
  }

}
