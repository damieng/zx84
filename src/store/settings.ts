/**
 * Persisted display/sound/joystick settings as signals.
 */

import { createSignal, createMemo, createRoot } from 'solid-js';
import { getSaved, setSaved } from '@/store/persistence.ts';

// ── Display settings ────────────────────────────────────────────────────

function getSavedNumber(key: string, fallback: string): number {
  return Number(getSaved(key, fallback));
}

const _scale = /*@once*/ createRoot(() => createSignal(getSavedNumber('scale', '2')));
export const scale = _scale[0];
export const setScale = _scale[1];

const _brightness = /*@once*/ createRoot(() => createSignal(getSavedNumber('brightness', '0')));
export const brightness = _brightness[0];
export const setBrightness = _brightness[1];

const _contrast = /*@once*/ createRoot(() => createSignal(getSavedNumber('contrast', '50')));
export const contrast = _contrast[0];
export const setContrast = _contrast[1];

const _smoothing = /*@once*/ createRoot(() => createSignal(getSavedNumber('smoothing', '0')));
export const smoothing = _smoothing[0];
export const setSmoothing = _smoothing[1];

const _curvature = /*@once*/ createRoot(() => createSignal(getSavedNumber('curvature', '0')));
export const curvature = _curvature[0];
export const setCurvature = _curvature[1];

const _scanlines = /*@once*/ createRoot(() => createSignal(getSavedNumber('scanlines', '0')));
export const scanlines = _scanlines[0];
export const setScanlines = _scanlines[1];

const _maskType = /*@once*/ createRoot(() => createSignal(getSavedNumber('mask-type', '0')));
export const maskType = _maskType[0];
export const setMaskType = _maskType[1];

const _dotPitch = /*@once*/ createRoot(() => createSignal(getSavedNumber('dot-pitch', '10')));
export const dotPitch = _dotPitch[0];
export const setDotPitch = _dotPitch[1];

const _curvatureMode = /*@once*/ createRoot(() => createSignal(getSavedNumber('curvature-mode', '0')));
export const curvatureMode = _curvatureMode[0];
export const setCurvatureMode = _curvatureMode[1];

const _monitor = /*@once*/ createRoot(() => createSignal(getSaved('monitor', 'raw')));
export const monitor = _monitor[0];
export const setMonitor = _monitor[1];

const _borderSize = /*@once*/ createRoot(() => createSignal(getSavedNumber('border-size', '2')));
export const borderSize = _borderSize[0];
export const setBorderSize = _borderSize[1];

const _renderer = /*@once*/ createRoot(() => createSignal(getSaved('renderer', 'webgl') as 'webgl' | 'canvas'));
export const renderer = _renderer[0];
export const setRenderer = _renderer[1];

const _colorMap = /*@once*/ createRoot(() => createSignal(getSaved('color-map', 'measured') as 'basic' | 'measured' | 'vivid'));
export const colorMap = _colorMap[0];
export const setColorMap = _colorMap[1];

// ── Sound settings ──────────────────────────────────────────────────────

const _volume = /*@once*/ createRoot(() => createSignal(getSavedNumber('volume', '70')));
export const volume = _volume[0];
export const setVolume = _volume[1];

const _ayMix = /*@once*/ createRoot(() => createSignal(getSavedNumber('ay-mix', '50')));
export const ayMix = _ayMix[0];
export const setAyMix = _ayMix[1];

const _ayStereo = /*@once*/ createRoot(() => createSignal(getSaved('ay-stereo', 'ABC')));
export const ayStereo = _ayStereo[0];
export const setAyStereo = _ayStereo[1];

// ── Joystick settings ───────────────────────────────────────────────────

const _joyP1 = /*@once*/ createRoot(() => createSignal(getSaved('joy-p1', 'kempston')));
export const joyP1 = _joyP1[0];
export const setJoyP1 = _joyP1[1];

const _joyP2 = /*@once*/ createRoot(() => createSignal(getSaved('joy-p2', 'sinclair2')));
export const joyP2 = _joyP2[0];
export const setJoyP2 = _joyP2[1];

const _joyMapP1 = /*@once*/ createRoot(() => createSignal(getSaved('joy-map-p1', 'none')));
export const joyMapP1 = _joyMapP1[0];
export const setJoyMapP1 = _joyMapP1[1];

const _joyMapP2 = /*@once*/ createRoot(() => createSignal(getSaved('joy-map-p2', 'none')));
export const joyMapP2 = _joyMapP2[0];
export const setJoyMapP2 = _joyMapP2[1];

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

const _gamepadConfigP1 = /*@once*/ createRoot(() => createSignal<GamepadConfig | null>(loadGamepadConfig(1)));
export const gamepadConfigP1 = _gamepadConfigP1[0];
export const setGamepadConfigP1 = _gamepadConfigP1[1];

const _gamepadConfigP2 = /*@once*/ createRoot(() => createSignal<GamepadConfig | null>(loadGamepadConfig(2)));
export const gamepadConfigP2 = _gamepadConfigP2[0];
export const setGamepadConfigP2 = _gamepadConfigP2[1];

