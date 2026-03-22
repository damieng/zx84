/**
 * Multiface peripheral — overlays 8KB ROM + 8KB RAM into slot 0 (0x0000-0x3FFF).
 *
 * Three variants:
 *   MF1   (48K)       — OUT 0x9F pages in, OUT 0x1F pages out
 *   MF128 (128K/+2)   — OUT 0xBF pages in, OUT 0x3F pages out
 *   MF3   (+2A/+3)    — OUT 0x3F pages in, OUT 0xBF pages out
 */

import type { SpectrumModel } from '@/spectrum.ts';
import type { Z80 } from '@/cores/z80.ts';

export type MultifaceVariant = 'MF1' | 'MF128' | 'MF3';

export function variantForModel(model: SpectrumModel): MultifaceVariant {
  if (model === '48k') return 'MF1';
  if (model === '+2a' || model === '+3') return 'MF3';
  return 'MF128';
}

export function variantLabel(variant: MultifaceVariant): string {
  if (variant === 'MF1') return 'Multiface 1';
  if (variant === 'MF128') return 'Multiface 128';
  return 'Multiface 3';
}

export function romFilename(variant: MultifaceVariant): string {
  if (variant === 'MF1') return 'MF1.rom';
  if (variant === 'MF128') return 'MF128.rom';
  return 'MF3.rom';
}

export class Multiface {
  enabled = false;
  pagedIn = false;
  romLoaded = false;
  variant: MultifaceVariant = 'MF1';

  /** 8KB Multiface ROM (0x0000-0x1FFF when paged in) */
  mfRom = new Uint8Array(8192);
  /** 8KB Multiface RAM (0x2000-0x3FFF when paged in) */
  mfRam = new Uint8Array(8192);

  /** Saved slot-0 contents so we can restore on page-out */
  private savedSlot0 = new Uint8Array(16384);
  /** RAM bank that was at slot 0 when savedSlot0 was captured (-1 = ROM) */
  savedSlot0Bank = -1;

  reset(): void {
    this.pagedIn = false;
    this.mfRam.fill(0);
    this.savedSlot0.fill(0);
    this.savedSlot0Bank = -1;
  }

  loadROM(data: Uint8Array): void {
    this.mfRom.set(data.subarray(0, 8192));
    this.romLoaded = true;
  }

  /** Overlay MF ROM+RAM into flat memory slot 0.
   *  Saves the current slot 0 contents first.
   *  @param slot0Bank RAM bank at slot 0 (-1 = ROM) for tracking. */
  pageIn(flat: Uint8Array, slot0Bank = -1): void {
    if (this.pagedIn) return;
    // Save current slot 0 and what bank it came from
    this.savedSlot0.set(flat.subarray(0, 16384));
    this.savedSlot0Bank = slot0Bank;
    // Overlay MF ROM at 0x0000-0x1FFF, MF RAM at 0x2000-0x3FFF
    flat.set(this.mfRom, 0);
    flat.set(this.mfRam, 0x2000);
    this.pagedIn = true;
  }

  /** Remove MF overlay: save MF RAM from flat, restore original slot 0.
   *  Caller must call applyBanking() afterwards to restore correct paging. */
  pageOut(flat: Uint8Array): void {
    if (!this.pagedIn) return;
    // Save MF RAM back from flat (software may have modified it)
    this.mfRam.set(flat.subarray(0x2000, 0x4000));
    // Restore saved slot 0
    flat.set(this.savedSlot0, 0);
    this.pagedIn = false;
  }

  /** Press the red button: page in then trigger NMI. */
  pressButton(flat: Uint8Array, cpu: Z80, slot0Bank = -1): void {
    if (!this.enabled || !this.romLoaded) return;
    this.pageIn(flat, slot0Bank);
    cpu.nmi();
  }

  /** Check if a port IN matches a Multiface paging port.
   *  Returns 'in' for page-in, 'out' for page-out, null for no match.
   *  All Multiface variants use IN (read) for paging, not OUT. */
  matchPort(port: number): 'in' | 'out' | null {
    const lo = port & 0xFF;
    switch (this.variant) {
      case 'MF1':
        // MF1: IN 0x9F pages in (A7=1), IN 0x1F pages out (A7=0)
        // Partial decode: A1 and A5 set
        if ((lo & 0x22) !== 0x02) return null;  // A1 must be set, ignore A5 loosely
        if (lo === 0x9F) return 'in';
        if (lo === 0x1F) return 'out';
        return null;
      case 'MF128':
        // MF128 v2: IN 0xBF pages in, IN 0x3F pages out
        if (lo === 0xBF) return 'in';
        if (lo === 0x3F) return 'out';
        return null;
      case 'MF3':
        // MF3: IN 0x3F pages in, IN 0xBF pages out (swapped vs MF128)
        if (lo === 0x3F) return 'in';
        if (lo === 0xBF) return 'out';
        return null;
    }
  }
}
