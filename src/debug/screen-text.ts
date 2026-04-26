/**
 * Screen OCR — bitmap-level character recognition for the ZX Spectrum display.
 *
 * The engine extracts each character cell from the displayed screen bank and
 * compares it against a prioritised font list. Cell layout is configurable
 * (8×8 standard, 5×8 for CP/M Plus 51-column, 4×8 for Tasword 64-column…)
 * and the engine reads from the bank the ULA actually displays — not the
 * paged Z80 view — so it stays correct under +3 special paging.
 *
 * Font sources, in order of preference:
 *   1. CHARS sysvar font (only meaningful for the standard 8-wide grid)
 *   2. 48K ROM font (only meaningful for the standard 8-wide grid)
 *   3. Heuristic font detection scanning all RAM banks (non-8-wide grids)
 *   4. Extra fonts from the fonts pane
 */

/** Cell-grid configuration for OCR. */
export interface OcrConfig {
  /** Pixels per cell column (4, 5, 6, 8…). */
  cellWidth: number;
  /** Pixels per cell row (8 in practice). */
  cellHeight: number;
  cols: number;
  rows: number;
  /** Pixel x-offset of grid origin (default 0). */
  xOffset?: number;
  /** Pixel y-offset of grid origin (default 0). */
  yOffset?: number;
}

/** Built-in cell-grid presets. */
export type OcrGridName = '32x24' | '51x24' | '64x24';

export const OCR_GRIDS: Record<OcrGridName, OcrConfig> = {
  '32x24': { cellWidth: 8, cellHeight: 8, cols: 32, rows: 24 },
  '51x24': { cellWidth: 5, cellHeight: 8, cols: 51, rows: 24 },
  '64x24': { cellWidth: 4, cellHeight: 8, cols: 64, rows: 24 },
};

/** A font source for OCR matching.
 *  `data` is always 768 bytes (96 chars × 8 bytes). For non-8-wide cells only
 *  the upper `cellWidth` bits of each byte are significant. */
export interface FontSource {
  label: string;
  data: Uint8Array;
  /** Cell width the font was authored for (defaults to 8). */
  cellWidth?: number;
}

/** OCR result. */
export interface OcrResult {
  /** Plain text with newlines between rows. */
  text: string;
  /** HTML with per-cell coloured spans. */
  html: string;
  /** `cols×rows` bitmask: true = cell was matched (used to blank the framebuffer). */
  mask: boolean[];
  /** Grid the result was produced with. */
  grid: OcrGridName;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}

/** Map character code (33-127) to display character. */
function charForCode(c: number): string {
  return c === 0x5E ? '↑' : c === 0x60 ? '£' : c === 0x7F ? '©'
       : String.fromCharCode(c);
}

/** Convert ABGR uint32 palette entry to CSS hex colour. */
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

/** Bitmap mask covering the upper `cellWidth` bits of an 8-bit byte. */
function bitMaskFor(cellWidth: number): number {
  return cellWidth >= 8 ? 0xFF : (0xFF << (8 - cellWidth)) & 0xFF;
}

