/**
 * ZX Spectrum keyboard emulation.
 *
 * 8 half-rows, 5 bits each, active-low.
 * PC keyboard events map to [row, bit] pairs.
 */

// [row, bit] for each ZX Spectrum key
// Row 0: SHIFT, Z, X, C, V         (port 0xFEFE)
// Row 1: A, S, D, F, G             (port 0xFDFE)
// Row 2: Q, W, E, R, T             (port 0xFBFE)
// Row 3: 1, 2, 3, 4, 5             (port 0xF7FE)
// Row 4: 0, 9, 8, 7, 6             (port 0xEFFE)
// Row 5: P, O, I, U, Y             (port 0xDFFE)
// Row 6: ENTER, L, K, J, H         (port 0xBFFE)
// Row 7: SPACE, SYM, M, N, B       (port 0x7FFE)

type KeyMapping = { row: number; bit: number };
type ComboMapping = KeyMapping[];

const KEY_MAP: Record<string, KeyMapping | ComboMapping> = {
  // Row 0: SHIFT, Z, X, C, V
  'ShiftLeft':    { row: 0, bit: 0 },
  'ShiftRight':   { row: 0, bit: 0 },
  'KeyZ':         { row: 0, bit: 1 },
  'KeyX':         { row: 0, bit: 2 },
  'KeyC':         { row: 0, bit: 3 },
  'KeyV':         { row: 0, bit: 4 },

  // Row 1: A, S, D, F, G
  'KeyA':         { row: 1, bit: 0 },
  'KeyS':         { row: 1, bit: 1 },
  'KeyD':         { row: 1, bit: 2 },
  'KeyF':         { row: 1, bit: 3 },
  'KeyG':         { row: 1, bit: 4 },

  // Row 2: Q, W, E, R, T
  'KeyQ':         { row: 2, bit: 0 },
  'KeyW':         { row: 2, bit: 1 },
  'KeyE':         { row: 2, bit: 2 },
  'KeyR':         { row: 2, bit: 3 },
  'KeyT':         { row: 2, bit: 4 },

  // Row 3: 1, 2, 3, 4, 5
  'Digit1':       { row: 3, bit: 0 },
  'Digit2':       { row: 3, bit: 1 },
  'Digit3':       { row: 3, bit: 2 },
  'Digit4':       { row: 3, bit: 3 },
  'Digit5':       { row: 3, bit: 4 },

  // Row 4: 0, 9, 8, 7, 6
  'Digit0':       { row: 4, bit: 0 },
  'Digit9':       { row: 4, bit: 1 },
  'Digit8':       { row: 4, bit: 2 },
  'Digit7':       { row: 4, bit: 3 },
  'Digit6':       { row: 4, bit: 4 },

  // Row 5: P, O, I, U, Y
  'KeyP':         { row: 5, bit: 0 },
  'KeyO':         { row: 5, bit: 1 },
  'KeyI':         { row: 5, bit: 2 },
  'KeyU':         { row: 5, bit: 3 },
  'KeyY':         { row: 5, bit: 4 },

  // Row 6: ENTER, L, K, J, H
  'Enter':        { row: 6, bit: 0 },
  'KeyL':         { row: 6, bit: 1 },
  'KeyK':         { row: 6, bit: 2 },
  'KeyJ':         { row: 6, bit: 3 },
  'KeyH':         { row: 6, bit: 4 },

  // Row 7: SPACE, SYM SHIFT, M, N, B
  'Space':        { row: 7, bit: 0 },
  'ControlLeft':  { row: 7, bit: 1 },  // SYM SHIFT
  'ControlRight': { row: 7, bit: 1 },
  'KeyM':         { row: 7, bit: 2 },
  'KeyN':         { row: 7, bit: 3 },
  'KeyB':         { row: 7, bit: 4 },

  // Convenience mappings (key combos)
  'Backspace':    [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],  // SHIFT + 0 (DELETE)
  'ArrowLeft':    [{ row: 0, bit: 0 }, { row: 3, bit: 4 }],  // SHIFT + 5
  'ArrowDown':    [{ row: 0, bit: 0 }, { row: 4, bit: 4 }],  // SHIFT + 6
  'ArrowUp':      [{ row: 0, bit: 0 }, { row: 4, bit: 3 }],  // SHIFT + 7
  'ArrowRight':   [{ row: 0, bit: 0 }, { row: 4, bit: 2 }],  // SHIFT + 8
  'CapsLock':     [{ row: 0, bit: 0 }, { row: 3, bit: 1 }],  // SHIFT + 2 (CAPS LOCK)
  'Escape':       [{ row: 0, bit: 0 }, { row: 7, bit: 0 }],  // SHIFT + SPACE (BREAK)
};

