/**
 * ZX Spectrum memory subsystem with 128K bank switching.
 *
 * Flat 64KB array is shared with the Z80 core.
 * 128K model: 8x16KB RAM banks + 2x16KB ROM pages.
 * +2A model: 8x16KB RAM banks + 4x16KB ROM pages + port 0x1FFD special paging.
 * Bank switching via port 0x7FFD swaps data in/out of the flat array.
 */

import type { SpectrumModel } from '@/spectrum.ts';
import { isPlus2AClass } from '@/spectrum.ts';

/** Special paging all-RAM bank configurations (indexed by mode 0-3). */
const SPECIAL_MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [4, 5, 6, 3],
  [4, 7, 6, 3],
];

export class SpectrumMemory {
  /** Flat 64KB address space shared with Z80 */
  flat: Uint8Array;

  /** 8 x 16KB RAM banks (128K total) */
  ramBanks: Uint8Array[];

  /** ROM pages: 2 for 48K/128K/+2, 4 for +2A */
  romPages: Uint8Array[];

  /** Current port 0x7FFD value */
  port7FFD = 0;

  /** Current port 0x1FFD value (+2A only) */
  port1FFD = 0;

  /** Whether paging is locked (bit 5 of 0x7FFD) */
  pagingLocked = false;

  /** Which RAM bank is paged in at 0xC000 */
  currentBank = 0;

  /** Which ROM page is active */
  currentROM = 0;

  /** True = 128K-class mode, false = 48K mode */
  is128K: boolean;

  /** True when +2A special all-RAM paging is active */
  specialPaging = false;

  constructor(model: SpectrumModel) {
    this.is128K = model !== '48k';
    this.flat = new Uint8Array(65536);

    // Create 8 RAM banks
    this.ramBanks = [];
    for (let i = 0; i < 8; i++) {
      this.ramBanks.push(new Uint8Array(16384));
    }

    // Create ROM pages: 4 for +2A, 2 otherwise
    const romCount = isPlus2AClass(model) ? 4 : 2;
    this.romPages = [];
    for (let i = 0; i < romCount; i++) {
      this.romPages.push(new Uint8Array(16384));
    }
  }

  reset(): void {
    this.flat.fill(0);
    for (const bank of this.ramBanks) bank.fill(0);
    this.port7FFD = 0;
    this.port1FFD = 0;
    this.pagingLocked = false;
    this.currentBank = 0;
    this.currentROM = 0;
    this.specialPaging = false;
    this.applyBanking();
  }

  /**
   * Load ROM data. 16KB = 48K ROM only. 32KB = 2 pages. 64KB = 4 pages (+2A).
   */
  loadROM(data: Uint8Array): void {
    if (data.length >= 65536 && this.romPages.length === 4) {
      // 64KB ROM: 4 × 16KB pages for +2A
      for (let i = 0; i < 4; i++) {
        this.romPages[i].set(data.subarray(i * 16384, (i + 1) * 16384));
      }
    } else if (data.length >= 32768 && this.is128K) {
      // 32KB ROM: first 16KB = 128K editor (page 0), second 16KB = 48K BASIC (page 1)
      this.romPages[0].set(data.subarray(0, 16384));
      this.romPages[1].set(data.subarray(16384, 32768));
    } else if (data.length >= 16384) {
      // 16KB ROM: 48K BASIC only
      this.romPages[1].set(data.subarray(0, 16384));
      if (!this.is128K) {
        this.romPages[0].set(data.subarray(0, 16384));
      }
    }
    this.applyBanking();
  }

  /**
   * Write to port 0x7FFD (128K bank switching).
   * Bits 0-2: RAM bank at 0xC000
   * Bit 3: screen select (0=bank5, 1=bank7) — display only
   * Bit 4: ROM select (0=128K editor, 1=48K BASIC)
   * Bit 5: lock paging
   */
  writePort7FFD(val: number): void {
    if (!this.is128K || this.pagingLocked) return;

    this.port7FFD = val;
    this.currentBank = val & 0x07;

    // +2A with 4 ROM pages: combine bits from 0x7FFD and 0x1FFD
    if (this.romPages.length === 4) {
      this.currentROM = (((this.port1FFD >> 2) & 1) << 1) | ((val >> 4) & 1);
    } else {
      this.currentROM = (val >> 4) & 1;
    }

    if (val & 0x20) {
      this.pagingLocked = true;
    }

    this.applyBanking();
  }

