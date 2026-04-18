/**
 * MachineVariant factory for 128K/+2 (Ferranti ULA with AY and banking).
 */

import type { SpectrumModel } from '@/models.ts';
import { TIMING_128K } from '@/contention.ts';
import type { MachineVariant } from './machine-variant.ts';

/** Ferranti ULA contention pattern: 6,5,4,3,2,1,0,0 */
const CONTENTION_FERRANTI = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

export function createFerranti128K(model: '128k' | '+2'): MachineVariant {
  return Object.freeze({
    model: model as SpectrumModel,
    timing: TIMING_128K,

    cellRenderOffset: 0 as const,
    vramFlushEnd: 0x5800,

    contentionPattern: CONTENTION_FERRANTI,
    hasIOContention: true,

    isContended(_addr: number, bank: number): boolean {
      // Odd banks (1,3,5,7) share the upper RAM chip with the ULA.
      // bank = -1 means ROM (uncontended).
      return bank >= 0 && (bank & 1) === 1;
    },

    hasAY: true,
    hasBanking: true,
    hasFDC: false,
    hasSpecialPaging: false,
    romPageCount: 2,
    is48K: false,

    // 128K/+2 loose decode: (port & 0x8002) === 0
    decodes7FFD(port: number): boolean { return (port & 0x8002) === 0; },
    decodes1FFD(_port: number): boolean { return false; },
    decodesFDCData(_port: number): boolean { return false; },
    decodesFDCStatus(_port: number): boolean { return false; },
  });
}