/** Compare two 768-byte fonts. */
function fontsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < 768 || b.length < 768) return false;
  for (let i = 0; i < 768; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Spectrum screen byte offset within a 16KB display bank for pixel row `y`
 * and byte column `byteCol` (0–31). Bank-relative — the 0x4000 base is implicit.
 */
function screenByteOffset(y: number, byteCol: number): number {
  return ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (byteCol & 0x1F);
}

/**
 * Extract one character cell into `out` (8 bytes, MSB-first).
 * For sub-byte cell widths the bits are aligned to the top of each byte so that
 * fonts of any width share the same `(c-32)*8 + p` index → byte layout.
 */
export function extractCellGlyph(
  screenBank: Uint8Array, col: number, row: number, config: OcrConfig, out: Uint8Array,
): void {
  const cellW = config.cellWidth;
  const cellH = config.cellHeight;
  const startPx = col * cellW + (config.xOffset ?? 0);
  const startY = row * cellH + (config.yOffset ?? 0);
  const byteCol = startPx >> 3;
  const bitOff = startPx & 7;
  const bitsFromLo = 8 - bitOff;
  const mask = bitMaskFor(cellW);

  for (let p = 0; p < cellH; p++) {
    const y = startY + p;
    if (y < 0 || y >= 192 || byteCol > 31) { out[p] = 0; continue; }
    const off = screenByteOffset(y, byteCol);
    let bits = (screenBank[off] << bitOff) & 0xFF;
    if (cellW > bitsFromLo && byteCol < 31) {
      const next = screenBank[screenByteOffset(y, byteCol + 1)];
      bits |= (next >>> bitsFromLo) & 0xFF;
    }
    out[p] = bits & mask;
  }
  // Zero unused rows for hashing stability
  for (let p = cellH; p < 8; p++) out[p] = 0;
}

/**
 * Try to match an extracted glyph against all printable codes in a font.
 * Tries the normal glyph first, then inverted (paper-on-ink).
 */
function matchGlyph(
  glyph: Uint8Array, font: Uint8Array, cellH: number, mask: number,
): string {
  for (let invertPass = 0; invertPass < 2; invertPass++) {
    const invert = invertPass === 1;
    for (let c = 33; c < 128; c++) {
      if (c === 0x5F) continue; // skip '_' — too easily matched as a line
      const fb = (c - 32) << 3;
      let match = true;
      for (let p = 0; p < cellH; p++) {
        const expect = invert ? ((font[fb + p] ^ 0xFF) & mask) : (font[fb + p] & mask);
        if (glyph[p] !== expect) { match = false; break; }
      }
      if (match) return charForCode(c);
    }
  }
  return '';
}

/** True if the glyph is entirely zero. */
function isBlankGlyph(glyph: Uint8Array, cellH: number): boolean {
  for (let p = 0; p < cellH; p++) if (glyph[p] !== 0) return false;
  return true;
}

/**
 * Quick validation pass: count how many non-blank screen cells the candidate
 * font can match. Used to decide whether CHARS sysvar / extracted RAM fonts
 * are real before committing to them.
 */
function validateFontAgainstScreen(
  screenBank: Uint8Array, fontData: Uint8Array, config: OcrConfig, threshold: number,
): boolean {
  const glyph = new Uint8Array(8);
  const cellH = config.cellHeight;
  const mask = bitMaskFor(config.cellWidth);
  let matchCount = 0;
  for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      extractCellGlyph(screenBank, c, r, config, glyph);
      if (isBlankGlyph(glyph, cellH)) continue;
      if (matchGlyph(glyph, fontData, cellH, mask)) {
        if (++matchCount >= threshold) return true;
      }
    }
  }
  return false;
}

/**
 * Heuristic: pick the cell grid that produces the highest tile-repetition rate.
 *
 * For each candidate grid, slice the screen into tiles, count unique non-blank
 * tiles, and compute `unique / nonBlank`. The grid whose tiles align with the
 * actual text rendering will reuse the same glyph for every occurrence of a
 * character (e.g. one bitmap for every 'e' on screen) → low ratio. Misaligned
 * grids slice character bitmaps into mishmash chunks that mostly differ from
 * cell to cell → high ratio.
 *
 * Lowest ratio wins. Ties prefer the wider grid (stricter alignment is more
 * informative). Returns '32x24' if all grids have too few non-blank cells.
 */
/** Module-level debounce key — only emits a `[OCR] grid` log line when the
 *  picked grid or score class changes, so per-frame calls don't spam. */
let lastGridLogKey = '';
/** Force the next detectGrid call to emit its log line. Reset on activate(). */
let forceGridLog = false;
function resetGridLog(): void { lastGridLogKey = ''; forceGridLog = true; }

