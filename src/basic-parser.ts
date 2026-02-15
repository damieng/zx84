/**
 * ZX Spectrum BASIC parser and detokenizer.
 * Reads tokenized BASIC from memory and converts to readable text.
 */

// Token table for ZX Spectrum BASIC (0x86-0xDF)
// Based on ZX Spectrum 48K ROM disassembly
const TOKENS: Record<number, string> = {
  // Functions (0x86-0xA4)
  0x86: 'RND',
  0x87: 'INKEY$',
  0x88: 'PI',
  0x89: 'FN',
  0x8A: 'POINT',
  0x8B: 'SCREEN$',
  0x8C: 'ATTR',
  0x8D: 'AT',
  0x8E: 'TAB',
  0x8F: 'VAL$',
  0x90: 'CODE',
  0x91: 'VAL',
  0x92: 'LEN',
  0x93: 'SIN',
  0x94: 'COS',
  0x95: 'TAN',
  0x96: 'ASN',
  0x97: 'ACS',
  0x98: 'ATN',
  0x99: 'LN',
  0x9A: 'EXP',
  0x9B: 'INT',
  0x9C: 'SQR',
  0x9D: 'SGN',
  0x9E: 'ABS',
  0x9F: 'PEEK',
  0xA0: 'IN',
  0xA1: 'USR',
  0xA2: 'STR$',
  0xA3: 'CHR$',
  0xA4: 'NOT',
  // Operators and Keywords (0xA5-0xDF)
  0xA5: 'BIN',
  0xA6: 'OR',
  0xA7: 'AND',
  0xA8: '<=',
  0xA9: '>=',
  0xAA: '<>',
  0xAB: 'LINE',
  0xAC: 'THEN',
  0xAD: 'TO',
  0xAE: 'STEP',
  0xAF: 'DEF FN',
  0xB0: 'CAT',
  0xB1: 'FORMAT',
  0xB2: 'MOVE',
  0xB3: 'ERASE',
  0xB4: 'OPEN #',
  0xB5: 'CLOSE #',
  0xB6: 'MERGE',
  0xB7: 'VERIFY',
  0xB8: 'BEEP',
  0xB9: 'CIRCLE',
  0xBA: 'INK',
  0xBB: 'PAPER',
  0xBC: 'FLASH',
  0xBD: 'BRIGHT',
  0xBE: 'INVERSE',
  0xBF: 'OVER',
  0xC0: 'OUT',
  0xC1: 'LPRINT',
  0xC2: 'LLIST',
  0xC3: 'STOP',
  0xC4: 'READ',
  0xC5: 'DATA',
  0xC6: 'RESTORE',
  0xC7: 'NEW',
  0xC8: 'BORDER',
  0xC9: 'CONTINUE',
  0xCA: 'DIM',
  0xCB: 'REM',
  0xCC: 'FOR',
  0xCD: 'GO TO',
  0xCE: 'GO SUB',
  0xCF: 'INPUT',
  0xD0: 'LOAD',
  0xD1: 'LIST',
  0xD2: 'LET',
  0xD3: 'PAUSE',
  0xD4: 'NEXT',
  0xD5: 'POKE',
  0xD6: 'PRINT',
  0xD7: 'PLOT',
  0xD8: 'RUN',
  0xD9: 'SAVE',
  0xDA: 'RANDOMIZE',
  0xDB: 'IF',
  0xDC: 'CLS',
  0xDD: 'DRAW',
  0xDE: 'CLEAR',
  0xDF: 'RETURN',
  0xE0: 'COPY',
};

/**
 * Parse a ZX Spectrum 5-byte floating point number.
 * Returns a string representation (we don't need exact FP conversion, just display).
 */
function parseFloatingPoint(data: Uint8Array, offset: number): string {
  // ZX Spectrum FP format: 1 byte exponent + 4 bytes mantissa
  // For display purposes, we'll just show the raw bytes in hex
  // A full FP converter would be complex and isn't needed for viewing
  const bytes = data.slice(offset, offset + 5);
  return `{FP:${Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('')}}`;
}

/**
 * Detokenize a single BASIC line.
 * Returns the line as a string.
 */
function detokenizeLine(data: Uint8Array, offset: number, lineEnd: number): string {
  let result = '';
  let i = offset;

  while (i < lineEnd) {
    const byte = data[i];

    if (byte === 0x0D) {
      // Line terminator
      break;
    } else if (byte === 0x0E) {
      // Inline number: skip the 0x0E, parse 5-byte FP, continue with ASCII
      i++;
      if (i + 5 <= lineEnd) {
        // The number is already in ASCII before the 0x0E marker
        // Just skip the binary FP representation
        i += 5;
      }
    } else if (byte >= 0x86 && byte <= 0xE0) {
      // Token
      const token = TOKENS[byte];
      if (token) {
        result += token;
      } else {
        result += `[${byte.toString(16).toUpperCase()}]`;
      }
      i++;
    } else if (byte >= 0x20 && byte < 0x7F) {
      // Printable ASCII
      result += String.fromCharCode(byte);
      i++;
    } else if (byte === 0x0A) {
      // Newline within REM or string
      result += '↵';
      i++;
    } else {
      // Other control character - show as hex
      result += `[${byte.toString(16).toUpperCase().padStart(2, '0')}]`;
      i++;
    }
  }

  return result;
}

/**
 * Parse a BASIC program from memory.
 * Returns HTML for display.
 */
export function parseBasicProgram(mem: Uint8Array): string {
  // Read PROG and VARS system variables
  const progAddr = mem[0x5C53] | (mem[0x5C54] << 8);
  const varsAddr = mem[0x5C4B] | (mem[0x5C4C] << 8);

  if (progAddr === 0 || varsAddr === 0 || progAddr >= varsAddr || progAddr >= 0x10000) {
    return '<span style="color:#666">(no BASIC program)</span>';
  }

  const lines: string[] = [];
  let offset = progAddr;
  let lineCount = 0;
  const maxLines = 10000; // Safety limit

  while (offset < varsAddr && lineCount < maxLines) {
    // Check for end marker
    if (offset + 4 > varsAddr) break;

    // Read line number (2 bytes, big-endian)
    const lineNumHigh = mem[offset];
    const lineNumLow = mem[offset + 1];

    // 0x80 in high byte marks end of program
    if (lineNumHigh >= 0x80) break;

    const lineNum = (lineNumHigh << 8) | lineNumLow;

    // Read line length (2 bytes, little-endian)
    const lineLen = mem[offset + 2] | (mem[offset + 3] << 8);

    if (lineLen === 0 || offset + 4 + lineLen > varsAddr) break;

    // Detokenize the line
    const lineText = detokenizeLine(mem, offset + 4, offset + 4 + lineLen);

    // Format as HTML with line number
    const lineNumStr = lineNum.toString().padStart(4, ' ');
    lines.push(`<span class="basic-line-num">${lineNumStr}</span> ${escapeHtml(lineText)}`);

    offset += 4 + lineLen;
    lineCount++;
  }

  if (lines.length === 0) {
    return '<span style="color:#666">(empty program)</span>';
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
