/**
 * Screen OCR — bitmap-level character recognition for the ZX Spectrum display.
 *
 * Compares each 8×8 character cell in the display file against the ROM
 * character set to produce a 32×24 text representation of the screen.
 */

export class ScreenText {
  /**
   * Compare each 8×8 screen cell against the CHARS character set.
   * Returns a 32×24 text string (with newlines) of recognised characters.
   */
  ocr(mem: Uint8Array): string {
    const chars = mem[0x5C36] | (mem[0x5C37] << 8);
    let text = '';

    for (let charRow = 0; charRow < 24; charRow++) {
      const third = charRow >> 3;
      const rowInThird = charRow & 7;

      for (let charCol = 0; charCol < 32; charCol++) {
        const base = 0x4000 + (third << 11) + (rowInThird << 5) + charCol;

        // Fast path: all-zero cell → space
        const b0 = mem[base];
        if (b0 === 0) {
          let allZero = true;
          for (let p = 1; p < 8; p++) {
            if (mem[base + (p << 8)] !== 0) { allZero = false; break; }
          }
          if (allZero) { text += ' '; continue; }
        }

        // Compare against CHARS (codes 33-127, space already handled)
        let ch = '';
        for (let c = 33; c < 128; c++) {
          const cb = chars + (c << 3);
          let match = true;
          for (let p = 0; p < 8; p++) {
            if (mem[base + (p << 8)] !== mem[cb + p]) { match = false; break; }
          }
          if (match) {
            ch = c === 0x5E ? '\u2191' : c === 0x60 ? '\u00A3' : c === 0x7F ? '\u00A9'
               : String.fromCharCode(c);
            break;
          }
        }

        // Try inverted match (INVERSE video)
        if (!ch) {
          for (let c = 33; c < 128; c++) {
            const cb = chars + (c << 3);
            let match = true;
            for (let p = 0; p < 8; p++) {
              if (mem[base + (p << 8)] !== (mem[cb + p] ^ 0xFF)) { match = false; break; }
            }
            if (match) {
              ch = c === 0x5E ? '\u2191' : c === 0x60 ? '\u00A3' : c === 0x7F ? '\u00A9'
                 : String.fromCharCode(c);
              break;
            }
          }
        }

        text += ch || ' ';
      }

      if (charRow < 23) text += '\n';
    }

    return text;
  }
}