export function detectGrid(screenBank: Uint8Array, bankLabel = ''): OcrGridName {
  const tag = bankLabel ? ` [${bankLabel}]` : '';
  const grids = Object.keys(OCR_GRIDS) as OcrGridName[];

  type GridStat = { unique: number; nonBlank: number };
  const stats = new Map<OcrGridName, GridStat>();

  const tmp = new Uint8Array(8);
  for (const key of grids) {
    const config = OCR_GRIDS[key];
    const cellH = config.cellHeight;
    const seen = new Set<string>();
    let nonBlank = 0;
    for (let r = 0; r < config.rows; r++) {
      for (let c = 0; c < config.cols; c++) {
        extractCellGlyph(screenBank, c, r, config, tmp);
        if (isBlankGlyph(tmp, cellH)) continue;
        nonBlank++;
        seen.add(tmp.subarray(0, cellH).join(','));
      }
    }
    stats.set(key, { unique: seen.size, nonBlank });
  }

  // Need at least a handful of non-blank cells in some grid to make a call.
  let maxNonBlank = 0;
  for (const s of stats.values()) maxNonBlank = Math.max(maxNonBlank, s.nonBlank);
  if (maxNonBlank < 4) {
    if (forceGridLog) {
      console.log(
        `[OCR] detect grid${tag} → 32x24 (default; only ${maxNonBlank} non-blank cells across all grids — screen blank)`,
      );
      forceGridLog = false;
      lastGridLogKey = '32x24:sparse';
    }
    return '32x24';
  }

  // Lowest unique/nonBlank ratio = highest tile repetition = best alignment.
  // Tie-break: prefer wider cellWidth (stricter alignment).
  let best: OcrGridName = '32x24';
  let bestRatio = Infinity;
  for (const key of grids) {
    const s = stats.get(key)!;
    if (s.nonBlank < 4) continue;
    const ratio = s.unique / s.nonBlank;
    const wider = OCR_GRIDS[key].cellWidth > OCR_GRIDS[best].cellWidth;
    if (ratio < bestRatio - 0.005 || (Math.abs(ratio - bestRatio) <= 0.005 && wider)) {
      bestRatio = ratio;
      best = key;
    }
  }

  const logKey = `${best}:${bestRatio.toFixed(3)}`;
  if (forceGridLog || logKey !== lastGridLogKey) {
    forceGridLog = false;
    lastGridLogKey = logKey;
    const breakdown = grids.map(g => {
      const s = stats.get(g)!;
      const pct = s.nonBlank > 0 ? Math.round((s.unique / s.nonBlank) * 100) : 0;
      return `${g}: ${s.unique}/${s.nonBlank}=${pct}%`;
    }).join('  ');
    console.log(`[OCR] detect grid${tag} → ${best} (lower% wins) — ${breakdown}`);
  }
  return best;
}

/**
 * Search all RAM banks for a 768-byte font that explains the on-screen glyphs.
 *
 * Strategy:
 * 1. Build a set of unique non-blank glyphs visible on the screen (capped at 128).
 * 2. Walk every byte-aligned 768-byte window across all RAM banks, prefiltered by
 *    "first 8 bytes are zero" (space at code 0x20) plus "at least one capital
 *    letter slot is non-zero".
 * 3. Score each window by the fraction of unique on-screen glyphs that match
 *    any character entry (normal or inverted). Abort early at score ≥ 0.95.
 * 4. Return the best-scoring window if score ≥ 0.5, else null.
 *
 * Cost is bounded by `banks × bankSize × uniqueGlyphs × 96` worst-case, but the
 * prefilter eliminates the vast majority of windows immediately.
 */
