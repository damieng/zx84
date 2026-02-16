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
export const [statusText, setStatusText] = createSignal('Load a ROM to start');
export const [romStatusText, setRomStatusText] = createSignal('');

// Model selection
export const [currentModel, setCurrentModel] = createSignal<SpectrumModel>(loadSavedModel() ?? '128k');

// Execution control
export const [emulationPaused, setEmulationPaused] = createSignal(false);
export const [turboMode, setTurboMode] = createSignal(false);

// Speed display
export const [clockSpeedText, setClockSpeedText] = createSignal('MHz');
