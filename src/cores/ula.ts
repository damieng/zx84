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

// 16-color palettes: normal (0-7) and bright (8-15), ABGR uint32

export type ColorMap = 'basic' | 'measured' | 'vivid';

/** Basic palette — idealized 0xCD/0xFF values used by most emulators */
const PALETTE_BASIC: Uint32Array = new Uint32Array([
  0xFF000000, 0xFFCD0000, 0xFF0000CD, 0xFFCD00CD, // black, blue, red, magenta
  0xFF00CD00, 0xFFCDCD00, 0xFF00CDCD, 0xFFCDCDCD, // green, cyan, yellow, white
  0xFF000000, 0xFFFF0000, 0xFF0000FF, 0xFFFF00FF, // bright: black, blue, red, magenta
  0xFF00FF00, 0xFFFFFF00, 0xFF00FFFF, 0xFFFFFFFF, // bright: green, cyan, yellow, white
]);

/** Measured palette — derived from ULA resistor network (470Ω/220Ω into 75Ω load).
 *  Normal ≈ 75% of bright, giving more visible separation between BRIGHT and non-BRIGHT. */
const PALETTE_MEASURED: Uint32Array = new Uint32Array([
  0xFF000000, 0xFFBF0000, 0xFF0000BF, 0xFFBF00BF, // black, blue, red, magenta
  0xFF00BF00, 0xFFBFBF00, 0xFF00BFBF, 0xFFBFBFBF, // green, cyan, yellow, white
  0xFF000000, 0xFFFF0000, 0xFF0000FF, 0xFFFF00FF, // bright: black, blue, red, magenta
  0xFF00FF00, 0xFFFFFF00, 0xFF00FFFF, 0xFFFFFFFF, // bright: green, cyan, yellow, white
]);

/** Vivid palette — wider normal/bright gap (0xAA/0xFF ≈ 67%) designed for CRT
 *  shader modes where scanlines and masks compress the visible dynamic range. */
const PALETTE_VIVID: Uint32Array = new Uint32Array([
  0xFF000000, 0xFFAA0000, 0xFF0000AA, 0xFFAA00AA, // black, blue, red, magenta
  0xFF00AA00, 0xFFAAAA00, 0xFF00AAAA, 0xFFAAAAAA, // green, cyan, yellow, white
  0xFF000000, 0xFFFF0000, 0xFF0000FF, 0xFFFF00FF, // bright: black, blue, red, magenta
  0xFF00FF00, 0xFFFFFF00, 0xFF00FFFF, 0xFFFFFFFF, // bright: green, cyan, yellow, white
]);

export const PALETTES: Record<ColorMap, Uint32Array> = {
  basic: PALETTE_BASIC,
  measured: PALETTE_MEASURED,
  vivid: PALETTE_VIVID,
};

export type BorderMode = 0 | 1 | 2; // 0=none, 1=small, 2=normal

/** Default screen dimensions including border */
export const SCREEN_WIDTH = 352;   // 256 + 48*2
export const SCREEN_HEIGHT = 288;  // 192 + 48*2

/** Border pixel sizes for each mode.
 *  The real Spectrum has ~48px visible border on all sides (24T horizontal,
 *  48 scanlines vertical).  Mode 2 ("normal") uses 48px to show the full
 *  visible border area including border effects. */
const BORDER_PIXELS: Record<BorderMode, number> = { 0: 0, 1: 24, 2: 48 };

export class ULA {
  /** RGBA pixel buffer */
  pixels: Uint8Array;
  private pixels32: Uint32Array;

  /** Border dimensions */
  private borderLeft = 48;
  private borderTop = 48;
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

  /** Active color palette */
  palette: Uint32Array = PALETTE_BASIC;

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
   * Bit 5 = always 1 (not connected on 48K hardware).
   * Bit 6 = EAR input (tape signal or beeper feedback).
   * Bit 7 = 1 (unused, always set).
   */
  readPort(highByte: number): number {
    const ear = this.tapeActive ? this.tapeEarBit : this.beeperBit;
    return this.keyboard.readHalfRows(highByte) | 0xA0 | (ear << 6);
  }