export function detectFontFromRam(
  ramBanks: readonly Uint8Array[], screenBank: Uint8Array, config: OcrConfig,
): FontSource | null {
  const cellH = config.cellHeight;
  const mask = bitMaskFor(config.cellWidth);
  const cellW = config.cellWidth;

  // Build histogram of unique on-screen glyphs (as comma-joined strings).
  const glyphMap = new Map<string, Uint8Array>();
  let totalCells = 0;
  let blankCells = 0;
  const tmp = new Uint8Array(8);
  outer: for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      totalCells++;
      extractCellGlyph(screenBank, c, r, config, tmp);
      if (isBlankGlyph(tmp, cellH)) { blankCells++; continue; }
      const key = tmp.subarray(0, cellH).join(',');
      if (!glyphMap.has(key)) glyphMap.set(key, tmp.slice(0, cellH));
      if (glyphMap.size >= 128) break outer;
    }
  }
  console.log(
    `[OCR] font scan ${cellW}×${cellH}: ${blankCells}/${totalCells} blank cells `
    + `(space anchor), ${glyphMap.size} unique non-blank glyphs to anchor on`,
  );
  if (glyphMap.size < 4) {
    console.log(`[OCR] font scan: aborting — need ≥4 unique glyphs, got ${glyphMap.size}`);
    return null;
  }

  const uniqueGlyphs = Array.from(glyphMap.values());

  let bestScore = 0;
  let bestData: Uint8Array | null = null;
  let bestLabel = '';
  let windowsScanned = 0;
  let windowsScored = 0;

  const aOff = (0x41 - 0x20) * 8;
  const zOff = (0x5A - 0x20) * 8 + 8;

  outerScan: for (let bi = 0; bi < ramBanks.length; bi++) {
    const bank = ramBanks[bi];
    const limit = bank.length - 768;
    for (let off = 0; off <= limit; off++) {
      windowsScanned++;
      if (bank[off] | bank[off + 1] | bank[off + 2] | bank[off + 3]
        | bank[off + 4] | bank[off + 5] | bank[off + 6] | bank[off + 7]) continue;

      let hasLetter = false;
      for (let i = aOff; i < zOff; i++) {
        if (bank[off + i]) { hasLetter = true; break; }
      }
      if (!hasLetter) continue;

      windowsScored++;
      let matches = 0;
      for (const g of uniqueGlyphs) {
        let found = false;
        for (let c = 33; c < 128 && !found; c++) {
          if (c === 0x5F) continue;
          const fb = off + ((c - 32) << 3);
          let m = true;
          for (let p = 0; p < cellH; p++) {
            if ((bank[fb + p] & mask) !== g[p]) { m = false; break; }
          }
          if (m) { found = true; break; }
          m = true;
          for (let p = 0; p < cellH; p++) {
            if (((bank[fb + p] ^ 0xFF) & mask) !== g[p]) { m = false; break; }
          }
          if (m) found = true;
        }
        if (found) matches++;
      }
      const score = matches / uniqueGlyphs.length;
      if (score > bestScore) {
        bestScore = score;
        bestData = bank.slice(off, off + 768);
        bestLabel = `RAM bank ${bi} @${off.toString(16).padStart(4, '0')}`;
        if (score >= 0.95) {
          console.log(
            `[OCR] font scan: early exit at ${bestLabel} — ${matches}/${uniqueGlyphs.length} glyphs `
            + `(${(score * 100).toFixed(0)}%); ${windowsScored}/${windowsScanned} windows scored`,
          );
          break outerScan;
        }
      }
    }
  }

  console.log(
    `[OCR] font scan: ${windowsScanned} windows total, ${windowsScored} passed prefilter (space + letters), `
    + `best: ${bestLabel || '(none)'} ${(bestScore * 100).toFixed(0)}%`,
  );

  if (bestScore >= 0.5 && bestData) {
    return {
      label: `${bestLabel} (${(bestScore * 100).toFixed(0)}%)`,
      data: bestData,
      cellWidth: config.cellWidth,
    };
  }
  console.log(`[OCR] font scan: rejected — best score ${(bestScore * 100).toFixed(0)}% < 50% threshold`);
  return null;
}

/**
 * The OCR engine. Holds an `active` flag used by the UI overlay to decide
 * whether to render transcribed text on top of the canvas; the OCR engine
 * itself always runs when called (so MCP / debug callers don't need to flip
 * the UI on first).
 */
export class ScreenText {
  active = false;
  private lastLogKey = '';

