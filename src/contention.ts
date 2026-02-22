/**
 * ULA contention timing and floating bus emulation.
 *
 * On real hardware the ULA and CPU share the same memory bus. During the
 * 128 T-states of each visible scanline the ULA fetches pixel/attribute data,
 * stalling the CPU whenever it tries to access contended memory. The delay
 * depends on which sub-cycle of the ULA's 8-T-state fetch pattern the access
 * falls on.
 */

import type { MachineVariant } from '@/variants/machine-variant.ts';
import type { SpectrumMemory } from '@/memory.ts';
import { vramBitmapAddr, vramAttrAddr } from '@/cores/ula.ts';

/** Model-dependent ULA timing parameters. */
export interface MachineTiming {
  cpuClock: number;
  tStatesPerFrame: number;
  tStatesPerLine: number;
  /** Frame-relative T-state at which contention begins (first ULA fetch). */
  contentionStart: number;
  /** Frame-relative T-state of the first display pixel output.
   *  = VBlank lines × tStatesPerLine + top border lines × tStatesPerLine.
   *  May differ from contentionStart because the ULA fetch starts before
   *  pixel output on some models. */
  displayOrigin: number;
  /** How many T-states INT is held LOW at frame start. */
  intLength: number;
  /** Floating bus read offset: −1 for 48K, +1 for 128K+. */
  floatingBusAdjust: number;
}

export const TIMING_48K: MachineTiming = {
  cpuClock: 3500000,
  tStatesPerFrame: 69888,   // 224 × 312
  tStatesPerLine: 224,
  contentionStart: 14335,
  displayOrigin: 14336,     // 64 lines × 224 (8 VBlank + 56 border)
  intLength: 32,
  floatingBusAdjust: -1,
};

export const TIMING_128K: MachineTiming = {
  cpuClock: 3546900,
  tStatesPerFrame: 70908,   // 228 × 311
  tStatesPerLine: 228,
  contentionStart: 14361,
  displayOrigin: 14362,     // contentionStart + 1T Ferranti pipeline delay
  intLength: 36,
  floatingBusAdjust: 1,
};

export const TIMING_PLUS2A: MachineTiming = {
  cpuClock: 3546900,
  tStatesPerFrame: 70908,   // 228 × 311
  tStatesPerLine: 228,
  contentionStart: 14361,   // Amstrad ASIC ULA fetch starts here
  displayOrigin: 14364,     // first pixel output (contentionStart + 3T pipeline)
  intLength: 32,
  floatingBusAdjust: 1,
};

export class Contention {
  readonly timing: MachineTiming;
  private variant: MachineVariant;
  private memory: SpectrumMemory;

  /** T-state counter at start of current frame (set by Spectrum each frame). */
  frameStartTStates = 0;

  constructor(variant: MachineVariant, memory: SpectrumMemory) {
    this.variant = variant;
    this.memory = memory;
    this.timing = variant.timing;
  }

  /** True if the given address is in ULA-contended memory. */
  isContended(addr: number): boolean {
    return this.variant.isContended(addr, this.memory.currentBank);
  }

  /** Returns the contention delay (extra T-states) for the current beam position. */
  contentionDelay(cpuTStates: number): number {
    const t = this.timing;
    const frameTStates = cpuTStates - this.frameStartTStates;
    const offset = frameTStates - t.contentionStart;
    if (offset < 0) return 0;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= 192) return 0;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0;
    return this.variant.contentionPattern[col & 7];
  }

  /**
   * Apply I/O contention for port access.
   * On real hardware, the ULA applies contention during I/O cycles based on
   * whether the port address high byte is contended and whether it's a ULA port.
   *
   * Patterns (C = contention delay, N = none, number = sub-cycle T-states):
   *   Contended + ULA (A0=0): C:1, C:3  —  2 contention checks
   *   Contended + non-ULA:    C:1, C:1, C:1, C:1  —  4 checks
   *   Non-contended + ULA:    N:1, C:3  —  1 check
   *   Non-contended + non-ULA: N:4  —  no contention
   *
   * The intermediate +1/-1 advances position tStates correctly for each check
   * without adding extra time (sub-cycle T-states are in the base instruction timing).
   */
  applyIOContention(port: number, cpu: { tStates: number }): void {
    if (!this.variant.hasIOContention) {
      // Amstrad gate array (+2A/+3): no I/O contention.
      // The gate array only applies contention when MREQ is active,
      // and MREQ is not asserted during I/O operations (IORQ instead).
      return;
    }

    // 48K / 128K / +2 (Ferranti ULA): four-case I/O contention
    const isULA = (port & 1) === 0;
    const highContended = this.isContended(port);

    if (highContended && isULA) {
      // C:1, C:3
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates += 1;
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates -= 1;
    } else if (highContended) {
      // C:1, C:1, C:1, C:1
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates += 1;
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates += 1;
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates += 1;
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates -= 3;
    } else if (isULA) {
      // N:1, C:3
      cpu.tStates += 1;
      cpu.tStates += this.contentionDelay(cpu.tStates);
      cpu.tStates -= 1;
    }
  }

  /**
   * Floating bus read: returns whatever the ULA is currently fetching from VRAM.
   * During active display, this is a pixel byte or attribute byte.
   * Outside active display, returns 0xFF.
   */
  floatingBusRead(cpuTStates: number, mem: Uint8Array): number {
    const t = this.timing;
    const frameTStates = cpuTStates - this.frameStartTStates;
    const offset = frameTStates - t.contentionStart + t.floatingBusAdjust;
    if (offset < 0) return 0xFF;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= 192) return 0xFF;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0xFF;

    // Each character cell takes 4 T-states: pixel fetch, attr fetch
    const charCol = (col >> 2) & 0x1F;
    const phase = col & 3;

    if (phase < 2) {
      return mem[vramBitmapAddr(line) + charCol];  // Pixel byte
    } else {
      return mem[vramAttrAddr(line, charCol)];      // Attribute byte
    }
  }
}
