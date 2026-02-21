/**
 * ZX Spectrum memory subsystem with 128K bank switching.
 *
 * Flat 64KB array is shared with the Z80 core — all CPU reads/writes
 * go directly through it.  RAM banks are separate 16KB buffers that
 * hold data for banks not currently mapped into the flat array.
 * On a bank switch only the affected slot(s) are copied in/out.
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

  /**
   * Return a 16KB view of the physical RAM bank used for the current display.
   * The ULA always reads from bank 5 (or bank 7 when bit 3 of 0x7FFD is set),
   * regardless of special paging mode.  Returns a live view into flat[] when
   * the bank is currently mapped, or the ramBanks[] copy when it isn't.
   */
  get screenBank(): Uint8Array {
    const bank = (this.port7FFD & 0x08) ? 7 : 5;

    if (!this.specialPaging) {
      // Normal paging: bank 5 is always at 0x4000
      if (bank === 5) return this.flat.subarray(0x4000, 0x8000);
      // Shadow screen (bank 7): at 0xC000 only if it's the switched bank
      if (this.currentBank === bank) return this.flat.subarray(0xC000, 0x10000);
      // Bank 7 not mapped — ramBanks[7] was saved when it was last switched out
      return this.ramBanks[bank];
    }

    // Special paging: find which slot (if any) holds the screen bank
    const mode = (this.port1FFD >> 1) & 3;
    const banks = SPECIAL_MODES[mode];
    for (let slot = 0; slot < 4; slot++) {
      if (banks[slot] === bank) {
        const base = slot * 0x4000;
        return this.flat.subarray(base, base + 0x4000);
      }
    }

    // Screen bank not currently mapped — ramBanks has the last-saved copy
    return this.ramBanks[bank];
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

  // ── Slot helpers ─────────────────────────────────────────────────────

  /** Copy flat[base..base+16K] → ramBanks[bank]. */
  private saveSlot(base: number, bank: number): void {
    this.ramBanks[bank].set(this.flat.subarray(base, base + 0x4000));
  }

  /** Copy ramBanks[bank] → flat[base..base+16K]. */
  private loadSlot(base: number, bank: number): void {
    this.flat.set(this.ramBanks[bank], base);
  }

  /** Return the 4 RAM bank numbers currently mapped into flat[]. */
  private currentSlots(): readonly [number, number, number, number] {
    if (this.specialPaging) {
      return SPECIAL_MODES[(this.port1FFD >> 1) & 3];
    }
    // Normal paging: slot 0 = ROM (use -1), slots 1-2 fixed, slot 3 variable
    return [-1, 5, 2, this.currentBank];
  }

  /** Return the RAM bank at slot 0, or -1 for ROM (normal paging). */
  get slot0Bank(): number {
    if (this.specialPaging) {
      return SPECIAL_MODES[(this.port1FFD >> 1) & 3][0];
    }
    return -1;
  }

  // ── Port writes (minimal-copy bank switching) ────────────────────────

  /**
   * Handle port 0x7FFD write.  In normal paging only slot 3 (0xC000)
   * and possibly the ROM at slot 0 change.
   */
  bankSwitch(val: number): void {
    if (!this.is128K || this.pagingLocked) return;

    const oldBank = this.currentBank;
    const newBank = val & 0x07;

    // Compute new ROM page
    let newROM: number;
    if (this.romPages.length === 4) {
      newROM = (((this.port1FFD >> 2) & 1) << 1) | ((val >> 4) & 1);
    } else {
      newROM = (val >> 4) & 1;
    }

    if (this.specialPaging) {
      // In special paging mode, 0x7FFD doesn't change what's mapped —
      // it just latches the values for when normal paging resumes.
      this.port7FFD = val;
      this.currentBank = newBank;
      this.currentROM = newROM;
      if (val & 0x20) this.pagingLocked = true;
      return;
    }

    // Normal paging: only slot 3 bank and ROM can change
    if (oldBank !== newBank) {
      this.saveSlot(0xC000, oldBank);
      this.loadSlot(0xC000, newBank);
    }
    if (newROM !== this.currentROM) {
      this.flat.set(this.romPages[newROM], 0);
    }

    this.port7FFD = val;
    this.currentBank = newBank;
    this.currentROM = newROM;
    if (val & 0x20) this.pagingLocked = true;
  }

  /**
   * Handle port 0x1FFD write.  Diffs old vs new slot assignments and
   * only copies the slots that actually change.
   */
  bankSwitch1FFD(val: number, skipSlot0 = false): void {
    if (!this.is128K || this.pagingLocked) return;

    const oldSlots = this.currentSlots();
    const wasSpecial = this.specialPaging;
    const oldROM = this.currentROM;

    // Apply new state
    this.port1FFD = val;
    this.specialPaging = (val & 1) !== 0;
    if (this.romPages.length === 4) {
      this.currentROM = (((val >> 2) & 1) << 1) | ((this.port7FFD >> 4) & 1);
    }

    const newSlots = this.currentSlots();

    // Diff each of the 4 slots; save old, load new where they differ
    const bases = [0x0000, 0x4000, 0x8000, 0xC000];
    for (let i = 0; i < 4; i++) {
      // skipSlot0: when Multiface overlay occupies flat[0..16383],
      // saving/loading slot 0 would corrupt ramBanks with MF data.
      if (i === 0 && skipSlot0) continue;
      if (oldSlots[i] === newSlots[i]) continue;
      // Save outgoing RAM bank (skip ROM sentinel -1)
      if (oldSlots[i] >= 0) this.saveSlot(bases[i], oldSlots[i]);
      // Load incoming content
      if (newSlots[i] < 0) {
        // ROM slot
        this.flat.set(this.romPages[this.currentROM], bases[i]);
      } else {
        this.loadSlot(bases[i], newSlots[i]);
      }
    }

    // Edge case: switching normal→normal with ROM change but same slot banks
    if (!wasSpecial && !this.specialPaging && !skipSlot0) {
      if (oldSlots[0] < 0 && newSlots[0] < 0 && this.currentROM !== oldROM) {
        this.flat.set(this.romPages[this.currentROM], 0);
      }
    }
  }

  // ── Bulk operations (snapshots, reset, ROM load) ─────────────────────

  /**
   * Load all 4 slots from ramBanks/ROM into flat[].
   * Used after directly populating ramBanks (snapshots, reset, ROM load).
   */
  applyBanking(): void {
    if (this.specialPaging) {
      const mode = (this.port1FFD >> 1) & 3;
      const banks = SPECIAL_MODES[mode];
      this.flat.set(this.ramBanks[banks[0]], 0x0000);
      this.flat.set(this.ramBanks[banks[1]], 0x4000);
      this.flat.set(this.ramBanks[banks[2]], 0x8000);
      this.flat.set(this.ramBanks[banks[3]], 0xC000);
      return;
    }

    const romPage = this.is128K ? this.romPages[this.currentROM] : this.romPages[1];
    this.flat.set(romPage, 0);
    this.flat.set(this.ramBanks[5], 0x4000);
    this.flat.set(this.ramBanks[2], 0x8000);
    this.flat.set(this.ramBanks[this.currentBank], 0xC000);
  }

  /**
   * Flush all mapped RAM slots from flat[] back to ramBanks[].
   * Used before serialising state (e.g. SNA save).
   */
  saveToRAMBanks(skipSlot0 = false): void {
    if (this.specialPaging) {
      const mode = (this.port1FFD >> 1) & 3;
      const banks = SPECIAL_MODES[mode];
      for (let i = 0; i < 4; i++) {
        if (i === 0 && skipSlot0) continue;
        this.saveSlot(i * 0x4000, banks[i]);
      }
      return;
    }

    this.saveSlot(0x4000, 5);
    this.saveSlot(0x8000, 2);
    this.saveSlot(0xC000, this.currentBank);
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
