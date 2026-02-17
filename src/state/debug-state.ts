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
const _regsHtml = createSignal('');
export const regsHtml = _regsHtml[0];
export const setRegsHtml = _regsHtml[1];

const _regsRev = createSignal(0);
export const regsRev = _regsRev[0];
export const setRegsRev = _regsRev[1];

// System variables
const _sysvarHtml = createSignal('');
export const sysvarHtml = _sysvarHtml[0];
export const setSysvarHtml = _sysvarHtml[1];

const _sysvarRev = createSignal(0);
export const sysvarRev = _sysvarRev[0];
export const setSysvarRev = _sysvarRev[1];

// BASIC program
const _basicHtml = createSignal('');
export const basicHtml = _basicHtml[0];
export const setBasicHtml = _basicHtml[1];

const _basicVarsHtml = createSignal('');
export const basicVarsHtml = _basicVarsHtml[0];
export const setBasicVarsHtml = _basicVarsHtml[1];

// Memory banks
const _banksHtml = createSignal('');
export const banksHtml = _banksHtml[0];
export const setBanksHtml = _banksHtml[1];

// Disassembly
const _disasmText = createSignal('');
export const disasmText = _disasmText[0];
export const setDisasmText = _disasmText[1];

// Execution tracing
const _tracing = createSignal(false);
export const tracing = _tracing[0];
export const setTracing = _tracing[1];

// BIOS trap log
const _trapLogHtml = createSignal('');
export const trapLogHtml = _trapLogHtml[0];
export const setTrapLogHtml = _trapLogHtml[1];

const _showTrapLog = createSignal(false);
export const showTrapLog = _showTrapLog[0];
export const setShowTrapLog = _showTrapLog[1];
