/**
 * Screen OCR — bitmap-level character recognition for the ZX Spectrum display.
 *
 * Compares each 8×8 character cell in the display file against multiple font
 * sources to produce a 32×24 text representation of the screen.
 *
 * Font matching order:
 *   1. CHARS system variable font (wherever 0x5C36 points in mapped memory)
 *   2. 48K ROM font (from the actual ROM page, regardless of current paging)
 *   3. Extra fonts from the fonts pane (768-byte Uint8Arrays, chars 0x20-0x7F)
 */

/** A font source for OCR matching. */
export interface FontSource {
  label: string;
  /** 768 bytes: characters 0x20-0x7F, 8 bytes each. */
  data: Uint8Array;
}

/** Map character code (33-127) to display character. */
function charForCode(c: number): string {
  return c === 0x5E ? '\u2191' : c === 0x60 ? '\u00A3' : c === 0x7F ? '\u00A9'
       : String.fromCharCode(c);
}

/** Try to match an 8×8 cell against a 768-byte font. Returns char or ''. */
function matchCell(mem: Uint8Array, base: number, font: Uint8Array, invert: boolean): string {
  for (let c = 33; c < 128; c++) {
    if (c === 0x5F) continue;    // skip '_' — too easily matched as a line
    const fb = (c - 32) << 3;  // offset into 768-byte font data
    let match = true;
    for (let p = 0; p < 8; p++) {
      const screen = mem[base + (p << 8)];
      const glyph = invert ? (font[fb + p] ^ 0xFF) : font[fb + p];
      if (screen !== glyph) { match = false; break; }
    }
    if (match) return charForCode(c);
  }
  return '';
}

