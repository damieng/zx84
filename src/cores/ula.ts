/**
 * ZX Spectrum ULA (Uncommitted Logic Array).
 *
 * Handles:
 * - Screen rendering (256x192 bitmap + attributes -> 320x256 RGBA with border)
 * - Border color (port 0xFE bits 0-2)
 * - Beeper output (port 0xFE bit 4)
 * - Keyboard reading (port 0xFE, address lines select half-rows)
 */

import { SpectrumKeyboard } from '@/keyboard.ts';

// 16-color palette: normal (0-7) and bright (8-15)
// RGBA values for each color
const PALETTE: Uint32Array = new Uint32Array([
  // Normal
  0xFF000000, // 0: black
  0xFFCD0000, // 1: blue
  0xFF0000CD, // 2: red
  0xFFCD00CD, // 3: magenta
  0xFF00CD00, // 4: green
  0xFFCDCD00, // 5: cyan
  0xFF00CDCD, // 6: yellow
  0xFFCDCDCD, // 7: white
  // Bright
  0xFF000000, // 8: black (bright)
  0xFFFF0000, // 9: blue (bright)
  0xFF0000FF, // 10: red (bright)
  0xFFFF00FF, // 11: magenta (bright)
  0xFF00FF00, // 12: green (bright)
  0xFFFFFF00, // 13: cyan (bright)
  0xFF00FFFF, // 14: yellow (bright)
  0xFFFFFFFF, // 15: white (bright)
]);

export type BorderMode = 0 | 1 | 2; // 0=none, 1=small, 2=normal

/** Default screen dimensions including border */
export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 256;

/** Border pixel sizes for each mode */
const BORDER_PIXELS: Record<BorderMode, number> = { 0: 0, 1: 16, 2: 32 };

export class ULA {
  /** RGBA pixel buffer */
  pixels: Uint8Array;
  private pixels32: Uint32Array;

  /** Border dimensions */
  private borderLeft = 32;
  private borderTop = 32;
  screenWidth = SCREEN_WIDTH;
  screenHeight = SCREEN_HEIGHT;

  /** Border color (0-7) */
  borderColor = 0;

  /** Beeper state (bit 4 of port 0xFE) */
  beeperBit = 0;

  /** Tape EAR bit (0 or 1), set by the tape player */
  tapeEarBit = 0;

  /** Whether tape playback is active (overrides beeper feedback on bit 6) */
  tapeActive = false;

  /** Flash counter (toggles every 16 frames) */
  flashCounter = 0;
  flashState = false;

  /** Reference to keyboard for port reads */
  keyboard: SpectrumKeyboard;

  constructor(keyboard: SpectrumKeyboard) {
    this.pixels = new Uint8Array(this.screenWidth * this.screenHeight * 4);
    this.pixels32 = new Uint32Array(this.pixels.buffer);
    this.keyboard = keyboard;
  }

  setBorderMode(mode: BorderMode): void {
    const b = BORDER_PIXELS[mode];
    if (b === this.borderLeft) return;
    this.borderLeft = b;
    this.borderTop = b;
    this.screenWidth = 256 + b * 2;
    this.screenHeight = 192 + b * 2;
    this.pixels = new Uint8Array(this.screenWidth * this.screenHeight * 4);
    this.pixels32 = new Uint32Array(this.pixels.buffer);
  }

  reset(): void {
    this.borderColor = 7; // White border on reset
    this.beeperBit = 0;
    this.tapeEarBit = 0;
    this.tapeActive = false;
    this.flashCounter = 0;
    this.flashState = false;
    this.pixels.fill(0);
  }

  /**
   * Write to port 0xFE.
   * Bits 0-2: border color
   * Bit 3: MIC
   * Bit 4: EAR (beeper)
   */
  writePort(val: number): void {
    this.borderColor = val & 0x07;
    this.beeperBit = (val >> 4) & 1;
  }

  /**
   * Read port 0xFE. Returns keyboard data in bits 0-4.
   * Bit 5 = 1, Bit 7 = 1 (unused, always set).
   * Bit 6 = EAR input: tape signal when playing, beeper feedback otherwise.
   */
  readPort(highByte: number): number {
    const ear = this.tapeActive ? this.tapeEarBit : this.beeperBit;
    return this.keyboard.readHalfRows(highByte) | 0xA0 | (ear << 6);
  }

