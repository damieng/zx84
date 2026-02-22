/**
 * Hex formatting utilities.
 *
 * Pre-built lookup tables (HEX8, HEX16) give zero-allocation hex conversion
 * in hot paths (UI register display, sysvar panel).  The function forms
 * (hex8, hex16) are convenient aliases for one-off use.
 */

/** Two-char uppercase hex strings for every byte value (0–255). */
export const HEX8: readonly string[] = Array.from(
  { length: 256 },
  (_, i) => i.toString(16).toUpperCase().padStart(2, '0'),
);

/** Four-char uppercase hex strings for every word value (0–65535). */
export const HEX16: readonly string[] = Array.from(
  { length: 65536 },
  (_, i) => i.toString(16).toUpperCase().padStart(4, '0'),
);

/** Format a byte (0–255) as a 2-char uppercase hex string. */
export function hex8(v: number): string { return HEX8[v & 0xFF]; }

/** Format a word (0–65535) as a 4-char uppercase hex string. */
export function hex16(v: number): string { return HEX16[v & 0xFFFF]; }
