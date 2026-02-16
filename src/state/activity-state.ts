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
export const [ledKbd, setLedKbd] = createSignal(false);
export const [ledKemp, setLedKemp] = createSignal(false);
export const [ledMouse, setLedMouse] = createSignal(false);

// Tape/disk
export const [ledEar, setLedEar] = createSignal(false);
export const [ledLoad, setLedLoad] = createSignal(false);
export const [ledTapeTurbo, setLedTapeTurbo] = createSignal(false);
export const [ledDsk, setLedDsk] = createSignal(false);

// Audio
export const [ledBeep, setLedBeep] = createSignal(false);
export const [ledAy, setLedAy] = createSignal(false);

// Screen effects
export const [ledRainbow, setLedRainbow] = createSignal(false);

// Transcription
export const [ledRst16, setLedRst16] = createSignal(false);
export const [ledText, setLedText] = createSignal(false);
export const [transcribeMode, setTranscribeMode] = createSignal<'off' | 'rst16' | 'text'>('off');
export const [transcribeText, setTranscribeText] = createSignal('');
