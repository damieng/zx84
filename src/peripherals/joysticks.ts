/**
 * Joystick peripherals: Kempston hardware + keyboard-mapped modes
 * (Cursor, Sinclair 1 & 2).
 *
 * Keyboard-mapped modes press Spectrum matrix keys that correspond to
 * the joystick directions.  Cursor mode additionally holds Caps Shift.
 */

import type { Spectrum } from '@/spectrum.ts';

// ── Kempston joystick ────────────────────────────────────────────────────
// Bits: 0=right, 1=left, 2=down, 3=up, 4=fire.
// Port read at (port & 0x00E0) === 0 returns `state`.

export const KEMPSTON_BITS: Record<string, number> = {
  right: 0, left: 1, down: 2, up: 3, fire: 4,
};

export class KempstonJoystick {
  /** 8-bit port value read by the Z80 */
  state = 0;

  press(dir: string, pressed: boolean): void {
    const bit = KEMPSTON_BITS[dir];
    if (bit === undefined) return;
    if (pressed) {
      this.state |= (1 << bit);
    } else {
      this.state &= ~(1 << bit);
    }
  }

  reset(): void {
    this.state = 0;
  }
}

// ── Keyboard-mapped joystick modes ───────────────────────────────────────

export const CURSOR_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 4 },
  down:  { row: 4, bit: 4 },
  up:    { row: 4, bit: 3 },
  right: { row: 4, bit: 2 },
  fire:  { row: 4, bit: 0 },
};

export const SINCLAIR2_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 0 },
  right: { row: 3, bit: 1 },
  down:  { row: 3, bit: 2 },
  up:    { row: 3, bit: 3 },
  fire:  { row: 3, bit: 4 },
};

export const SINCLAIR1_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 4, bit: 4 },
  right: { row: 4, bit: 3 },
  down:  { row: 4, bit: 2 },
  up:    { row: 4, bit: 1 },
  fire:  { row: 4, bit: 0 },
};

// Track how many cursor-joystick directions are currently held,
// so Caps Shift stays pressed until all are released.
let cursorShiftCount = 0;

export function joyPressForType(spectrum: Spectrum, dir: string, pressed: boolean, mode: string): void {
  if (mode === 'none') return;

  if (mode === 'kempston') {
    spectrum.joystick.press(dir, pressed);
  } else {
    const map = mode === 'cursor' ? CURSOR_KEYS
              : mode === 'sinclair2' ? SINCLAIR2_KEYS
              : SINCLAIR1_KEYS;
    const key = map[dir];
    if (key) {
      spectrum.keyboard.setKey(key.row, key.bit, pressed);
      // Cursor joystick requires Caps Shift held with the number keys
      if (mode === 'cursor') {
        cursorShiftCount += pressed ? 1 : -1;
        if (cursorShiftCount < 0) cursorShiftCount = 0;
        spectrum.keyboard.setKey(0, 0, cursorShiftCount > 0);
      }
    }
  }
}
