/**
 * Activity State - LED indicators for I/O activity.
 *
 * Tracks per-frame I/O activity for status bar LEDs:
 * - Input devices (keyboard, joystick, mouse)
 * - Tape/disk operations
 * - Audio (beeper, AY)
 * - Screen effects (rainbow)
 * - Transcription mode
 */

import { createSignal } from 'solid-js';

// Input devices
const _ledKbd = createSignal(false);
export const ledKbd = _ledKbd[0];
export const setLedKbd = _ledKbd[1];

const _ledKemp = createSignal(false);
export const ledKemp = _ledKemp[0];
export const setLedKemp = _ledKemp[1];

const _ledMouse = createSignal(false);
export const ledMouse = _ledMouse[0];
export const setLedMouse = _ledMouse[1];

// Tape/disk
const _ledEar = createSignal(false);
export const ledEar = _ledEar[0];
export const setLedEar = _ledEar[1];

const _ledLoad = createSignal(false);
export const ledLoad = _ledLoad[0];
export const setLedLoad = _ledLoad[1];

const _ledTapeTurbo = createSignal(false);
export const ledTapeTurbo = _ledTapeTurbo[0];
export const setLedTapeTurbo = _ledTapeTurbo[1];

const _ledDsk = createSignal(false);
export const ledDsk = _ledDsk[0];
export const setLedDsk = _ledDsk[1];

// Audio
const _ledBeep = createSignal(false);
export const ledBeep = _ledBeep[0];
export const setLedBeep = _ledBeep[1];

const _ledAy = createSignal(false);
export const ledAy = _ledAy[0];
export const setLedAy = _ledAy[1];

// Screen effects
const _ledRainbow = createSignal(false);
export const ledRainbow = _ledRainbow[0];
export const setLedRainbow = _ledRainbow[1];

// Transcription
const _ledText = createSignal(false);
export const ledText = _ledText[0];
export const setLedText = _ledText[1];

const _transcribeMode = createSignal<'off' | 'text'>('off');
export const transcribeMode = _transcribeMode[0];
export const setTranscribeMode = _transcribeMode[1];

const _transcribeText = createSignal('');
export const transcribeText = _transcribeText[0];
export const setTranscribeText = _transcribeText[1];
