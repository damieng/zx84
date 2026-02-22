/**
 * MachineVariant — strategy interface for model-specific behavior.
 *
 * Each Spectrum hardware family (48K Ferranti, 128K/+2 Ferranti,
 * +2A/+3 Amstrad gate array) gets a frozen implementation.
 * The Spectrum orchestrator delegates model-dependent decisions here
 * instead of scattering is128kClass/isPlus2AClass/isPlus3 checks.
 */

import type { SpectrumModel } from '@/models.ts';
import type { MachineTiming } from '@/contention.ts';

export interface MachineVariant {
  readonly model: SpectrumModel;
  readonly timing: MachineTiming;

  // ── Display ──────────────────────────────────────────────────────────

  /** Per-cell render offset: +1 on 48K (render as beam enters cell),
   *  0 on all others (render after beam fully passes cell). */
  readonly cellRenderOffset: 0 | 1;

  /** VRAM flush boundary for write8: 0x5B00 (48K, flush bitmap+attr)
   *  or 0x5800 (non-48K, flush bitmap only). */
  readonly vramFlushEnd: number;

  // ── Contention ───────────────────────────────────────────────────────

  /** ULA contention delay pattern indexed by (T-state mod 8). */
  readonly contentionPattern: Uint8Array;

  /** Ferranti: true (four-case I/O contention). Amstrad: false. */
  readonly hasIOContention: boolean;

  /** True if the given address is in ULA-contended memory.
   *  `currentBank` is the RAM bank paged at 0xC000 (from memory). */
  isContended(addr: number, currentBank: number): boolean;

  // ── Capabilities ─────────────────────────────────────────────────────

  readonly hasAY: boolean;
  readonly hasBanking: boolean;
  readonly hasFDC: boolean;
  readonly hasSpecialPaging: boolean;
  readonly romPageCount: number;    // 1, 2, or 4
  readonly is48K: boolean;

  // ── Port decode ──────────────────────────────────────────────────────

  /** True if this port address decodes as 0x7FFD (bank switch). */
  decodes7FFD(port: number): boolean;

  /** True if this port address decodes as 0x1FFD (+2A special paging). */
  decodes1FFD(port: number): boolean;

  /** True if this port address decodes as FDC data (0x3FFD). */
  decodesFDCData(port: number): boolean;

  /** True if this port address decodes as FDC status (0x2FFD). */
  decodesFDCStatus(port: number): boolean;
}