/** Check whether 768 bytes of font data are identical. */
function fontsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < 768 || b.length < 768) return false;
  for (let i = 0; i < 768; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Convert ABGR uint32 palette entry to CSS hex color. */
function abgrToHex(abgr: number): string {
  const r = (abgr >>> 0) & 0xFF;
  const g = (abgr >>> 8) & 0xFF;
  const b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** Escape a character for safe HTML insertion. */
function escapeHtml(ch: string): string {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  return ch;
}

/** OCR result. */
export interface OcrResult {
  /** Plain text: 32×24 with newlines. */
  text: string;
  /** HTML with per-cell colored spans. */
  html: string;
}

export class ScreenText {
  active = false;
  private lastLogKey = '';

  /** Activate OCR. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    console.log('[OCR] activated');
  }

  /** Deactivate OCR. */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.lastLogKey = '';
    console.log('[OCR] deactivated');
  }

  /**
   * Build the prioritised font list from CHARS sysvar, ROM font, and extras.
   */
  private buildFonts(mem: Uint8Array, romFont: Uint8Array, extraFonts?: FontSource[]): FontSource[] {
    const charsAddr = mem[0x5C36] | (mem[0x5C37] << 8);
    const charsFontStart = charsAddr + 256;

    const fonts: FontSource[] = [];

    // 1. CHARS sysvar font — only if space char is blank and ≥10 screen cells match
    if (charsFontStart + 768 <= 65536) {
      const charsData = mem.slice(charsFontStart, charsFontStart + 768);

      // First 8 bytes (space glyph) must be all zero
      let spaceBlank = true;
      for (let i = 0; i < 8; i++) {
        if (charsData[i] !== 0) { spaceBlank = false; break; }
      }

      if (spaceBlank) {
        // Quick scan: count how many non-blank screen cells match this font
        let matchCount = 0;
        for (let cr = 0; cr < 24 && matchCount < 10; cr++) {
          const third = cr >> 3;
          const rowInThird = cr & 7;
          for (let col = 0; col < 32 && matchCount < 10; col++) {
            const base = 0x4000 + (third << 11) + (rowInThird << 5) + col;
            // Skip blank cells
            if (mem[base] === 0) {
              let allZero = true;
              for (let p = 1; p < 8; p++) {
                if (mem[base + (p << 8)] !== 0) { allZero = false; break; }
              }
              if (allZero) continue;
            }
            if (matchCell(mem, base, charsData, false)) matchCount++;
          }
        }

        if (matchCount >= 10) {
          fonts.push({ label: `CHARS @${charsFontStart.toString(16)}`, data: charsData });
        }
      }
    }

    // 2. 48K ROM font (skip if CHARS already points to identical data)
    if (fonts.length === 0 || !fontsEqual(fonts[0].data, romFont)) {
      fonts.push({ label: 'ROM font', data: romFont });
    }

    // 3. Extra fonts from fonts pane
    if (extraFonts) {
      for (const ef of extraFonts) fonts.push(ef);
    }

    return fonts;
  }

  /**
   * Match a single screen cell against the font list.
   * Returns the matched character, or null if blank / unrecognised.
   */
  private matchCellFromFonts(
    mem: Uint8Array, base: number, fonts: FontSource[], hits: Uint32Array,
  ): string | null {
    // Fast path: all-zero cell → space (matched, gets paper color)
    const b0 = mem[base];
    if (b0 === 0) {
      let allZero = true;
      for (let p = 1; p < 8; p++) {
        if (mem[base + (p << 8)] !== 0) { allZero = false; break; }
      }
      if (allZero) return ' ';
    }

    // Try each font source in priority order (normal then inverted)
    for (let fi = 0; fi < fonts.length; fi++) {
      let ch = matchCell(mem, base, fonts[fi].data, false);
      if (!ch) ch = matchCell(mem, base, fonts[fi].data, true);
      if (ch) { hits[fi]++; return ch; }
    }
    return null;
  }

  /**
   * Log font hit summary (only when it changes).
   */
  private logHits(fonts: FontSource[], hits: Uint32Array): void {
    const parts: string[] = [];
    for (let fi = 0; fi < fonts.length; fi++) {
      if (hits[fi] > 0) parts.push(`${fonts[fi].label}: ${hits[fi]}`);
    }
    const logKey = parts.join(', ');
    if (logKey !== this.lastLogKey) {
      this.lastLogKey = logKey;
      if (logKey) console.log(`[OCR] ${logKey}`);
    }
  }

  /**
   * OCR the 32×24 screen — plain text only.
   * @param mem        Full 64K address space
   * @param romFont    768-byte font from the 48K BASIC ROM (always available)
   * @param extraFonts Additional 768-byte fonts from the fonts pane
   * Returns empty string if not active.
   */
  ocr(mem: Uint8Array, romFont: Uint8Array, extraFonts?: FontSource[]): string {
    if (!this.active) return '';

    const fonts = this.buildFonts(mem, romFont, extraFonts);
    const hits = new Uint32Array(fonts.length);
    let text = '';

    for (let charRow = 0; charRow < 24; charRow++) {
      const third = charRow >> 3;
      const rowInThird = charRow & 7;

      for (let charCol = 0; charCol < 32; charCol++) {
        const base = 0x4000 + (third << 11) + (rowInThird << 5) + charCol;
        text += this.matchCellFromFonts(mem, base, fonts, hits) ?? ' ';
      }

      if (charRow < 23) text += '\n';
    }

    this.logHits(fonts, hits);
    return text;
  }

  /**
   * OCR the 32×24 screen — returns both plain text and colored HTML.
   *
   * Each character cell is wrapped in a <span> with inline color/background-color
   * matching the Spectrum attribute (ink/paper/bright/flash).
   *
   * @param mem        Full 64K address space
   * @param romFont    768-byte font from the 48K BASIC ROM
   * @param palette    16-entry ABGR palette (normal 0-7, bright 8-15)
   * @param flash      Current flash phase (true = swapped)
   * @param extraFonts Additional fonts from the fonts pane
   */
  ocrStyled(
    mem: Uint8Array, romFont: Uint8Array,
    palette: Uint32Array, flash: boolean,
    extraFonts?: FontSource[],
  ): OcrResult {
    if (!this.active) return { text: '', html: '' };

    const fonts = this.buildFonts(mem, romFont, extraFonts);
    const hits = new Uint32Array(fonts.length);

    // Pre-compute CSS hex colors for the 16 palette entries
    const css: string[] = [];
    for (let i = 0; i < 16; i++) css.push(abgrToHex(palette[i]));

    let text = '';
    let html = '';
    let spanOpen = false;
    let curInk = -1, curPaper = -1;

    for (let charRow = 0; charRow < 24; charRow++) {
      const third = charRow >> 3;
      const rowInThird = charRow & 7;
      const attrBase = 0x5800 + charRow * 32;

      for (let charCol = 0; charCol < 32; charCol++) {
        const base = 0x4000 + (third << 11) + (rowInThird << 5) + charCol;
        const ch = this.matchCellFromFonts(mem, base, fonts, hits);
        text += ch ?? ' ';

        if (ch === null) {
          // Blank / unrecognised — close any open span, emit transparent space
          if (spanOpen) { html += '</span>'; spanOpen = false; curInk = curPaper = -1; }
          html += ' ';
        } else {
          // Recognised text — opaque span with attribute colors
          const attr = mem[attrBase + charCol];
          const bright = (attr & 0x40) ? 8 : 0;
          let ink = (attr & 0x07) + bright;
          let paper = ((attr >> 3) & 0x07) + bright;
          if ((attr & 0x80) && flash) { const t = ink; ink = paper; paper = t; }

          if (ink !== curInk || paper !== curPaper) {
            if (spanOpen) html += '</span>';
            html += `<span style="color:${css[ink]};background:${css[paper]}">`;
            curInk = ink;
            curPaper = paper;
            spanOpen = true;
          }
          html += escapeHtml(ch);
        }
      }

      // End of row — close span, reset
      if (spanOpen) { html += '</span>'; spanOpen = false; curInk = curPaper = -1; }
      text += charRow < 23 ? '\n' : '';
      html += charRow < 23 ? '\n' : '';
    }

    this.logHits(fonts, hits);
    return { text, html };
  }
}
