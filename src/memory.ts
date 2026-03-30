/**
 * ZX Spectrum memory subsystem with 128K bank switching.
 *
 * Each RAM bank is the single authoritative source for its data.
 * Four slot pointers map 16KB windows of the Z80 address space to banks
 * (or ROM pages).  Bank switches are O(1) pointer assignments — no copying.
 * CPU reads/writes route through readByte/writeByte which index the slot.
 */

import type { SpectrumModel } from '@/models.ts';

/** Special paging all-RAM bank configurations (indexed by mode 0-3). */
const SPECIAL_MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [4, 5, 6, 3],
  [4, 7, 6, 3],
];

/**
 * Minimal interface for reading from the Z80 paged address space.
 * Implemented by SpectrumMemory; accepted by all debug and display tools.
 */
export interface ByteReader {
  readByte(addr: number): number;
  readBlock(addr: number, len: number): Uint8Array;
}

export class SpectrumMemory implements ByteReader {
  /** 8 × 16KB RAM banks. Always authoritative — no flat cache. */
  private _ramBanks: Uint8Array[];

  /**
   * Four 16KB slot pointers mapping Z80 address space to bank / ROM arrays.
   *   _slots[0] = 0x0000-0x3FFF  (ROM or special-paging RAM, or MF/VTX overlay)
   *   _slots[1] = 0x4000-0x7FFF  (bank 5 in normal paging)
   *   _slots[2] = 0x8000-0xBFFF  (bank 2 in normal paging)
   *   _slots[3] = 0xC000-0xFFFF  (variable bank)
   */
  private _slots: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];

  /** ROM pages: 2 for 48K/128K/+2, 4 for +2A/+3 */
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

  /** True when an external peripheral (e.g. VTX-5000) has overridden slot 0.
   *  Suppresses ROM updates to slot 0 during bank switches. */
  externalRomPaged = false;

  constructor(model: SpectrumModel, opts?: { hasBanking?: boolean; romPageCount?: number }) {
    this.is128K = opts?.hasBanking ?? (model !== '48k');

    // Create 8 RAM banks
    this._ramBanks = [];
    for (let i = 0; i < 8; i++) {
      this._ramBanks.push(new Uint8Array(16384));
    }

    // Create ROM pages
    const romCount = opts?.romPageCount ?? (this.is128K ? 2 : 1);
    const allocCount = Math.max(2, romCount);
    this.romPages = [];
    for (let i = 0; i < allocCount; i++) {
      this.romPages.push(new Uint8Array(16384));
    }

    // Initialise slots to safe empty arrays (updateSlots() will assign real ones)
    const empty = new Uint8Array(16384);
    this._slots = [empty, empty, empty, empty];
  }

  // ── Paged memory access ───────────────────────────────────────────────

  /** Read one byte from the Z80 address space. */
  readByte(addr: number): number {
    return this._slots[addr >>> 14][addr & 0x3FFF];
  }

  /** Write one byte into the Z80 address space (no ROM protection — callers handle that). */
  writeByte(addr: number, val: number): void {
    this._slots[addr >>> 14][addr & 0x3FFF] = val & 0xFF;
  }

  /** Read a block of bytes from the Z80 address space into a new Uint8Array. */
  readBlock(addr: number, len: number): Uint8Array {
    const result = new Uint8Array(len);
    for (let i = 0; i < len; i++) result[i] = this.readByte((addr + i) & 0xFFFF);
    return result;
  }

  /** Return the current Uint8Array backing a given 16KB slot (0-3). */
  getSlot(slot: number): Uint8Array {
    return this._slots[slot];
  }

  // ── Screen bank ───────────────────────────────────────────────────────

  /**
   * Return the 16KB RAM bank used for the current display.
   * Always authoritative — no flat() flush needed.
   */
  get screenBank(): Uint8Array {
    const bank = (this.port7FFD & 0x08) ? 7 : 5;
    return this._ramBanks[bank];
  }

  // ── Slot management ───────────────────────────────────────────────────

  /**
   * Override slot 0 with an external buffer (e.g. Multiface / VTX-5000 overlay).
   * Returns the previous slot 0 pointer for callers that need to restore it.
   */
  setSlot0(overlay: Uint8Array): Uint8Array {
    const prev = this._slots[0];
    this._slots[0] = overlay;
    return prev;
  }

  /**
   * Restore slot 0 from current paging state.
   * Call after removing a Multiface / VTX-5000 overlay.
   */
  restoreSlot0(): void {
    if (this.externalRomPaged) return; // external ROM manages its own slot 0
    if (this.specialPaging) {
      this._slots[0] = this._ramBanks[SPECIAL_MODES[(this.port1FFD >> 1) & 3][0]];
    } else {
      this._slots[0] = this.romPages[this.currentROM];
    }
  }

  /** Update all four slot pointers to reflect current paging state. */
  private updateSlots(): void {
    if (this.specialPaging) {
      const banks = SPECIAL_MODES[(this.port1FFD >> 1) & 3];
      this._slots[0] = this._ramBanks[banks[0]];
      this._slots[1] = this._ramBanks[banks[1]];
      this._slots[2] = this._ramBanks[banks[2]];
      this._slots[3] = this._ramBanks[banks[3]];
    } else {
      if (!this.externalRomPaged) {
        this._slots[0] = this.is128K ? this.romPages[this.currentROM] : this.romPages[1];
      }
      this._slots[1] = this._ramBanks[5];
      this._slots[2] = this._ramBanks[2];
      this._slots[3] = this._ramBanks[this.currentBank];
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  reset(): void {
    for (const bank of this._ramBanks) bank.fill(0);
    this.port7FFD = 0;
    this.port1FFD = 0;
    this.pagingLocked = false;
    this.currentBank = 0;
    this.currentROM = 0;
    this.specialPaging = false;
    this.externalRomPaged = false;
    this.updateSlots();
  }

  /**
   * Load ROM data. 16KB = 48K ROM only. 32KB = 2 pages. 64KB = 4 pages (+2A).
   */
  loadROM(data: Uint8Array): void {
    if (data.length >= 65536 && this.romPages.length === 4) {
      for (let i = 0; i < 4; i++) {
        this.romPages[i].set(data.subarray(i * 16384, (i + 1) * 16384));
      }
    } else if (data.length >= 32768 && this.is128K) {
      this.romPages[0].set(data.subarray(0, 16384));
      this.romPages[1].set(data.subarray(16384, 32768));
    } else if (data.length >= 16384) {
      this.romPages[1].set(data.subarray(0, 16384));
      if (!this.is128K) {
        this.romPages[0].set(data.subarray(0, 16384));
      }
    }
    this.updateSlots();
  }

  // ── Port writes (O(1) slot pointer updates) ───────────────────────────

  /**
   * Handle port 0x7FFD write.
   * @param skipSlot0 Pass true when Multiface/VTX overlay occupies slot 0.
   */
  bankSwitch(val: number, skipSlot0 = false): void {
    if (!this.is128K || this.pagingLocked) return;

    const newBank = val & 0x07;

    let newROM: number;
    if (this.romPages.length === 4) {
      newROM = (((this.port1FFD >> 2) & 1) << 1) | ((val >> 4) & 1);
    } else {
      newROM = (val >> 4) & 1;
    }

    if (this.specialPaging) {
      // In special paging, 0x7FFD only latches — does not change slots.
      this.port7FFD = val;
      this.currentBank = newBank;
      this.currentROM = newROM;
      if (val & 0x20) this.pagingLocked = true;
      return;
    }

    // Normal paging: update slot 3 and possibly slot 0 (ROM).
    this._slots[3] = this._ramBanks[newBank];
    if (!skipSlot0 && !this.externalRomPaged && newROM !== this.currentROM) {
      this._slots[0] = this.romPages[newROM];
    }

    this.port7FFD = val;
    this.currentBank = newBank;
    this.currentROM = newROM;
    if (val & 0x20) this.pagingLocked = true;
  }

  /**
   * Handle port 0x1FFD write.
   * @param skipSlot0 Pass true when Multiface/VTX overlay occupies slot 0.
   */
  bankSwitch1FFD(val: number, skipSlot0 = false): void {
    if (!this.is128K || this.pagingLocked) return;

    this.port1FFD = val;
    this.specialPaging = (val & 1) !== 0;
    if (this.romPages.length === 4) {
      this.currentROM = (((val >> 2) & 1) << 1) | ((this.port7FFD >> 4) & 1);
    }

    if (this.specialPaging) {
      const banks = SPECIAL_MODES[(val >> 1) & 3];
      if (!skipSlot0) this._slots[0] = this._ramBanks[banks[0]];
      this._slots[1] = this._ramBanks[banks[1]];
      this._slots[2] = this._ramBanks[banks[2]];
      this._slots[3] = this._ramBanks[banks[3]];
    } else {
      if (!skipSlot0 && !this.externalRomPaged) {
        this._slots[0] = this.romPages[this.currentROM];
      }
      this._slots[1] = this._ramBanks[5];
      this._slots[2] = this._ramBanks[2];
      this._slots[3] = this._ramBanks[this.currentBank];
    }
  }

  // ── Bulk operations (snapshots, reset, ROM load) ──────────────────────

  /**
   * Update all slot pointers from current paging state.
   * Use after directly populating ramBanks (snapshots, reset, ROM load).
   * Kept as `applyBanking` for compatibility with snapshot loaders.
   */
  applyBanking(): void {
    this.updateSlots();
  }

  /**
   * Return all 8 RAM banks for serialisation.
   * Banks are always authoritative — no flush needed.
   */
  flushBanks(): readonly Uint8Array[] {
    return this._ramBanks;
  }

  /**
   * Build a 64KB snapshot of the current paged address space.
   * Use for debug/display tools that need a plain Uint8Array view.
   * Not for CPU execution — use readByte/writeByte for that.
   */
  snapshot(): Uint8Array {
    return this.readBlock(0, 0x10000);
  }

  // ── Public bank accessors ─────────────────────────────────────────────

  /**
   * Write 16KB of snapshot data into a RAM bank.
   * Use in snapshot loaders; call applyBanking() once all banks are populated.
   */
  setBankFromSnapshot(n: number, data: Uint8Array): void {
    this._ramBanks[n].set(data.subarray(0, 16384));
  }

  /**
   * Return a RAM bank by index. Always live — no flush needed.
   */
  getRamBank(n: number): Uint8Array {
    return this._ramBanks[n];
  }

  /**
   * Load raw 48K RAM (49152 bytes) into banks 5, 2, 0 and update slots.
   * Used by snapshot loaders.
   */
  load48KRAM(data: Uint8Array): void {
    this._ramBanks[5].set(data.subarray(0, 16384));       // 0x4000-0x7FFF
    this._ramBanks[2].set(data.subarray(16384, 32768));   // 0x8000-0xBFFF
    this._ramBanks[0].set(data.subarray(32768, 49152));   // 0xC000-0xFFFF
    this.currentBank = 0;
    this.updateSlots();
  }

  // ── Paging state helpers ──────────────────────────────────────────────

  /** RAM bank index at slot 0, or -1 when slot 0 holds ROM. */
  get slot0Bank(): number {
    if (this.specialPaging) {
      return SPECIAL_MODES[(this.port1FFD >> 1) & 3][0];
    }
    return -1;
  }
}
