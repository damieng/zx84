/**
 * ZX Spectrum memory subsystem with 128K bank switching.
 *
 * Flat 64KB array is shared with the Z80 core.
 * 128K model: 8x16KB RAM banks + 2x16KB ROM pages.
 * Bank switching via port 0x7FFD swaps data in/out of the flat array.
 */

export class SpectrumMemory {
  /** Flat 64KB address space shared with Z80 */
  flat: Uint8Array;

  /** 8 x 16KB RAM banks (128K total) */
  ramBanks: Uint8Array[];

  /** ROM pages: [0] = 128K editor ROM, [1] = 48K BASIC ROM */
  romPages: Uint8Array[];

  /** Current port 0x7FFD value */
  port7FFD = 0;

  /** Whether paging is locked (bit 5 of 0x7FFD) */
  pagingLocked = false;

  /** Which RAM bank is paged in at 0xC000 */
  currentBank = 0;

  /** Which ROM page is active */
  currentROM = 0;

  /** True = 128K mode, false = 48K mode */
  is128K: boolean;

  constructor(is128K: boolean) {
    this.is128K = is128K;
    this.flat = new Uint8Array(65536);

    // Create 8 RAM banks
    this.ramBanks = [];
    for (let i = 0; i < 8; i++) {
      this.ramBanks.push(new Uint8Array(16384));
    }

    // Create 2 ROM pages
    this.romPages = [new Uint8Array(16384), new Uint8Array(16384)];
  }

  reset(): void {
    this.flat.fill(0);
    for (const bank of this.ramBanks) bank.fill(0);
    this.port7FFD = 0;
    this.pagingLocked = false;
    this.currentBank = 0;
    this.currentROM = 0;
    this.applyBanking();
  }

  /**
   * Load ROM data. 16KB = 48K ROM only. 32KB = both pages.
   */
  loadROM(data: Uint8Array): void {
    if (data.length >= 32768 && this.is128K) {
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
    this.currentROM = (val >> 4) & 1;

    if (val & 0x20) {
      this.pagingLocked = true;
    }

    this.applyBanking();
  }

  /**
   * Sync the flat array from/to the backing bank stores.
   * Called after any bank switch.
   */
  applyBanking(): void {
    // Save current contents of banked regions back to their banks
    // (in case CPU wrote to them since last switch)
    // We always keep bank 5 at 0x4000 and bank 2 at 0x8000

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
