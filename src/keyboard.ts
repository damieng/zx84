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
  'ShiftRight':   { row: 7, bit: 1 },  // SYM SHIFT (RShift = symbol access)
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
  'Delete':       [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],  // SHIFT + 0 (DELETE)
  'ArrowLeft':    [{ row: 0, bit: 0 }, { row: 3, bit: 4 }],  // SHIFT + 5
  'ArrowDown':    [{ row: 0, bit: 0 }, { row: 4, bit: 4 }],  // SHIFT + 6
  'ArrowUp':      [{ row: 0, bit: 0 }, { row: 4, bit: 3 }],  // SHIFT + 7
  'ArrowRight':   [{ row: 0, bit: 0 }, { row: 4, bit: 2 }],  // SHIFT + 8
  'CapsLock':     [{ row: 0, bit: 0 }, { row: 3, bit: 1 }],  // SHIFT + 2 (CAPS LOCK)
  'Tab':          [{ row: 0, bit: 0 }, { row: 3, bit: 0 }],  // SHIFT + 1 (EDIT)
  'Escape':       [{ row: 0, bit: 0 }, { row: 7, bit: 0 }],  // SHIFT + SPACE (BREAK)
};

// Symbol character → Spectrum key combo (SYM SHIFT + key)
// For PC keys that don't exist on the Spectrum keyboard.
const SS: KeyMapping = { row: 7, bit: 1 };  // Symbol Shift
const CS: KeyMapping = { row: 0, bit: 0 };  // Caps Shift

const CHAR_MAP: Record<string, ComboMapping> = {
  // Punctuation — SYM SHIFT + key
  ',':  [SS, { row: 7, bit: 3 }],  // SYM + N
  '.':  [SS, { row: 7, bit: 2 }],  // SYM + M
  ';':  [SS, { row: 5, bit: 1 }],  // SYM + O
  ':':  [SS, { row: 0, bit: 1 }],  // SYM + Z
  "'":  [SS, { row: 4, bit: 3 }],  // SYM + 7
  '"':  [SS, { row: 5, bit: 0 }],  // SYM + P
  '?':  [SS, { row: 0, bit: 3 }],  // SYM + C
  '/':  [SS, { row: 0, bit: 4 }],  // SYM + V
  '*':  [SS, { row: 7, bit: 4 }],  // SYM + B
  '!':  [SS, { row: 3, bit: 0 }],  // SYM + 1
  '@':  [SS, { row: 3, bit: 1 }],  // SYM + 2
  '#':  [SS, { row: 3, bit: 2 }],  // SYM + 3
  '$':  [SS, { row: 3, bit: 3 }],  // SYM + 4
  '%':  [SS, { row: 3, bit: 4 }],  // SYM + 5
  '&':  [SS, { row: 4, bit: 4 }],  // SYM + 6
  '(':  [SS, { row: 4, bit: 2 }],  // SYM + 8
  ')':  [SS, { row: 4, bit: 1 }],  // SYM + 9
  '-':  [SS, { row: 6, bit: 3 }],  // SYM + J
  '+':  [SS, { row: 6, bit: 2 }],  // SYM + K
  '=':  [SS, { row: 6, bit: 1 }],  // SYM + L
  '_':  [SS, { row: 4, bit: 0 }],  // SYM + 0
  '<':  [SS, { row: 2, bit: 3 }],  // SYM + R
  '>':  [SS, { row: 2, bit: 4 }],  // SYM + T
  '^':  [SS, { row: 6, bit: 4 }],  // SYM + H
  '~':  [SS, { row: 1, bit: 0 }],  // SYM + A
  '|':  [SS, { row: 1, bit: 1 }],  // SYM + S
  '\\': [SS, { row: 1, bit: 2 }],  // SYM + D
  '{':  [SS, { row: 1, bit: 3 }],  // SYM + F
  '}':  [SS, { row: 1, bit: 4 }],  // SYM + G
  // 128K extended mode
  '[':  [CS, SS, { row: 5, bit: 4 }],  // EXT + Y
  ']':  [CS, SS, { row: 5, bit: 3 }],  // EXT + U
};

export class SpectrumKeyboard {
  /** 8 half-row bytes, bits 0-4, active low (0 = pressed) */
  rows: Uint8Array;

  /** Track active CHAR_MAP combos by physical key code for correct release */
  private activeCharCombos = new Map<string, { combo: ComboMapping; suppressedCS: boolean }>();

  /** Count of physical Shift keys currently held (ShiftLeft only — ShiftRight is SYM SHIFT) */
  private physicalShiftCount = 0;

  /**
   * Keys deferred from combo presses — the modifier goes down immediately, and
   * the remaining keys land one frame later so the Spectrum's scan always sees
   * the modifier first.  Cleared by processPending() each frame.
   */
  private pendingKeys: KeyMapping[] = [];

