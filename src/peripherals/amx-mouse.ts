/**
 * AMX mouse peripheral with Z80-PIO interrupt-driven movement delivery.
 *
 * Ports (active when enabled, active when A7=0):
 *   0x1F → X direction (bit 0: 0=right, 1=left)
 *   0x3F → Y direction (bit 0: 0=up, 1=down)
 *   0x5F → Port A PIO control
 *   0x7F → Port B PIO control
 *   0xDF → Buttons (active-low: bit 6=LMB, bit 5=MMB, bit 7=RMB)
 *
 * Movement is queued as pending steps and drained via PIO interrupts
 * spread evenly across the frame.
 */

import type { Z80 } from '@/cores/Z80.ts';
import type { IOActivity } from '@/spectrum.ts';

type PioCtrlState = 'normal' | 'await_io' | 'await_int';

export class AmxMouse {
  enabled = false;
  /** Active-low: bits 7=LMB, 6=MMB, 5=RMB */
  buttons = 0xFF;
  /** Current X direction bit (bit 0 of port 0x1F) */
  dirX = 0;
  /** Current Y direction bit (bit 0 of port 0x3F) */
  dirY = 0;
  /** IM2 interrupt vector for X axis (port A) */
  pioVectorA = 0;
  /** IM2 interrupt vector for Y axis (port B) */
  pioVectorB = 0;
  /** Queued X movement steps (positive=right) */
  pendingX = 0;
  /** Queued Y movement steps (positive=down) */
  pendingY = 0;
  /** PIO control state machine */
  private pioCtrlStateA: PioCtrlState = 'normal';
  private pioCtrlStateB: PioCtrlState = 'normal';

  /** Active-low button mapping: 0=LMB(bit6), 1=MMB(bit5), 2=RMB(bit7) */
  private static BUTTON_BITS: Record<number, number> = { 0: 6, 1: 5, 2: 7 };

  /** Handle a write to AMX PIO control port (0x5F for A, 0x7F for B). */
  pioControlWrite(port: 'A' | 'B', val: number): void {
    const state = port === 'A' ? this.pioCtrlStateA : this.pioCtrlStateB;
    if (state === 'await_io') {
      // I/O direction mask -- consume and return to normal
      if (port === 'A') this.pioCtrlStateA = 'normal'; else this.pioCtrlStateB = 'normal';
      return;
    }
    if (state === 'await_int') {
      // Interrupt mask -- consume and return to normal
      if (port === 'A') this.pioCtrlStateA = 'normal'; else this.pioCtrlStateB = 'normal';
      return;
    }
    // Normal state: decode control word
    if ((val & 1) === 0) {
      // Bit 0 = 0: interrupt vector
      if (port === 'A') this.pioVectorA = val & 0xFE; else this.pioVectorB = val & 0xFE;
    } else if ((val & 0x0F) === 0x0F) {
      // Mode word: if mode 3 (bits 7:6 = 11), next byte is I/O mask
      if ((val & 0xC0) === 0xC0) {
        if (port === 'A') this.pioCtrlStateA = 'await_io'; else this.pioCtrlStateB = 'await_io';
      }
    } else if ((val & 0x0F) === 0x07) {
      // Interrupt control word: if bit 4 set, next byte is interrupt mask
      if (val & 0x10) {
        if (port === 'A') this.pioCtrlStateA = 'await_int'; else this.pioCtrlStateB = 'await_int';
      }
    }
    // Other control words (enable/disable int, etc.) -- ignore
  }

  /**
   * Drain pending movement by firing PIO interrupts.
   * Called at the top of runFrame after the frame interrupt.
   * Spreads interrupts evenly across the frame.
   */
  drainMovement(cpu: Z80, frameEnd: number, activity: IOActivity): void {
    const total = Math.abs(this.pendingX) + Math.abs(this.pendingY);
    if (total === 0) return;
    // Cap to avoid flooding -- real mouse tops out at ~200 steps/frame
    const cap = 200;
    if (Math.abs(this.pendingX) > cap) this.pendingX = Math.sign(this.pendingX) * cap;
    if (Math.abs(this.pendingY) > cap) this.pendingY = Math.sign(this.pendingY) * cap;
    const steps = Math.min(Math.abs(this.pendingX) + Math.abs(this.pendingY), cap);
    const spacing = Math.floor((frameEnd - cpu.tStates) / (steps + 1));

    // Interleave X and Y steps
    let xRemain = Math.abs(this.pendingX);
    let yRemain = Math.abs(this.pendingY);
    const xDir = this.pendingX > 0 ? 0 : 1;  // bit 0: 0=right, 1=left
    const yDir = this.pendingY > 0 ? 1 : 0;  // bit 0: 1=down, 0=up

    for (let i = 0; i < steps && cpu.tStates < frameEnd - 100; i++) {
      // Alternate X and Y, draining whichever has more remaining
      const doX = xRemain > 0 && (yRemain === 0 || xRemain >= yRemain);
      if (doX) {
        this.dirX = xDir;
        cpu.interruptWithVector(this.pioVectorA);
        xRemain--;
        activity.mouseReads++;
      } else if (yRemain > 0) {
        this.dirY = yDir;
        cpu.interruptWithVector(this.pioVectorB);
        yRemain--;
        activity.mouseReads++;
      }
      // Run CPU until next interrupt slot
      const target = cpu.tStates + spacing;
      while (cpu.tStates < target && cpu.tStates < frameEnd - 100) {
        if (cpu.halted) {
          cpu.tStates += 4;
          cpu.r = (cpu.r & 0x80) | ((cpu.r + 1) & 0x7F);
        } else {
          cpu.step();
        }
      }
    }
    this.pendingX = 0;
    this.pendingY = 0;
  }

  queueMovement(dx: number, dy: number): void {
    this.pendingX += dx;
    this.pendingY += dy;
  }

  setButton(button: number, pressed: boolean): void {
    const bit = AmxMouse.BUTTON_BITS[button];
    if (bit === undefined) return;
    if (pressed) {
      this.buttons &= ~(1 << bit);
    } else {
      this.buttons |= (1 << bit);
    }
  }

  reset(): void {
    this.buttons = 0xFF;
    this.dirX = 0;
    this.dirY = 0;
    this.pioVectorA = 0;
    this.pioVectorB = 0;
    this.pendingX = 0;
    this.pendingY = 0;
    this.pioCtrlStateA = 'normal';
    this.pioCtrlStateB = 'normal';
    // Note: enabled is not reset — it's a user setting, not machine state
  }
}
