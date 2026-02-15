/**
 * ULA contention timing and floating bus emulation.
 *
 * On real hardware the ULA and CPU share the same memory bus. During the
 * 128 T-states of each visible scanline the ULA fetches pixel/attribute data,
 * stalling the CPU whenever it tries to access contended memory. The delay
 * depends on which sub-cycle of the ULA's 8-T-state fetch pattern the access
 * falls on.
 */

import { type SpectrumModel, is128kClass } from '@/spectrum.ts';
import type { SpectrumMemory } from '@/memory.ts';

/** Model-dependent ULA timing parameters. */
export interface MachineTiming {
  tStatesPerFrame: number;
  tStatesPerLine: number;
  /** Frame-relative T-state at which contention begins (first pixel line). */
  contentionStart: number;
}

export const TIMING_48K: MachineTiming = {
  tStatesPerFrame: 69888,   // 224 × 312
  tStatesPerLine: 224,
  contentionStart: 14335,
};

export const TIMING_128K: MachineTiming = {
  tStatesPerFrame: 70908,   // 228 × 311
  tStatesPerLine: 228,
  contentionStart: 14361,
};

/** ULA contention delay pattern — indexed by (T-state mod 8). */
const CONTENTION_PATTERN = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

export class Contention {
  readonly timing: MachineTiming;
  private model: SpectrumModel;
  private memory: SpectrumMemory;

  /** T-state counter at start of current frame (set by Spectrum each frame). */
  frameStartTStates = 0;

  constructor(model: SpectrumModel, memory: SpectrumMemory) {
    this.model = model;
    this.memory = memory;
    this.timing = is128kClass(model) ? TIMING_128K : TIMING_48K;
  }

  /** True if the given address is in ULA-contended memory. */
  isContended(addr: number): boolean {
    // 0x4000-0x7FFF is always contended (bank 5, the screen RAM)
    if (addr >= 0x4000 && addr < 0x8000) return true;
    // 128K: odd-numbered banks (1,3,5,7) paged at 0xC000 are contended
    if (is128kClass(this.model) && addr >= 0xC000) {
      return (this.memory.currentBank & 1) === 1;
    }
    return false;
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
    return CONTENTION_PATTERN[col & 7];
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
    const highContended = this.isContended(port);
    const isULA = (port & 1) === 0;

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
    const offset = frameTStates - t.contentionStart;
    if (offset < 0) return 0xFF;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= 192) return 0xFF;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0xFF;

    // Each character cell takes 4 T-states: pixel fetch, attr fetch
    const charCol = (col >> 2) & 0x1F;
    const phase = col & 3;

    if (phase < 2) {
      // Pixel byte — use the Spectrum's peculiar bitmap addressing
      const y = line;
      const bitmapAddr = 0x4000 |
        ((y & 0xC0) << 5) |
        ((y & 0x07) << 8) |
        ((y & 0x38) << 2);
      return mem[bitmapAddr + charCol];
    } else {
      // Attribute byte
      const attrAddr = 0x5800 + ((line >> 3) << 5) + charCol;
      return mem[attrAddr];
    }
  }
}