// Symbol character → Spectrum key combo (SYM SHIFT + key)
// For PC keys that don't exist on the Spectrum keyboard.
const SS: KeyMapping = { row: 7, bit: 1 };  // Symbol Shift
const CS: KeyMapping = { row: 0, bit: 0 };  // Caps Shift

const CHAR_MAP: Record<string, ComboMapping> = {
  ';':  [SS, { row: 5, bit: 1 }],  // SYM + O
  ':':  [SS, { row: 0, bit: 1 }],  // SYM + Z
  "'":  [SS, { row: 4, bit: 3 }],  // SYM + 7
  '#':  [SS, { row: 3, bit: 2 }],  // SYM + 3
  '?':  [SS, { row: 0, bit: 3 }],  // SYM + C
  '@':  [SS, { row: 3, bit: 1 }],  // SYM + 2
  '~':  [SS, { row: 1, bit: 0 }],  // SYM + A
  '{':  [SS, { row: 1, bit: 3 }],  // SYM + F
  '}':  [SS, { row: 1, bit: 4 }],  // SYM + G
  '-':  [SS, { row: 6, bit: 3 }],  // SYM + J
  '+':  [SS, { row: 6, bit: 2 }],  // SYM + K
  '=':  [SS, { row: 6, bit: 1 }],  // SYM + L
  '_':  [SS, { row: 4, bit: 0 }],  // SYM + 0
  '[':  [CS, SS, { row: 5, bit: 4 }],  // EXT + Y (128K extended mode)
  ']':  [CS, SS, { row: 5, bit: 3 }],  // EXT + U (128K extended mode)
};

export class SpectrumKeyboard {
  /** 8 half-row bytes, bits 0-4, active low (0 = pressed) */
  rows: Uint8Array;

  constructor() {
    this.rows = new Uint8Array(8);
    this.rows.fill(0xFF);
  }

  reset(): void {
    this.rows.fill(0xFF);
  }

  /**
   * Read half-rows selected by the high byte of the port address.
   * Multiple rows can be selected at once (active low address lines).
   */
  readHalfRows(highByte: number): number {
    let result = 0xFF;
    for (let row = 0; row < 8; row++) {
      if ((highByte & (1 << row)) === 0) {
        result &= this.rows[row];
      }
    }
    return result & 0x1F;
  }

  setKey(row: number, bit: number, pressed: boolean): void {
    if (pressed) {
      this.rows[row] &= ~(1 << bit);
    } else {
      this.rows[row] |= (1 << bit);
    }
  }

  handleKeyEvent(code: string, pressed: boolean, key?: string): boolean {
    // Check character map first for symbol keys (';', ':', etc.)
    // but only when the code-based map doesn't have a direct match,
    // or the code maps to a modifier that the char map would override.
    const charMapping = key ? CHAR_MAP[key] : undefined;
    if (charMapping) {
      for (const k of charMapping) this.setKey(k.row, k.bit, pressed);
      return true;
    }

    const mapping = KEY_MAP[code];
    if (!mapping) return false;

    if (Array.isArray(mapping)) {
      for (const k of mapping) this.setKey(k.row, k.bit, pressed);
    } else {
      this.setKey(mapping.row, mapping.bit, pressed);
    }
    return true;
  }
}