  /** Cached RAM-detected font, keyed by grid cellWidth. Invalidated when a call
   *  with the cached font yields zero matches against the current screen. */
  private cachedRamFont: Map<number, FontSource> = new Map();

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.lastLogKey = '';
    this.cachedRamFont.clear();
    resetGridLog();
    console.log('[OCR] activated');
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.lastLogKey = '';
    this.cachedRamFont.clear();
    console.log('[OCR] deactivated');
  }

  /** Drop the cached RAM-detected font for the given grid (or all grids). */
  invalidateFontCache(cellWidth?: number): void {
    if (cellWidth === undefined) this.cachedRamFont.clear();
    else this.cachedRamFont.delete(cellWidth);
  }

  /**
   * Build the prioritised font list for a given grid configuration.
   *
   * For 8-wide cells the legacy CHARS-sysvar + ROM-font path is used (matches
   * standard ZX BASIC programs). For narrower cells a RAM scan locates the
   * active font heuristically (CP/M Plus, Tasword, …) — cached per grid.
   */
  private buildFonts(
    screenBank: Uint8Array,
    cpuMem: Uint8Array | null,
    ramBanks: readonly Uint8Array[] | null,
    romFont: Uint8Array,
    config: OcrConfig,
    extraFonts?: FontSource[],
  ): FontSource[] {
    const fonts: FontSource[] = [];

    if (config.cellWidth === 8) {
      // 1. CHARS sysvar (only when CPU memory is available)
      if (cpuMem) {
        const charsAddr = cpuMem[0x5C36] | (cpuMem[0x5C37] << 8);
        const charsFontStart = charsAddr + 256;
        if (charsFontStart + 768 <= 65536) {
          const charsData = cpuMem.slice(charsFontStart, charsFontStart + 768);
          let spaceBlank = true;
          for (let i = 0; i < 8; i++) if (charsData[i]) { spaceBlank = false; break; }
          if (spaceBlank && validateFontAgainstScreen(screenBank, charsData, config, 10)) {
            fonts.push({ label: `CHARS @${charsFontStart.toString(16)}`, data: charsData });
          }
        }
      }
      // 2. 48K ROM font
      if (fonts.length === 0 || !fontsEqual(fonts[0].data, romFont)) {
        fonts.push({ label: 'ROM font', data: romFont });
      }
    } else if (ramBanks) {
      // Non-8-wide: heuristic scan, cached per grid until it fails.
      let ramFont = this.cachedRamFont.get(config.cellWidth);
      if (ramFont && !validateFontAgainstScreen(screenBank, ramFont.data, config, 4)) {
        console.log(`[OCR] cached font for ${config.cellWidth}×${config.cellHeight} no longer matches — re-scanning`);
        this.cachedRamFont.delete(config.cellWidth);
        ramFont = undefined;
      }
      if (!ramFont) {
        const detected = detectFontFromRam(ramBanks, screenBank, config);
        if (detected) {
          ramFont = detected;
          this.cachedRamFont.set(config.cellWidth, detected);
          console.log(`[OCR] using font: ${detected.label}`);
        }
      }
      if (ramFont) fonts.push(ramFont);
    }

    if (extraFonts) for (const ef of extraFonts) fonts.push(ef);
    return fonts;
  }

  /**
   * Match a single screen cell against the font list.
   * Returns the matched character, or null if blank / unrecognised.
   * (Blank cells return ' ' so they're treated as matched space.)
   */
  private matchCellFromFonts(
    glyph: Uint8Array, fonts: FontSource[], cellH: number, mask: number, hits: Uint32Array,
  ): string | null {
    if (isBlankGlyph(glyph, cellH)) return ' ';
    for (let fi = 0; fi < fonts.length; fi++) {
      const ch = matchGlyph(glyph, fonts[fi].data, cellH, mask);
      if (ch) { hits[fi]++; return ch; }
    }
    return null;
  }

  /** Log font hit summary (only when it changes). */
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
   * OCR a screen — plain text only. Always runs (independent of the UI
   * `active` flag).
   *
   * @param screenBank 16KB displayed bank (bitmap @0x0000, attrs @0x1800)
   * @param cpuMem     Paged 64K view, used only for CHARS-sysvar font detection
   * @param ramBanks   All RAM banks, used only for non-8-wide font detection
   * @param romFont    768-byte font from the 48K BASIC ROM
   * @param config     Cell-grid configuration
   * @param extraFonts Additional fonts from the fonts pane
   */
  ocr(
    screenBank: Uint8Array,
    cpuMem: Uint8Array | null,
    ramBanks: readonly Uint8Array[] | null,
    romFont: Uint8Array,
    config: OcrConfig,
    extraFonts?: FontSource[],
  ): string {
    const fonts = this.buildFonts(screenBank, cpuMem, ramBanks, romFont, config, extraFonts);
    if (fonts.length === 0) return '';
    const hits = new Uint32Array(fonts.length);
    const cellH = config.cellHeight;
    const mask = bitMaskFor(config.cellWidth);
    const glyph = new Uint8Array(8);
    let text = '';

    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        extractCellGlyph(screenBank, col, row, config, glyph);
        text += this.matchCellFromFonts(glyph, fonts, cellH, mask, hits) ?? ' ';
      }
      if (row < config.rows - 1) text += '\n';
    }

    this.logHits(fonts, hits);
    return text;
  }

  /**
   * OCR a screen — returns plain text + coloured HTML + per-cell match mask.
   *
   * Per-cell ink colour is sampled from the Spectrum attribute file at offset
   * 0x1800 within the screen bank, indexed by the byte-column the cell starts
   * in (`floor(col*cellWidth / 8)`). Attributes are byte-aligned regardless of
   * the OCR grid, so for non-8-wide grids several cells share an attribute.
   */
  ocrStyled(
    screenBank: Uint8Array,
    cpuMem: Uint8Array | null,
    ramBanks: readonly Uint8Array[] | null,
    romFont: Uint8Array,
    palette: Uint32Array,
    flash: boolean,
    grid: OcrGridName = '32x24',
    extraFonts?: FontSource[],
  ): OcrResult {
    const config = OCR_GRIDS[grid];
    const empty: OcrResult = {
      text: '', html: '', mask: [],
      grid,
      cellWidth: config.cellWidth, cellHeight: config.cellHeight,
      cols: config.cols, rows: config.rows,
    };
    const fonts = this.buildFonts(screenBank, cpuMem, ramBanks, romFont, config, extraFonts);
    if (fonts.length === 0) return empty;

    const hits = new Uint32Array(fonts.length);
    const css: string[] = [];
    for (let i = 0; i < 16; i++) css.push(abgrToHex(palette[i]));

    const cellW = config.cellWidth;
    const cellH = config.cellHeight;
    const mask = bitMaskFor(cellW);
    const xOffset = config.xOffset ?? 0;
    const glyph = new Uint8Array(8);
    let text = '';
    let html = '';
    const cellMask: boolean[] = new Array(config.cols * config.rows);
    let spanOpen = false;
    let curInk = -1;

    for (let row = 0; row < config.rows; row++) {
      // Map this OCR row to the closest 8-pixel attribute row.
      const pixelY = row * cellH + (config.yOffset ?? 0);
      const attrRow = Math.min(23, Math.max(0, pixelY >> 3));
      const attrBase = 0x1800 + attrRow * 32;

      for (let col = 0; col < config.cols; col++) {
        const idx = row * config.cols + col;
        extractCellGlyph(screenBank, col, row, config, glyph);
        const ch = this.matchCellFromFonts(glyph, fonts, cellH, mask, hits);
        text += ch ?? ' ';
        cellMask[idx] = ch !== null;

        if (ch === null) {
          if (spanOpen) { html += '</span>'; spanOpen = false; curInk = -1; }
          html += ' ';
        } else {
          const attrByteCol = Math.min(31, (col * cellW + xOffset) >> 3);
          const attr = screenBank[attrBase + attrByteCol];
          const bright = (attr & 0x40) ? 8 : 0;
          let ink = (attr & 0x07) + bright;
          let paper = ((attr >> 3) & 0x07) + bright;
          if ((attr & 0x80) && flash) { const t = ink; ink = paper; paper = t; }

          if (ink !== curInk) {
            if (spanOpen) html += '</span>';
            html += `<span style="color:${css[ink]}">`;
            curInk = ink;
            spanOpen = true;
          }
          html += escapeHtml(ch);
        }
      }
      if (spanOpen) { html += '</span>'; spanOpen = false; curInk = -1; }
      text += row < config.rows - 1 ? '\n' : '';
      html += row < config.rows - 1 ? '\n' : '';
    }

    // Auto-invalidate cache: if non-8-wide grid produced zero matches, drop the cache.
    if (config.cellWidth !== 8) {
      let totalHits = 0;
      for (let i = 0; i < hits.length; i++) totalHits += hits[i];
      if (totalHits === 0) this.cachedRamFont.delete(config.cellWidth);
    }

    this.logHits(fonts, hits);
    return {
      text, html, mask: cellMask,
      grid,
      cellWidth: cellW, cellHeight: cellH,
      cols: config.cols, rows: config.rows,
    };
  }
}
