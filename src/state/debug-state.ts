/**
 * Debug State - debugging and inspection signals.
 *
 * Tracks state for debug panels:
 * - CPU registers (revision-based updates)
 * - System variables
 * - BASIC program listing
 * - Memory banks
 * - Disassembly
 * - Execution tracing
 * - BIOS trap log
 */

import { createSignal } from 'solid-js';

// CPU registers
export const [regsHtml, setRegsHtml] = createSignal('');  // legacy, unused — kept for type compat
export const [regsRev, setRegsRev] = createSignal(0);

// System variables
export const [sysvarHtml, setSysvarHtml] = createSignal('');  // legacy
export const [sysvarRev, setSysvarRev] = createSignal(0);

// BASIC program
export const [basicHtml, setBasicHtml] = createSignal('');
export const [basicVarsHtml, setBasicVarsHtml] = createSignal('');

// Memory banks
export const [banksHtml, setBanksHtml] = createSignal('');

// Disassembly
export const [disasmText, setDisasmText] = createSignal('');

// Execution tracing
export const [tracing, setTracing] = createSignal(false);

// BIOS trap log
export const [trapLogHtml, setTrapLogHtml] = createSignal('');
export const [showTrapLog, setShowTrapLog] = createSignal(false);