  /**
   * Get the effective EAR bit for audio output.
   * During tape playback (with sound enabled), this is the tape signal;
   * otherwise it's the beeper.
   */
  getAudioEarBit(tapeSoundEnabled: boolean): number {
    return (this.tapeActive && tapeSoundEnabled) ? this.tapeEarBit : this.beeperBit;
  }

  /**
   * Render the full screen (border + display area) from memory.
   * Called once per frame (non-sub-frame path).
   */
  renderFrame(memory: Uint8Array, vramOffset = 0): void {
    // Increment flash
    this.flashCounter++;
    if (this.flashCounter >= 16) {
      this.flashCounter = 0;
      this.flashState = !this.flashState;
    }

    const borderRGBA = this.palette[this.borderColor];

    // Fill entire buffer with border
    this.pixels32.fill(borderRGBA);

    // Render 256x192 display area
    for (let y = 0; y < 192; y++) {
      const screenY = y + this.borderTop;

      // ZX Spectrum peculiar bitmap address decoding (adjusted for vramOffset)
      const bitmapAddr = (0x4000 |
        ((y & 0xC0) << 5) |
        ((y & 0x07) << 8) |
        ((y & 0x38) << 2)) - vramOffset;

      // Attribute address for this character row
      const attrRow = y >> 3;
      const attrBase = 0x5800 + (attrRow << 5) - vramOffset;

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

        const inkRGBA = this.palette[ink];
        const paperRGBA = this.palette[paper];

        const px = this.borderLeft + (col << 3);
        const baseIdx = screenY * this.screenWidth + px;

        for (let bit = 7; bit >= 0; bit--) {
          this.pixels32[baseIdx + (7 - bit)] =
            (byteVal & (1 << bit)) ? inkRGBA : paperRGBA;
        }
      }
    }
  }

  /**
   * Blank matched character cells to paper color in the rendered framebuffer.
   * Called after renderFrame when TEXT mode is active.
   */
  blankCells(memory: Uint8Array, mask: boolean[], vramOffset = 0): void {
    for (let charRow = 0; charRow < 24; charRow++) {
      for (let col = 0; col < 32; col++) {
        if (!mask[charRow * 32 + col]) continue;

        const attr = memory[0x5800 + charRow * 32 + col - vramOffset];
        const bright = (attr & 0x40) ? 8 : 0;
        let paper = ((attr >> 3) & 0x07) + bright;
        let ink = (attr & 0x07) + bright;
        if ((attr & 0x80) && this.flashState) { const t = ink; ink = paper; paper = t; }
        const paperRGBA = this.palette[paper];

        for (let py = 0; py < 8; py++) {
          const y = charRow * 8 + py;
          const screenY = y + this.borderTop;
          const px = this.borderLeft + (col << 3);
          const baseIdx = screenY * this.screenWidth + px;
          for (let x = 0; x < 8; x++) {
            this.pixels32[baseIdx + x] = paperRGBA;
          }
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
    const borderRGBA = this.palette[borderColor];
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

      const inkRGBA = this.palette[ink];
      const paperRGBA = this.palette[paper];

      const px = this.borderLeft + (col << 3);
      const baseIdx = rowStart + px;

      for (let bit = 7; bit >= 0; bit--) {
        this.pixels32[baseIdx + (7 - bit)] =
          (byteVal & (1 << bit)) ? inkRGBA : paperRGBA;
      }
    }
  }

  /**
   * Render only the 256-pixel display data for one scanline (no borders).
   * Used by the inline scanline renderer which handles borders separately
   * with sub-scanline precision.
   */
  renderDisplayData(y: number, memory: Uint8Array, vramOffset = 0): void {
    const screenY = y + this.borderTop;
    const rowStart = screenY * this.screenWidth;

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

      const inkRGBA = this.palette[ink];
      const paperRGBA = this.palette[paper];

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
    const borderRGBA = this.palette[borderColor];
    const rowStart = screenY * this.screenWidth;
    for (let x = 0; x < this.screenWidth; x++) {
      this.pixels32[rowStart + x] = borderRGBA;
    }
  }

  /** Fill a horizontal segment of a border row with the given color. */
  fillBorder(screenY: number, x1: number, x2: number, borderColor: number): void {
    const rgba = this.palette[borderColor];
    const rowStart = screenY * this.screenWidth;
    for (let x = x1; x < x2; x++) {
      this.pixels32[rowStart + x] = rgba;
    }
  }
}
