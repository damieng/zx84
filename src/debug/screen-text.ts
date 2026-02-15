/**
 * Screen text capture and OCR.
 *
 * Mirrors the ZX Spectrum's 32×24 character display by intercepting RST 16
 * print calls and tracking ROM screen-management routines (CLS, scroll, etc.).
 * Also provides bitmap-level OCR as a fallback for programs that write directly
 * to the display file.
 */

/**
 * ZX Spectrum character set → Unicode mapping for codes 0x80-0xFF.
 * 0x80-0x8F: 2×2 block graphics (Unicode Block Elements)
 * 0x90-0xA4: UDGs A-U (rendered as circled letters)
 * 0xA5-0xFF: BASIC keyword tokens
 */
const SPECTRUM_CHARS: string[] = [
  // 0x80-0x8F: block graphics (bit pattern: b0=TL, b1=TR, b2=BL, b3=BR)
  ' ',  '\u2598', '\u259D', '\u2580', '\u2596', '\u258C', '\u259E', '\u259B',
  '\u2597', '\u259A', '\u2590', '\u259C', '\u2584', '\u2599', '\u259F', '\u2588',
  // 0x90-0xA4: UDGs A-U
  '\u24B6', '\u24B7', '\u24B8', '\u24B9', '\u24BA', '\u24BB', '\u24BC', '\u24BD',
  '\u24BE', '\u24BF', '\u24C0', '\u24C1', '\u24C2', '\u24C3', '\u24C4', '\u24C5',
  '\u24C6', '\u24C7', '\u24C8', '\u24C9', '\u24CA',
  // 0xA5-0xFF: BASIC keyword tokens
  'RND', 'INKEY$', 'PI', 'FN ', 'POINT ', 'SCREEN$ ', 'ATTR ', 'AT ', 'TAB ',
  'VAL$ ', 'CODE ', 'VAL ', 'LEN ', 'SIN ', 'COS ', 'TAN ', 'ASN ', 'ACS ',
  'ATN ', 'LN ', 'EXP ', 'INT ', 'SQR ', 'SGN ', 'ABS ', 'PEEK ', 'IN ',
  'USR ', 'STR$ ', 'CHR$ ', 'NOT ', 'BIN ',
  'OR ', 'AND ', '<=', '>=', '<>', 'LINE ', 'THEN ', 'TO ', 'STEP ',
  'DEF FN ', 'CAT ', 'FORMAT ', 'MOVE ', 'ERASE ', 'OPEN #', 'CLOSE #',
  'MERGE ', 'VERIFY ', 'BEEP ', 'CIRCLE ', 'INK ', 'PAPER ', 'FLASH ',
  'BRIGHT ', 'INVERSE ', 'OVER ', 'OUT ',
  'LPRINT ', 'LLIST ', 'STOP ', 'READ ', 'DATA ', 'RESTORE ', 'NEW ',
  'BORDER ', 'CONTINUE ', 'DIM ', 'REM ', 'FOR ', 'GO TO ', 'GO SUB ',
  'INPUT ', 'LOAD ', 'LIST ', 'LET ', 'PAUSE ', 'NEXT ', 'POKE ', 'PRINT ',
  'PLOT ', 'RUN ', 'SAVE ', 'RANDOMIZE ', 'IF ', 'CLS ', 'DRAW ', 'CLEAR ',
  'RETURN ', 'COPY ',
];

export class ScreenText {
  /** 32x24 character grid mirroring what RST 16 prints to the display */
  screenGrid: string[] = new Array(768).fill(' ');
  private screenSkipCount = 0;

