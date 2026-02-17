/**
 * Machine State - core machine lifecycle signals.
 *
 * These signals control the fundamental machine state:
 * - Model selection (48K, 128K, etc.)
 * - ROM status
 * - Emulation pause/turbo
 * - Status messages
 */

import { createSignal } from 'solid-js';
import type { SpectrumModel } from '@/spectrum.ts';

function loadSavedModel(): SpectrumModel | null {
  try {
    const val = localStorage.getItem('zx84-model');
    if (val === '48k' || val === '128k' || val === '+2' || val === '+2a' || val === '+3') {
      return val as SpectrumModel;
    }
  } catch { /* */ }
  return null;
}

export function saveModel(model: SpectrumModel): void {
  try {
    localStorage.setItem('zx84-model', model);
  } catch { /* */ }
}

// Status messages
const _statusText = createSignal('Load a ROM to start');
export const statusText = _statusText[0];
export const setStatusText = _statusText[1];

const _romStatusText = createSignal('');
export const romStatusText = _romStatusText[0];
export const setRomStatusText = _romStatusText[1];

// Model selection
const _currentModel = createSignal<SpectrumModel>(loadSavedModel() ?? '128k');
export const currentModel = _currentModel[0];
export const setCurrentModel = _currentModel[1];

// Execution control
const _emulationPaused = createSignal(false);
export const emulationPaused = _emulationPaused[0];
export const setEmulationPaused = _emulationPaused[1];

const _turboMode = createSignal(false);
export const turboMode = _turboMode[0];
export const setTurboMode = _turboMode[1];

// Speed display
const _clockSpeedText = createSignal('MHz');
export const clockSpeedText = _clockSpeedText[0];
export const setClockSpeedText = _clockSpeedText[1];
