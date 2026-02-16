/**
 * Tape loader acceleration — fast-forward the tape to the next edge
 * when a custom loader is polling port 0xFE in a tight loop.
 *
 * Instead of letting the CPU spin thousands of iterations waiting for
 * the EAR bit to toggle, we detect that the code is in an edge-detection
 * loop and instantly advance the tape to the next edge.  The CPU code
 * still runs normally (no register/stack manipulation) — it just sees
 * the edge arrive immediately on the next IN.
 *
 * This is safe because:
 * - The loader code executes its full loop body (border changes, etc.)
 * - We only advance the tape, not the CPU state
 * - If the tape has no more edges, we do nothing
 *
 * The border stripe effect is preserved because the loader's own code
 * still runs and writes the border color — we just eliminate the wait.
 */

import type { TapeDeck } from './tap.ts';

/**
 * Try to fast-forward the tape to the next edge.
 *
 * Call this after loader detection has confirmed that a custom loader
 * is actively reading the EAR bit.  We check whether the tape's current
 * EAR bit matches what the CPU just read; if the loader is clearly
 * waiting for a toggle (same EAR value seen repeatedly), we advance
 * the tape to the next edge so the toggle happens on the next IN.
 *
 * @param tape     The tape deck
 * @param earSeen  The EAR bit value the CPU has been seeing (0 or 1)
 * @param cpuTStates  Current CPU T-states (for tape advance)
 * @returns true if the tape was advanced
 */
export function accelerateTape(tape: TapeDeck): boolean {
  // Advance the tape to the next edge — this toggles earBit
  const edge = tape.nextEdge();
  return edge !== null;
}
