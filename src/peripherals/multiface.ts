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
import type { SpectrumMemory } from '@/memory.ts';

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

  /** 16KB overlay placed in slot 0 when paged in: [mfRom | mfRam]. */
  private mfOverlay = new Uint8Array(16384);

  /** RAM bank that was at slot 0 when MF paged in (-1 = ROM). */
  savedSlot0Bank = -1;

  reset(): void {
    this.pagedIn = false;
    this.mfRam.fill(0);
    this.savedSlot0Bank = -1;
  }

  loadROM(data: Uint8Array): void {
    this.mfRom.set(data.subarray(0, 8192));
    this.romLoaded = true;
  }

  /**
   * Overlay MF ROM+RAM into slot 0 by replacing the slot pointer.
   * @param slot0Bank RAM bank that was at slot 0 (-1 = ROM) for tracking.
   */
  pageIn(memory: SpectrumMemory, slot0Bank = -1): void {
    if (this.pagedIn) return;
    this.savedSlot0Bank = slot0Bank;
    // Build the 16KB overlay: [ROM 8KB | RAM 8KB]
    this.mfOverlay.set(this.mfRom, 0);
    this.mfOverlay.set(this.mfRam, 0x2000);
    memory.setSlot0(this.mfOverlay);
    this.pagedIn = true;
  }

  /**
   * Remove MF overlay: save any RAM writes from overlay, restore slot 0.
   */
  pageOut(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    // Save any writes to MF RAM back (software may have modified 0x2000-0x3FFF)
    this.mfRam.set(this.mfOverlay.subarray(0x2000, 0x4000));
    memory.restoreSlot0();
    this.pagedIn = false;
  }

  /** Press the red button: page in then trigger NMI. */
  pressButton(memory: SpectrumMemory, cpu: Z80, slot0Bank = -1): void {
    if (!this.enabled || !this.romLoaded) return;
    this.pageIn(memory, slot0Bank);
    cpu.nmi();
  }

  /** Check if a port IN matches a Multiface paging port.
   *  Returns 'in' for page-in, 'out' for page-out, null for no match. */
  matchPort(port: number): 'in' | 'out' | null {
    const lo = port & 0xFF;
    switch (this.variant) {
      case 'MF1':
        if ((lo & 0x22) !== 0x02) return null;
        if (lo === 0x9F) return 'in';
        if (lo === 0x1F) return 'out';
        return null;
      case 'MF128':
        if (lo === 0xBF) return 'in';
        if (lo === 0x3F) return 'out';
        return null;
      case 'MF3':
        if (lo === 0x3F) return 'in';
        if (lo === 0xBF) return 'out';
        return null;
    }
  }
}
