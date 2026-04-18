/**
 * MachineVariant factory for +2A/+3 (Amstrad gate array).
 */

import type { SpectrumModel } from '@/models.ts';
import { TIMING_PLUS2A } from '@/contention.ts';
import type { MachineVariant } from './machine-variant.ts';

/** Amstrad gate array contention pattern: 1,0,7,6,5,4,3,2 */
const CONTENTION_AMSTRAD = new Uint8Array([1, 0, 7, 6, 5, 4, 3, 2]);

export function createAmstrad(model: '+2a' | '+3'): MachineVariant {
  const hasFDC = model === '+3';

  return Object.freeze({
    model: model as SpectrumModel,
    timing: TIMING_PLUS2A,

    cellRenderOffset: 0 as const,
    vramFlushEnd: 0x5800,

    contentionPattern: CONTENTION_AMSTRAD,
    hasIOContention: false,

    isContended(_addr: number, bank: number): boolean {
      // Banks 4-7 are on the upper RAM chip shared with the gate array.
      // bank = -1 means ROM (uncontended). Address range is irrelevant —
      // only the physical RAM chip matters.
      return bank >= 4;
    },

    hasAY: true,
    hasBanking: true,
    hasFDC,
    hasSpecialPaging: true,
    romPageCount: 4,
    is48K: false,

    // +2A strict decode: (port & 0xC002) === 0x4000
    decodes7FFD(port: number): boolean { return (port & 0xC002) === 0x4000; },
    // +2A: (port & 0xF002) === 0x1000
    decodes1FFD(port: number): boolean { return (port & 0xF002) === 0x1000; },
    // FDC data: (port & 0xF002) === 0x3000
    decodesFDCData(port: number): boolean { return hasFDC && (port & 0xF002) === 0x3000; },
    // FDC status: (port & 0xF002) === 0x2000
    decodesFDCStatus(port: number): boolean { return (port & 0xF002) === 0x2000; },
  });
}
