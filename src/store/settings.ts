/**
 * Persisted display/sound/joystick settings as signals.
 */

import { createSignal, createMemo } from 'solid-js';
import { getSaved, setSaved } from '@/store/persistence.ts';

// ── Display settings ────────────────────────────────────────────────────

function getSavedNumber(key: string, fallback: string): number {
  return Number(getSaved(key, fallback));
}

export const [scale, setScale] = createSignal(getSavedNumber('scale', '2'));
export const [brightness, setBrightness] = createSignal(getSavedNumber('brightness', '0'));
export const [contrast, setContrast] = createSignal(getSavedNumber('contrast', '50'));
export const [smoothing, setSmoothing] = createSignal(getSavedNumber('smoothing', '0'));
export const [curvature, setCurvature] = createSignal(getSavedNumber('curvature', '0'));
export const [scanlines, setScanlines] = createSignal(getSavedNumber('scanlines', '0'));
export const [maskType, setMaskType] = createSignal(getSavedNumber('mask-type', '0'));
export const [dotPitch, setDotPitch] = createSignal(getSavedNumber('dot-pitch', '10'));
export const [curvatureMode, setCurvatureMode] = createSignal(getSavedNumber('curvature-mode', '0'));
export const [monitor, setMonitor] = createSignal(getSaved('monitor', 'raw'));
export const [borderSize, setBorderSize] = createSignal(getSavedNumber('border-size', '2'));
export const [renderer, setRenderer] = createSignal(getSaved('renderer', 'webgl') as 'webgl' | 'canvas');
export const [colorMap, setColorMap] = createSignal(getSaved('color-map', 'measured') as 'basic' | 'measured' | 'vivid');

// ── Sound settings ──────────────────────────────────────────────────────

export const [volume, setVolume] = createSignal(getSavedNumber('volume', '70'));
export const [ayMix, setAyMix] = createSignal(getSavedNumber('ay-mix', '50'));
export const [ayStereo, setAyStereo] = createSignal(getSaved('ay-stereo', 'ABC'));

// ── Joystick settings ───────────────────────────────────────────────────

export const [joyP1, setJoyP1] = createSignal(getSaved('joy-p1', 'kempston'));
export const [joyP2, setJoyP2] = createSignal(getSaved('joy-p2', 'sinclair2'));
export const [joyMapP1, setJoyMapP1] = createSignal(getSaved('joy-map-p1', 'none'));
export const [joyMapP2, setJoyMapP2] = createSignal(getSaved('joy-map-p2', 'none'));

// ── Gamepad configuration ───────────────────────────────────────────────

export type GamepadBinding =
  | { type: 'button'; index: number }
  | { type: 'axis'; index: number; direction: 'positive' | 'negative' };

export type GamepadConfig = {
  deadzone: number[]; // Neutral axis positions
  up: GamepadBinding;
  down: GamepadBinding;
  left: GamepadBinding;
  right: GamepadBinding;
  fire: GamepadBinding;
};

function loadGamepadConfig(player: 1 | 2): GamepadConfig | null {
  try {
    const saved = getSaved(`gamepad-config-p${player}`, '');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

export const [gamepadConfigP1, setGamepadConfigP1] = createSignal<GamepadConfig | null>(loadGamepadConfig(1));
export const [gamepadConfigP2, setGamepadConfigP2] = createSignal<GamepadConfig | null>(loadGamepadConfig(2));

export function saveGamepadConfig(player: 1 | 2, config: GamepadConfig): void {
  if (player === 1) {
    setGamepadConfigP1(config);
  } else {
    setGamepadConfigP2(config);
  }
  setSaved(`gamepad-config-p${player}`, JSON.stringify(config));
}

// ── Mouse settings ─────────────────────────────────────────────────────

export const [mouseEnabled, setMouseEnabled] = createSignal(getSaved('mouse-enabled', 'off') === 'on');

// ── Font settings ───────────────────────────────────────────────────────

export const [fontName, setFontName] = createSignal(getSaved('font', ''));

// ── Disk mode ───────────────────────────────────────────────────────────

export const [diskMode, setDiskMode] = createSignal(getSaved('disk-mode', 'fdc') as 'fdc' | 'bios');
export const [dualDrives, setDualDrives] = createSignal(getSaved('dual-drives', 'off') === 'on');

// ── Tape settings ───────────────────────────────────────────────────────

export const [tapeAutoRewind, setTapeAutoRewind] = createSignal(getSaved('tape-auto-rewind', 'on') === 'on');
export const [tapeCollapseBlocks, setTapeCollapseBlocks] = createSignal(getSaved('tape-collapse-blocks', 'on') === 'on');

// ── Sub-frame rendering ────────────────────────────────────────────────

export const [subFrameRendering, setSubFrameRendering] = createSignal(getSaved('sub-frame-rendering', 'off') === 'on');

// ── Derived ─────────────────────────────────────────────────────────────

export const needsGamepadPolling = createMemo(() =>
  joyMapP1() === 'gamepad' || joyMapP2() === 'gamepad'
);

// ── Persistence helpers ─────────────────────────────────────────────────

export function persistSetting(key: string, value: string | number): void {
  setSaved(key, String(value));
}
