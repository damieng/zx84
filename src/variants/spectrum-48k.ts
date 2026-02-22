/**
 * MachineVariant for the original 48K Spectrum (Ferranti ULA, no AY/banking).
 */

import { TIMING_48K } from '@/contention.ts';
import type { MachineVariant } from './machine-variant.ts';

/** Ferranti ULA contention pattern: 6,5,4,3,2,1,0,0 */
const CONTENTION_FERRANTI = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

export const spectrum48K: MachineVariant = Object.freeze({
  model: '48k' as const,
  timing: TIMING_48K,

  cellRenderOffset: 1,
  vramFlushEnd: 0x5B00,

  contentionPattern: CONTENTION_FERRANTI,
  hasIOContention: true,

  isContended(addr: number, _currentBank: number): boolean {
    // 48K: only 0x4000-0x7FFF is contended (no banking)
    return addr >= 0x4000 && addr < 0x8000;
  },

  hasAY: false,
  hasBanking: false,
  hasFDC: false,
  hasSpecialPaging: false,
  romPageCount: 1,
  is48K: true,

  decodes7FFD(_port: number): boolean { return false; },
  decodes1FFD(_port: number): boolean { return false; },
  decodesFDCData(_port: number): boolean { return false; },
  decodesFDCStatus(_port: number): boolean { return false; },
});
