/**
 * Persisted display/sound/joystick settings as signals.
 */

import { signal, computed } from '@preact/signals';
import { getSaved, setSaved } from '@/store/persistence.ts';

// ── Display settings ────────────────────────────────────────────────────

function getSavedNumber(key: string, fallback: string): number {
  return Number(getSaved(key, fallback));
}

export const scale = signal(getSavedNumber('scale', '2'));
export const brightness = signal(getSavedNumber('brightness', '0'));
export const contrast = signal(getSavedNumber('contrast', '50'));
export const smoothing = signal(getSavedNumber('smoothing', '0'));
export const curvature = signal(getSavedNumber('curvature', '0'));
export const scanlines = signal(getSavedNumber('scanlines', '0'));
export const maskType = signal(getSavedNumber('mask-type', '0'));
export const dotPitch = signal(getSavedNumber('dot-pitch', '10'));
export const curvatureMode = signal(getSavedNumber('curvature-mode', '0'));
export const monitor = signal(getSaved('monitor', 'raw'));
export const borderSize = signal(getSavedNumber('border-size', '2'));
export const renderer = signal(getSaved('renderer', 'webgl') as 'webgl' | 'canvas');
export const colorMap = signal(getSaved('color-map', 'measured') as 'basic' | 'measured' | 'vivid');

// ── Sound settings ──────────────────────────────────────────────────────

export const volume = signal(getSavedNumber('volume', '70'));
export const ayMix = signal(getSavedNumber('ay-mix', '50'));
export const ayStereo = signal(getSaved('ay-stereo', 'ABC'));

// ── Joystick settings ───────────────────────────────────────────────────

export const joyP1 = signal(getSaved('joy-p1', 'kempston'));
export const joyP2 = signal(getSaved('joy-p2', 'sinclair2'));
export const joyMapP1 = signal(getSaved('joy-map-p1', 'none'));
export const joyMapP2 = signal(getSaved('joy-map-p2', 'none'));

// ── Font settings ───────────────────────────────────────────────────────

export const fontName = signal(getSaved('font', ''));

// ── Disk mode ───────────────────────────────────────────────────────────

export const diskMode = signal(getSaved('disk-mode', 'fdc') as 'fdc' | 'bios');
export const dualDrives = signal(getSaved('dual-drives', 'off') === 'on');

// ── Tape settings ───────────────────────────────────────────────────────

export const tapeAutoRewind = signal(getSaved('tape-auto-rewind', 'on') === 'on');
export const tapeCollapseBlocks = signal(getSaved('tape-collapse-blocks', 'on') === 'on');

// ── Sub-frame rendering ────────────────────────────────────────────────

export const subFrameRendering = signal(getSaved('sub-frame-rendering', 'off') === 'on');

// ── Derived ─────────────────────────────────────────────────────────────

export const needsGamepadPolling = computed(() =>
  joyMapP1.value === 'gamepad' || joyMapP2.value === 'gamepad'
);

// ── Persistence helpers ─────────────────────────────────────────────────

export function persistSetting(key: string, value: string | number): void {
  setSaved(key, String(value));
}