  /**
   * Render the full screen (border + display area) from memory.
   * Called once per frame (non-sub-frame path).
   */
  renderFrame(memory: Uint8Array): void {
    // Increment flash
    this.flashCounter++;
    if (this.flashCounter >= 16) {
      this.flashCounter = 0;
      this.flashState = !this.flashState;
    }

    const borderRGBA = PALETTE[this.borderColor];

    // Fill entire buffer with border
    this.pixels32.fill(borderRGBA);

    // Render 256x192 display area
    for (let y = 0; y < 192; y++) {
      const screenY = y + this.borderTop;

      // ZX Spectrum peculiar bitmap address decoding
      const bitmapAddr = 0x4000 |
        ((y & 0xC0) << 5) |
        ((y & 0x07) << 8) |
        ((y & 0x38) << 2);

      // Attribute address for this character row
      const attrRow = y >> 3;
      const attrBase = 0x5800 + (attrRow << 5);

      for (let col = 0; col < 32; col++) {
        const byteVal = memory[bitmapAddr + col];
        const attr = memory[attrBase + col];

        const bright = (attr & 0x40) ? 8 : 0;
        let ink = (attr & 0x07) + bright;
        let paper = ((attr >> 3) & 0x07) + bright;

        // Flash: swap ink and paper
        if ((attr & 0x80) && this.flashState) {
          const tmp = ink;
          ink = paper;
          paper = tmp;
        }

        const inkRGBA = PALETTE[ink];
        const paperRGBA = PALETTE[paper];

        const px = this.borderLeft + (col << 3);
        const baseIdx = screenY * this.screenWidth + px;

        for (let bit = 7; bit >= 0; bit--) {
          this.pixels32[baseIdx + (7 - bit)] =
            (byteVal & (1 << bit)) ? inkRGBA : paperRGBA;
        }
      }
    }
  }

  /** Advance flash counter (called once per frame in sub-frame mode). */
  advanceFlash(): void {
    this.flashCounter++;
    if (this.flashCounter >= 16) {
      this.flashCounter = 0;
      this.flashState = !this.flashState;
    }
  }

  /**
   * Render one display line (y=0..191) with the given border color.
   * vramOffset: 0 when memory is full 64K, 0x4000 when memory is a 6912-byte
   * shadow buffer starting at the equivalent of address 0x4000.
   */
  renderScanline(y: number, memory: Uint8Array, borderColor: number, vramOffset = 0): void {
    const screenY = y + this.borderTop;
    const borderRGBA = PALETTE[borderColor];
    const w = this.screenWidth;
    const rowStart = screenY * w;

    // Left border
    for (let x = 0; x < this.borderLeft; x++) {
      this.pixels32[rowStart + x] = borderRGBA;
    }
    // Right border
    for (let x = this.borderLeft + 256; x < w; x++) {
      this.pixels32[rowStart + x] = borderRGBA;
    }

    // Bitmap address decoding (adjusted for shadow buffer offset)
    const bitmapAddr = (0x4000 |
      ((y & 0xC0) << 5) |
      ((y & 0x07) << 8) |
      ((y & 0x38) << 2)) - vramOffset;

    const attrBase = 0x5800 + ((y >> 3) << 5) - vramOffset;

    for (let col = 0; col < 32; col++) {
      const byteVal = memory[bitmapAddr + col];
      const attr = memory[attrBase + col];

      const bright = (attr & 0x40) ? 8 : 0;
      let ink = (attr & 0x07) + bright;
      let paper = ((attr >> 3) & 0x07) + bright;

      if ((attr & 0x80) && this.flashState) {
        const tmp = ink;
        ink = paper;
        paper = tmp;
      }

      const inkRGBA = PALETTE[ink];
      const paperRGBA = PALETTE[paper];

      const px = this.borderLeft + (col << 3);
      const baseIdx = rowStart + px;

      for (let bit = 7; bit >= 0; bit--) {
        this.pixels32[baseIdx + (7 - bit)] =
          (byteVal & (1 << bit)) ? inkRGBA : paperRGBA;
      }
    }
  }

  /** Render a full-width border-only row (top/bottom border). */
  renderBorderLine(screenY: number, borderColor: number): void {
    if (screenY < 0 || screenY >= this.screenHeight) return;
    const borderRGBA = PALETTE[borderColor];
    const rowStart = screenY * this.screenWidth;
    for (let x = 0; x < this.screenWidth; x++) {
      this.pixels32[rowStart + x] = borderRGBA;
    }
  }
}