  /**
   * Reference count per [row][bit].  Multiple sources can press the same bit
   * (e.g. physical Shift + Backspace combo both press CS).  The bit only
   * releases when the count drops to zero.
   */
  private pressCount: number[][];

  constructor() {
    this.rows = new Uint8Array(8);
    this.rows.fill(0xFF);
    this.pressCount = Array.from({ length: 8 }, () => Array(5).fill(0));
  }

  reset(): void {
    this.rows.fill(0xFF);
    this.activeCharCombos.clear();
    this.physicalShiftCount = 0;
    this.pendingKeys = [];
    for (const row of this.pressCount) row.fill(0);
  }

  /**
   * Apply deferred combo keys.  Call once per frame (start of runFrame) so
   * that the modifier pressed on keydown is visible for one full scan before
   * the main key appears.
   */
  processPending(): void {
    for (const k of this.pendingKeys) this.setKey(k.row, k.bit, true);
    this.pendingKeys = [];
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
      this.pressCount[row][bit]++;
      this.rows[row] &= ~(1 << bit);
    } else {
      this.pressCount[row][bit] = Math.max(0, this.pressCount[row][bit] - 1);
      if (this.pressCount[row][bit] === 0) {
        this.rows[row] |= (1 << bit);
      }
    }
  }

  /**
   * Temporarily suppress a bit (force release) without affecting the press
   * count.  Used by CHAR_MAP handling to hide CAPS SHIFT while a symbol
   * combo is active, without confusing the reference count.
   */
  private suppressBit(row: number, bit: number): void {
    this.rows[row] |= (1 << bit);
  }

  /**
   * Restore a previously suppressed bit — re-asserts it only if the press
   * count says something is still holding it.
   */
  private restoreBit(row: number, bit: number): void {
    if (this.pressCount[row][bit] > 0) {
      this.rows[row] &= ~(1 << bit);
    }
  }

  /** Check if CAPS SHIFT is currently pressed (row 0, bit 0 active-low). */
  private get capsShiftPressed(): boolean {
    return (this.rows[0] & 1) === 0;
  }

  handleKeyEvent(code: string, pressed: boolean, key?: string): boolean {
    // Track physical Shift state so we know whether to restore CS on combo release.
    // Only track ShiftLeft — ShiftRight now maps to SYM SHIFT, not CAPS SHIFT.
    if (code === 'ShiftLeft') {
      this.physicalShiftCount = Math.max(0, this.physicalShiftCount + (pressed ? 1 : -1));
    }

    // On key release, use the stored combo from keydown so we release the
    // correct keys even if Shift state changed between press and release.
    if (!pressed) {
      const stored = this.activeCharCombos.get(code);
      if (stored) {
        for (const k of stored.combo) this.setKey(k.row, k.bit, false);
        // Restore CAPS SHIFT only if physical Shift is still held.
        // If Shift was released before this key, CS was already cleared by the
        // ShiftLeft/Right keyup event; restoring it here would leave CS stuck.
        if (stored.suppressedCS && this.physicalShiftCount > 0) this.restoreBit(0, 0);
        this.activeCharCombos.delete(code);
        return true;
      }
    }

    // Check character map for symbol keys (';', '-', ',', etc.)
    // Skip CHAR_MAP for digit keys — Shift+number has Spectrum meanings
    // (EDIT, CAPS LOCK, TRUE VIDEO, etc.) that must not be intercepted by
    // the symbol characters those PC keys produce (!@#$%^&*()).
    const isDigitKey = code.startsWith('Digit');
    const charMapping = (key && !isDigitKey) ? CHAR_MAP[key] : undefined;
    if (charMapping) {
      if (pressed) {
        // If CAPS SHIFT is pressed (from physical Shift) but this combo
        // doesn't need it, suppress CS to avoid entering extended mode.
        const comboNeedsCS = charMapping.some(k => k.row === 0 && k.bit === 0);
        const suppressCS = this.capsShiftPressed && !comboNeedsCS;
        if (suppressCS) this.suppressBit(0, 0);
        this.activeCharCombos.set(code, { combo: charMapping, suppressedCS: suppressCS });
      }
      for (const k of charMapping) this.setKey(k.row, k.bit, pressed);
      return true;
    }

    const mapping = KEY_MAP[code];
    if (!mapping) return false;

    if (Array.isArray(mapping)) {
      if (pressed) {
        // Stagger: press the modifier (first key) immediately, defer the rest
        // by one frame so the Spectrum's keyboard scan always sees the modifier
        // first.  This prevents e.g. Backspace (SHIFT+0) registering as just 0.
        this.setKey(mapping[0].row, mapping[0].bit, true);
        for (let ci = 1; ci < mapping.length; ci++) this.pendingKeys.push(mapping[ci]);
      } else {
        for (const k of mapping) this.setKey(k.row, k.bit, false);
      }
    } else {
      this.setKey(mapping.row, mapping.bit, pressed);
    }
    return true;
  }
}