  /**
   * Write to port 0x1FFD (+2A special paging port).
   * Bit 0: special paging enable (1 = all-RAM mode)
   * Bits 1-2: special paging mode (0-3)
   * Bit 2: also contributes to ROM page select (high bit)
   */
  writePort1FFD(val: number): void {
    if (!this.is128K || this.pagingLocked) return;

    this.port1FFD = val;
    this.specialPaging = (val & 1) !== 0;

    // Recompute ROM page from combined ports
    if (this.romPages.length === 4) {
      this.currentROM = (((val >> 2) & 1) << 1) | ((this.port7FFD >> 4) & 1);
    }

    this.applyBanking();
  }

  /**
   * Sync the flat array from/to the backing bank stores.
   * Called after any bank switch.
   */
  applyBanking(): void {
    if (this.specialPaging) {
      // +2A special all-RAM modes — no ROM mapped
      const mode = (this.port1FFD >> 1) & 3;
      const banks = SPECIAL_MODES[mode];
      this.flat.set(this.ramBanks[banks[0]], 0x0000);
      this.flat.set(this.ramBanks[banks[1]], 0x4000);
      this.flat.set(this.ramBanks[banks[2]], 0x8000);
      this.flat.set(this.ramBanks[banks[3]], 0xC000);
      return;
    }

    // Overlay ROM at 0x0000-0x3FFF
    const romPage = this.is128K ? this.romPages[this.currentROM] : this.romPages[1];
    this.flat.set(romPage, 0);

    // Bank 5 at 0x4000-0x7FFF (always)
    this.flat.set(this.ramBanks[5], 0x4000);

    // Bank 2 at 0x8000-0xBFFF (always)
    this.flat.set(this.ramBanks[2], 0x8000);

    // Switchable bank at 0xC000-0xFFFF
    this.flat.set(this.ramBanks[this.currentBank], 0xC000);
  }

  /**
   * Save RAM regions back to their bank stores before a bank switch.
   */
  saveToRAMBanks(): void {
    if (this.specialPaging) {
      // In special mode, all 4 slots map to RAM banks
      const mode = (this.port1FFD >> 1) & 3;
      const banks = SPECIAL_MODES[mode];
      this.ramBanks[banks[0]].set(this.flat.subarray(0x0000, 0x4000));
      this.ramBanks[banks[1]].set(this.flat.subarray(0x4000, 0x8000));
      this.ramBanks[banks[2]].set(this.flat.subarray(0x8000, 0xC000));
      this.ramBanks[banks[3]].set(this.flat.subarray(0xC000, 0x10000));
      return;
    }

    // Bank 5 is always at 0x4000
    this.ramBanks[5].set(this.flat.subarray(0x4000, 0x8000));
    // Bank 2 is always at 0x8000
    this.ramBanks[2].set(this.flat.subarray(0x8000, 0xC000));
    // Current switchable bank at 0xC000
    this.ramBanks[this.currentBank].set(this.flat.subarray(0xC000, 0x10000));
  }

  /**
   * Perform a guarded bank switch: save current bank contents,
   * update port value, load new bank contents.
   */
  bankSwitch(val: number): void {
    if (!this.is128K || this.pagingLocked) return;

    // Save current banked RAM back to stores
    this.saveToRAMBanks();

    // Apply new paging
    this.writePort7FFD(val);
  }

  /**
   * Perform a guarded 0x1FFD bank switch (+2A special paging port).
   */
  bankSwitch1FFD(val: number): void {
    if (!this.is128K || this.pagingLocked) return;

    this.saveToRAMBanks();
    this.writePort1FFD(val);
  }

  /**
   * Load raw 48K RAM (49152 bytes) into banks 5, 2, 0 and the flat array.
   * Used by SNA loader.
   */
  load48KRAM(data: Uint8Array): void {
    // 0x4000-0x7FFF -> bank 5
    this.ramBanks[5].set(data.subarray(0, 16384));
    // 0x8000-0xBFFF -> bank 2
    this.ramBanks[2].set(data.subarray(16384, 32768));
    // 0xC000-0xFFFF -> bank 0
    this.ramBanks[0].set(data.subarray(32768, 49152));
    this.currentBank = 0;
    this.applyBanking();
  }
}
