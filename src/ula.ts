/**
 * ZX Spectrum ULA (Uncommitted Logic Array).
 *
 * Handles:
 * - Screen rendering (256x192 bitmap + attributes -> 320x256 RGBA with border)
 * - Border color (port 0xFE bits 0-2)
 * - Beeper output (port 0xFE bit 4)
 * - Keyboard reading (port 0xFE, address lines select half-rows)
 */

import { SpectrumKeyboard } from './keyboard.ts';

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

/** Screen dimensions including border */
export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 256;

/** Border size in pixels */
const BORDER_LEFT = 32;
const BORDER_TOP = 32;

export class ULA {
  /** RGBA pixel buffer (320x256) */
  pixels: Uint8Array;
  private pixels32: Uint32Array;

  /** Border color (0-7) */
  borderColor = 0;

  /** Beeper state (bit 4 of port 0xFE) */
  beeperBit = 0;

  /** Flash counter (toggles every 16 frames) */
  flashCounter = 0;
  flashState = false;

  /** Reference to keyboard for port reads */
  keyboard: SpectrumKeyboard;

  constructor(keyboard: SpectrumKeyboard) {
    this.pixels = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    this.pixels32 = new Uint32Array(this.pixels.buffer);
    this.keyboard = keyboard;
  }

  reset(): void {
    this.borderColor = 7; // White border on reset
    this.beeperBit = 0;
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
   * Bit 6 is EAR input (always 1 for now).
   */
  readPort(highByte: number): number {
    return this.keyboard.readHalfRows(highByte) | 0xA0;
  }

  /**
   * Render the full screen (border + display area) from memory.
   * Called once per frame.
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
      const screenY = y + BORDER_TOP;

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

        const px = BORDER_LEFT + (col << 3);
        const baseIdx = screenY * SCREEN_WIDTH + px;

        for (let bit = 7; bit >= 0; bit--) {
          this.pixels32[baseIdx + (7 - bit)] =
            (byteVal & (1 << bit)) ? inkRGBA : paperRGBA;
        }
      }
    }
  }
}