export function saveGamepadConfig(player: 1 | 2, config: GamepadConfig): void {
  if (player === 1) {
    setGamepadConfigP1(config);
  } else {
    setGamepadConfigP2(config);
  }
  setSaved(`gamepad-config-p${player}`, JSON.stringify(config));
}

// ── Font settings ───────────────────────────────────────────────────────

const _fontName = /*@once*/ createRoot(() => createSignal(getSaved('font', '')));
export const fontName = _fontName[0];
export const setFontName = _fontName[1];

// ── Text/OCR overlay settings ──────────────────────────────────────────

const _ocrFont = /*@once*/ createRoot(() => createSignal(getSaved('ocr-font', "'JetBrains Mono', monospace")));
export const ocrFont = _ocrFont[0];
export const setOcrFont = _ocrFont[1];

const _ocrFontSize = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-font-size', '4')));
export const ocrFontSize = _ocrFontSize[0];
export const setOcrFontSize = _ocrFontSize[1];

const _ocrLineHeight = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-line-height', '122')));
export const ocrLineHeight = _ocrLineHeight[0];
export const setOcrLineHeight = _ocrLineHeight[1];

const _ocrTracking = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-tracking', '4')));
export const ocrTracking = _ocrTracking[0];
export const setOcrTracking = _ocrTracking[1];

const _ocrOffsetX = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-offset-x', '-2')));
export const ocrOffsetX = _ocrOffsetX[0];
export const setOcrOffsetX = _ocrOffsetX[1];

const _ocrOffsetY = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-offset-y', '8')));
export const ocrOffsetY = _ocrOffsetY[0];
export const setOcrOffsetY = _ocrOffsetY[1];

const _ocrScaleX = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-scale-x', '101.9')));
export const ocrScaleX = _ocrScaleX[0];
export const setOcrScaleX = _ocrScaleX[1];

const _ocrScaleY = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-scale-y', '100.9')));
export const ocrScaleY = _ocrScaleY[0];
export const setOcrScaleY = _ocrScaleY[1];

// ── Disk mode ───────────────────────────────────────────────────────────

const _diskSoundA = /*@once*/ createRoot(() => createSignal(getSaved('disk-sound-a', 'on') === 'on'));
export const diskSoundA = _diskSoundA[0];
export const setDiskSoundA = _diskSoundA[1];

const _diskSoundB = /*@once*/ createRoot(() => createSignal(getSaved('disk-sound-b', 'on') === 'on'));
export const diskSoundB = _diskSoundB[0];
export const setDiskSoundB = _diskSoundB[1];

const _writeProtectA = /*@once*/ createRoot(() => createSignal(getSaved('write-protect-a', 'off') === 'on'));
export const writeProtectA = _writeProtectA[0];
export const setWriteProtectA = _writeProtectA[1];

const _writeProtectB = /*@once*/ createRoot(() => createSignal(getSaved('write-protect-b', 'off') === 'on'));
export const writeProtectB = _writeProtectB[0];
export const setWriteProtectB = _writeProtectB[1];

// ── Tape settings ───────────────────────────────────────────────────────

const _tapeAutoRewind = /*@once*/ createRoot(() => createSignal(getSaved('tape-auto-rewind', 'on') === 'on'));
export const tapeAutoRewind = _tapeAutoRewind[0];
export const setTapeAutoRewind = _tapeAutoRewind[1];

const _tapeCollapseBlocks = /*@once*/ createRoot(() => createSignal(getSaved('tape-collapse-blocks', 'on') === 'on'));
export const tapeCollapseBlocks = _tapeCollapseBlocks[0];
export const setTapeCollapseBlocks = _tapeCollapseBlocks[1];

const _tapeInstantLoad = /*@once*/ createRoot(() => createSignal(getSaved('tape-instant-load', 'on') === 'on'));
export const tapeInstantLoad = _tapeInstantLoad[0];
export const setTapeInstantLoad = _tapeInstantLoad[1];

const _tapeTurbo = /*@once*/ createRoot(() => createSignal(getSaved('tape-turbo', 'on') === 'on'));
export const tapeTurbo = _tapeTurbo[0];
export const setTapeTurbo = _tapeTurbo[1];

const _tapeSoundEnabled = /*@once*/ createRoot(() => createSignal(getSaved('tape-sound', 'on') === 'on'));
export const tapeSoundEnabled = _tapeSoundEnabled[0];
export const setTapeSoundEnabled = _tapeSoundEnabled[1];

// ── Multiface ────────────────────────────────────────────────────────

const _multifaceEnabled = /*@once*/ createRoot(() => createSignal(getSaved('multiface', 'off') === 'on'));
export const multifaceEnabled = _multifaceEnabled[0];
export const setMultifaceEnabled = _multifaceEnabled[1];

// ── Derived ─────────────────────────────────────────────────────────────

export const needsGamepadPolling = /*@once*/ createRoot(() => createMemo(() =>
  joyMapP1() === 'gamepad' || joyMapP2() === 'gamepad'
));

// ── Persistence helpers ─────────────────────────────────────────────────

export function persistSetting(key: string, value: string | number): void {
  setSaved(key, String(value));
}