  /** Capture a character from RST 16 (A register value) into the 32x24 screen grid. */
  captureChar(a: number, mem: Uint8Array): void {
    // Skip parameter bytes for control codes
    if (this.screenSkipCount > 0) {
      this.screenSkipCount--;
      return;
    }

    if (a === 0x0D) {
      // Carriage return — position change handled by ROM, no grid update needed
    } else if ((a >= 0x20 && a <= 0x7F) || a >= 0x80) {
      // Printable character — read print position from the active screen channel.
      // Upper screen (channel 'S') uses S_POSN at 0x5C88-89.
      // Lower screen (channel 'K') uses DFCCL at 0x5C86-87 — the display file
      // address directly encodes row/col via the Spectrum's interleaved layout.
      const curchl = mem[0x5C51] | (mem[0x5C52] << 8);
      const isLower = curchl >= 0x5C00 && curchl < 0xFFFC && mem[curchl + 4] === 0x4B; // 'K'

      let actualCol: number, actualRow: number;
      if (isLower) {
        // Decode position from DFCCL display file address
        const dfccl = mem[0x5C86] | (mem[0x5C87] << 8);
        const rel = dfccl - 0x4000;
        const third = (rel >> 11) & 3;       // screen third (0-2)
        const rowInThird = (rel >> 5) & 7;   // character row within third
        actualRow = third * 8 + rowInThird;
        actualCol = rel & 0x1F;
      } else {
        const col = mem[0x5C88];   // S_POSN column (33 = leftmost, 2 = rightmost)
        const line = mem[0x5C89]; // S_POSN line (24 = top, 1 = bottom)
        actualCol = 33 - col;
        actualRow = 24 - line;
      }

      // When the K channel writes at column 0, the ROM has cleared and reset the
      // editing area — clear the grid rows from here downward so stale text is removed.
      if (isLower && actualCol === 0) {
        const dfSz = mem[0x5C6B] || 2;
        if (actualRow >= 24 - dfSz) {
          this.screenGrid.fill(' ', actualRow * 32, 24 * 32);
        }
      }

      if (actualCol >= 0 && actualCol <= 31 && actualRow >= 0 && actualRow <= 23) {
        let ch: string;
        if (a >= 0x80) {
          ch = SPECTRUM_CHARS[a - 0x80];
          // Tokens expand to multiple chars — only store first char in grid cell
          if (ch.length > 1) ch = ch[0];
        } else if (a === 0x5E) {
          ch = '\u2191'; // ↑ instead of ^
        } else if (a === 0x60) {
          ch = '\u00A3'; // £ instead of `
        } else if (a === 0x7F) {
          ch = '\u00A9'; // © instead of DEL
        } else {
          ch = String.fromCharCode(a);
        }
        this.screenGrid[actualRow * 32 + actualCol] = ch;
      }
    } else if (a <= 0x1F) {
      // Control codes — set skip count for parameter bytes
      // AT (0x16) and TAB (0x17) take 2 parameter bytes
      // INK (0x10), PAPER (0x11), FLASH (0x12), BRIGHT (0x13),
      // INVERSE (0x14), OVER (0x15) take 1 parameter byte
      if (a === 0x16 || a === 0x17) {
        this.screenSkipCount = 2;
      } else if (a >= 0x10 && a <= 0x15) {
        this.screenSkipCount = 1;
      }
    }
  }

  /**
   * Check ROM screen-management routines and keep the grid in sync.
   * Called each instruction with the current PC, memory, and BC register.
   */
  checkROMRoutines(pc: number, mem: Uint8Array, bc: number): void {
    if (pc === 0x0DAF) {
      // CL_ALL — clear entire display
      this.screenGrid.fill(' ');
    } else if (pc === 0x0D6E) {
      // CLS_LOWER — clear bottom DF_SZ lines only
      const dfSz = mem[0x5C6B] || 2;
      this.screenGrid.fill(' ', (24 - dfSz) * 32, 24 * 32);
    } else if (pc === 0x0DFE) {
      // CL_SC_ALL — scroll upper screen up one line
      const dfSz = mem[0x5C6B] || 2;
      const upperRows = 24 - dfSz;
      for (let i = 0; i < (upperRows - 1) * 32; i++) {
        this.screenGrid[i] = this.screenGrid[i + 32];
      }
      this.screenGrid.fill(' ', (upperRows - 1) * 32, upperRows * 32);
    } else if (pc === 0x0E00) {
      // CL_SCROLL — general scroll. Skip B=0x17 (handled by 0x0DFE above).
      const b = (bc >> 8) & 0xFF;
      if (b !== 0x17 && b > 0 && b <= 24) {
        const startRow = 24 - b;
        for (let i = startRow * 32; i < 23 * 32; i++) {
          this.screenGrid[i] = this.screenGrid[i + 32];
        }
        this.screenGrid.fill(' ', 23 * 32, 24 * 32);
      }
    }
  }

  /**
   * Check for LDIR clearing screen memory. Needs the current DE and BC register values.
   */
  checkLDIRClear(pc: number, mem: Uint8Array, de: number, bc: number): void {
    if (mem[pc] === 0xED && mem[(pc + 1) & 0xFFFF] === 0xB0) {
      if (de >= 0x4000 && de <= 0x4001 && bc >= 0x1700) {
        this.screenGrid.fill(' ');
      }
    }
  }

  getText(): string {
    const lines: string[] = [];
    for (let row = 0; row < 24; row++) {
      const offset = row * 32;
      let line = '';
      for (let col = 0; col < 32; col++) {
        line += this.screenGrid[offset + col];
      }
      lines.push(line.trimEnd());
    }
    return lines.join('\n');
  }

  clear(): void {
    this.screenGrid.fill(' ');
    this.screenSkipCount = 0;
  }

  /**
   * OCR fallback: compare each 8×8 screen cell against the CHARS character set.
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
