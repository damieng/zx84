/**
 * Kempston mouse peripheral.
 *
 * Ports (active when enabled, low byte = 0xDF):
 *   0xFBDF → X position (8-bit wrapping counter)
 *   0xFFDF → Y position (8-bit wrapping counter)
 *   0xFADF → Buttons (active-low)
 */

export class KempstonMouse {
  x = 0;
  y = 0;
  /** Active-low: all bits set = all released */
  buttons = 0xFF;
  enabled = false;

  updatePosition(dx: number, dy: number): void {
    this.x = (this.x + dx) & 0xFF;
    this.y = (this.y + dy) & 0xFF;
  }

  /** Active-low button mapping: 0=left(bit0), 1=middle(bit2), 2=right(bit1) */
  private static BUTTON_BITS: Record<number, number> = { 0: 0, 1: 2, 2: 1 };

  setButton(button: number, pressed: boolean): void {
    const bit = KempstonMouse.BUTTON_BITS[button];
    if (bit === undefined) return;
    if (pressed) {
      this.buttons &= ~(1 << bit);
    } else {
      this.buttons |= (1 << bit);
    }
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.buttons = 0xFF;
    // Note: enabled is not reset — it's a user setting, not machine state
  }
}
