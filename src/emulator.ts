/**
 * Machine lifecycle: spectrum instance, ROM management, model switching.
 */

import { batch } from 'solid-js';
import { Spectrum, type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from '@/spectrum.ts';
import { WebGLRenderer } from '@/display/webgl-renderer.ts';
import { CanvasRenderer } from '@/display/canvas-renderer.ts';
import { FloppySound } from '@/plus3/floppy-sound.ts';
import { PALETTES } from '@/cores/ula.ts';
import { saveSZX } from '@/snapshot/szx.ts';
import { saveZ80 } from '@/snapshot/z80format.ts';
import { parseTZX } from '@/tape/tzx.ts';
import { parseDSK, serializeDSK, type DskImage } from '@/plus3/dsk.ts';
import { loadSZX } from '@/snapshot/szx.ts';
import { clearLastFile, restoreTape, restoreDisk, dbSave, dbLoad } from '@/store/persistence.ts';
import * as settings from '@/store/settings.ts';
import { variantForModel, variantLabel, romFilename } from '@/peripherals/multiface.ts';
import { onFrame, updateRegsOnce, resetSpeedTracking, forceSpeedUpdate } from '@/frame-bridge.ts';
export { fontDataHash, updateFontPreview, loadFontStore, saveFontStore, capturedFontData } from '@/frame-bridge.ts';
export type { FontEntry } from '@/frame-bridge.ts';

// Managers
import { ROMManager } from '@/managers/rom-manager.ts';
import { MediaManager, type MediaLoadCallbacks } from '@/managers/media-manager.ts';
import { DebugManager, type TraceMode } from '@/managers/debug-manager.ts';

// Create manager instances
const romManager = new ROMManager();
const mediaManager = new MediaManager();
const debugManager = new DebugManager();

// Re-export TraceMode for compatibility
export type { TraceMode };

// ── State (re-exported from feature modules) ───────────────────────────

// Machine state — import everything, then re-export below
import {
  statusText,
  romStatusText,
  currentModel,
  emulationPaused,
  turboMode,
  clockSpeedText,
  saveModel,
  setStatusText,
  setRomStatusText,
  setCurrentModel,
  setEmulationPaused,
  setTurboMode,
  setClockSpeedText,
} from '@/state/machine-state.ts';

import {
  tapeLoaded,
  tapeBlocks,
  tapePosition,
  tapePaused,
  tapePlaying,
  tapeName,
  setTapeLoaded,
  setTapeName,
  setTapeBlocks,
  setTapePosition,
  setTapePaused,
  setTapePlaying,
} from '@/state/tape-state.ts';

import {
  currentDiskInfo, currentDiskName, currentDiskInfoB, currentDiskNameB,
  driveAStatus, driveBStatus, diskInfoHtml, driveHtml,
  setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB,
  setDriveAStatus, setDriveBStatus, setDiskInfoHtml, setDriveHtml,
} from '@/state/disk-state.ts';

import {
  regsHtml, regsRev, sysvarHtml, sysvarRev,
  basicHtml, basicVarsHtml, banksHtml, disasmText, tracing,
  trapLogHtml, showTrapLog,
  setRegsHtml, setRegsRev, setSysvarHtml, setSysvarRev,
  setBasicHtml, setBasicVarsHtml, setBanksHtml, setDisasmText, setTracing,
  setTrapLogHtml, setShowTrapLog,
} from '@/state/debug-state.ts';

import {
  ledKbd, ledKemp, ledMouse, ledEar, ledLoad, ledTapeTurbo,
  ledDsk, ledBeep, ledAy, ledRainbow, ledText,
  transcribeMode, transcribeText, transcribeHtml,
  setLedKbd, setLedKemp, setLedMouse, setLedEar, setLedLoad, setLedTapeTurbo,
  setLedDsk, setLedBeep, setLedAy, setLedRainbow, setLedText,
  setTranscribeMode, setTranscribeText, setTranscribeHtml,
} from '@/state/activity-state.ts';

// Re-export machine state
export { statusText, romStatusText, currentModel, emulationPaused, turboMode, clockSpeedText, saveModel };
export { setStatusText, setRomStatusText, setCurrentModel, setEmulationPaused, setTurboMode, setClockSpeedText };

// Re-export tape state
export { tapeLoaded, tapeBlocks, tapePosition, tapePaused, tapePlaying, tapeName };
export { setTapeLoaded, setTapeName, setTapeBlocks, setTapePosition, setTapePaused, setTapePlaying };

// Re-export disk state
export { currentDiskInfo, currentDiskName, currentDiskInfoB, currentDiskNameB, driveAStatus, driveBStatus, diskInfoHtml, driveHtml };
export { setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB, setDriveAStatus, setDriveBStatus, setDiskInfoHtml, setDriveHtml };

// Re-export debug state
export { regsHtml, regsRev, sysvarHtml, sysvarRev, basicHtml, basicVarsHtml, banksHtml, disasmText, tracing, trapLogHtml, showTrapLog };
export { setRegsHtml, setRegsRev, setSysvarHtml, setSysvarRev, setBasicHtml, setBasicVarsHtml, setBanksHtml, setDisasmText, setTracing, setTrapLogHtml, setShowTrapLog };

// Re-export activity state
export { ledKbd, ledKemp, ledMouse, ledEar, ledLoad, ledTapeTurbo, ledDsk, ledBeep, ledAy, ledRainbow, ledText, transcribeMode, transcribeText, transcribeHtml };
export { setLedKbd, setLedKemp, setLedMouse, setLedEar, setLedLoad, setLedTapeTurbo, setLedDsk, setLedBeep, setLedAy, setLedRainbow, setLedText, setTranscribeMode, setTranscribeText, setTranscribeHtml };

// ── Non-signal state (plain variables) ──────────────────────────────────

export let spectrum: Spectrum | null = null;
export let romData: Uint8Array | null = null;
export let floppySound: FloppySound | null = null;
export let canvasEl: HTMLCanvasElement | null = null;



// ── ROM management (via ROMManager) ─────────────────────────────────────

// Re-export ROMEntry type for compatibility
export type { ROMEntry } from '@/managers/rom-manager.ts';

/** Persist a ROM to cache and storage (delegates to ROMManager) */
export async function persistROM(model: SpectrumModel, data: Uint8Array, label: string): Promise<void> {
  await romManager.persistROM(model, data, label);
}

/** Restore a ROM from cache (delegates to ROMManager) */
export async function restoreROM(model: SpectrumModel) {
  return await romManager.restoreROM(model);
}

/** Fetch default ROM from CDN (delegates to ROMManager) */
export async function fetchDefaultROM(model: SpectrumModel) {
  return await romManager.fetchDefaultROM(model, setStatus);
}

// ── Actions ─────────────────────────────────────────────────────────────

export function setStatus(msg: string): void {
  setStatusText(msg);
}

export function setRomStatus(msg: string): void {
  setRomStatusText(msg);
}

export function setCanvas(el: HTMLCanvasElement): void {
  canvasEl = el;
  if (spectrum) {
    // Swap display without rebuilding machine (e.g. renderer switch)
    const w = spectrum.ula.screenWidth;
    const h = spectrum.ula.screenHeight;
    spectrum.display = settings.renderer() === 'canvas'
      ? new CanvasRenderer(el, w, h)
      : new WebGLRenderer(el, w, h);
    applyDisplaySettings();
  }
}

export function applyDisplaySettings(): void {
  if (!spectrum) return;
  spectrum.setBorderSize(settings.borderSize() as 0 | 1 | 2);
  spectrum.ula.palette = PALETTES[settings.colorMap()];
  if (spectrum.display) {
    spectrum.display.setScale(settings.scale());
    spectrum.display.setBrightness(settings.brightness() / 50);
    spectrum.display.setContrast(settings.contrast() / 50);
    spectrum.display.setSmoothing(settings.smoothing() / 100);
    spectrum.display.setCurvature(settings.curvature() / 100 * 0.15);
    spectrum.display.setScanlines(settings.scanlines() / 100);
    spectrum.display.setMaskType(settings.maskType());
    spectrum.display.setDotPitch(settings.dotPitch() / 10);
    spectrum.display.setCurvatureMode(settings.curvatureMode());
  }
  spectrum['audio'].setVolume(settings.volume() / 100);
  const mix = settings.ayMix() / 100;
  spectrum.mixer.beeperGain = Math.min(1, 2 * (1 - mix));
  spectrum.mixer.ayGain = Math.min(1, 2 * mix);
  spectrum.tapeInstantLoad = settings.tapeInstantLoad();
  spectrum.tapeTurbo = settings.tapeTurbo();
  spectrum.tapeSoundEnabled = settings.tapeSoundEnabled();
}

export async function createMachine(): Promise<boolean> {
  if (!canvasEl) return false;

  // Preserve tape state across machine rebuild
  const savedTapeBlocks = spectrum ? [...spectrum.tape.blocks] : null;
  const savedTapePos = spectrum ? spectrum.tape.position : 0;
  const savedTapePaused = spectrum ? spectrum.tape.paused : true;
  const savedTapeName = tapeName();

  if (spectrum) {
    spectrum.destroy();
  }

  const model = currentModel();
  spectrum = new Spectrum(model, canvasEl, settings.renderer());
  spectrum.onStatus = (msg: string) => setStatus(msg);
  spectrum.onFrame = onFrame;
  applyDisplaySettings();
  resetSpeedTracking();

  let hmrRestored = false;
  if (romData) {
    spectrum.loadROM(romData);
    spectrum.reset();

    // Try to restore HMR state before starting
    hmrRestored = await restoreHMRState();
    if (!hmrRestored) {
      spectrum.start();
    }
  }

  // Apply Multiface settings
  spectrum.multiface.variant = variantForModel(model);
  spectrum.multiface.enabled = settings.multifaceEnabled();
  if (spectrum.multiface.enabled) {
    loadMultifaceROM(spectrum).catch(err => console.warn('MF ROM load failed:', err));
  }

  // Apply saved AY stereo mode
  const savedAyStereo = settings.ayStereo() as 'MONO' | 'ABC' | 'BCA' | 'CBA';
  spectrum.ay.setStereoMode(savedAyStereo);

  // Apply saved disk mode for +3
  if (isPlus3(model)) {
    spectrum.fdc.writeProtect[0] = settings.writeProtectA();
    spectrum.fdc.writeProtect[1] = settings.writeProtectB();
  }

  // Floppy sound
  setCurrentDiskInfo(null);
  setCurrentDiskName('');
  setCurrentDiskInfoB(null);
  setCurrentDiskNameB('');
  if (isPlus3(model)) {
    if (!floppySound) floppySound = new FloppySound();
    floppySound.reset();
  } else {
    floppySound?.destroy();
    floppySound = null;
  }

  // Restore tape if one was loaded
  if (savedTapeBlocks && savedTapeBlocks.length > 0) {
    spectrum.tape.blocks = savedTapeBlocks;
    spectrum.tape.position = savedTapePos;
    spectrum.tape.paused = savedTapePaused;
    batch(() => {
      setTapeLoaded(true);
      setTapeName(savedTapeName);
      setTapeBlocks([...savedTapeBlocks]);
      setTapePosition(savedTapePos);
      setTapePaused(savedTapePaused);
      setTapePlaying(false);
      setTurboMode(false);
    });
  } else {
    batch(() => {
      setTapeLoaded(false);
      setTapeBlocks([]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(false);
      setTurboMode(false);
    });
  }

  unpause();
  return hmrRestored;
}

export function createMachineSync(): void {
  createMachine().catch(err => console.error('createMachine error:', err));
}

export function unpause(): void {
  setEmulationPaused(false);
}

function clearDebugPanels(): void {
  setDisasmText('');
  setSysvarHtml('');
  setBasicHtml('');
  setBasicVarsHtml('');
}

export function togglePause(): void {
  if (!spectrum) return;
  if (emulationPaused()) {
    clearDebugPanels();
    spectrum.start();
  } else {
    spectrum.stop();
    updateRegsOnce();
  }
  setEmulationPaused(!emulationPaused());
}

export function stepInto(): void {
  if (!spectrum) return;
  if (!emulationPaused()) {
    spectrum.stop();
    setEmulationPaused(true);
  }
  debugManager.stepInto(spectrum, updateRegsOnce);
}

export function stepOver(): void {
  if (!spectrum) return;
  if (!emulationPaused()) {
    spectrum.stop();
    setEmulationPaused(true);
  }
  debugManager.stepOver(spectrum, updateRegsOnce);
}

export function stepOut(): void {
  if (!spectrum) return;
  if (!emulationPaused()) {
    spectrum.stop();
    setEmulationPaused(true);
  }
  debugManager.stepOut(spectrum, updateRegsOnce);
}

export function resetMachine(): void {
  floppySound?.reset();
  if (spectrum) {
    spectrum.turbo = false;
    setTurboMode(false);
    spectrum.tape.rewind();
    spectrum.tape.paused = true;
    setTapePaused(true);
    spectrum.reset();
    if (romData) spectrum.start();
    batch(() => {
      setTapeLoaded(spectrum!.tape.loaded);
      setTapeBlocks([...spectrum!.tape.blocks]);
      setTapePosition(0);
    });
    unpause();
  }
  if (transcribeMode() !== 'off') {
    setTranscribeMode('off');
  }
  clearLastFile();
}

export function toggleTurbo(): void {
  if (!spectrum) return;
  spectrum.turbo = !spectrum.turbo;
  setTurboMode(spectrum.turbo);
  forceSpeedUpdate();
}

export function toggleBreakpoint(addr: number): void {
  if (!spectrum) return;
  debugManager.toggleBreakpoint(spectrum, addr, setStatus, updateRegsOnce);
}

export function runTo(addr: number): void {
  if (!spectrum) return;
  debugManager.runTo(spectrum, addr, emulationPaused(), () => {
    clearDebugPanels();
    setEmulationPaused(false);
  });
}

export function getPendingRunTo(): number {
  return debugManager.getPendingRunTo();
}

export function clearPendingRunTo(): void {
  debugManager.clearPendingRunTo();
}

export function copyCpuState(): void {
  if (!spectrum) return;
  debugManager.copyCpuState(spectrum, setStatus);
}

export function startTrace(mode: TraceMode = 'full'): void {
  if (!spectrum) return;
  debugManager.startTrace(spectrum, mode, () => setTracing(true));
}

export function stopTrace(): void {
  if (!spectrum) return;
  debugManager.stopTrace(spectrum, (text, lineCount) => {
    setTracing(false);
    navigator.clipboard.writeText(text);
    setStatus(`Trace copied to clipboard (${lineCount.toLocaleString()} lines)`);
  });
}

// ── Model switching ─────────────────────────────────────────────────────

export async function switchModel(model: SpectrumModel): Promise<void> {
  setCurrentModel(model);
  saveModel(model);

  let entry = await restoreROM(model);
  if (!entry) entry = await fetchDefaultROM(model);

  if (entry) {
    romData = entry.data;
    setRomStatus('');
  } else {
    romData = null;
    setRomStatus('');
  }

  await createMachine();
}

// ── ROM loading ─────────────────────────────────────────────────────────

export async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  romData = data;

  let detectedModel: SpectrumModel;
  if (data.length >= 65536) {
    detectedModel = isPlus2AClass(currentModel()) ? currentModel() : '+2a';
  } else if (data.length >= 32768) {
    detectedModel = is128kClass(currentModel()) ? currentModel() : '128k';
  } else if (data.length >= 16384) {
    detectedModel = '48k';
  } else {
    setStatus(`ROM too small (${data.length} bytes)`);
    return;
  }

  setCurrentModel(detectedModel);
  saveModel(detectedModel);

  await persistROM(detectedModel, data, fileLabel);
  setRomStatus('');

  await createMachine();
}

export async function loadRomFiles(files: FileList): Promise<void> {
  if (files.length === 0) return;

  const sorted = Array.from(files).sort((a, b) => a.name.localeCompare(b.name));
  const sizes = sorted.map(f => f.size);

  if (sorted.length === 1 && sizes[0] === 16384) {
    // Single 16KB ROM
  } else if (sorted.length === 1 && sizes[0] === 32768) {
    // Single 32KB ROM
  } else if (sorted.length === 1 && sizes[0] === 65536) {
    // Single 64KB ROM
  } else if (sorted.length === 2 && sizes[0] === 16384 && sizes[1] === 16384) {
    // Two 16KB ROMs
  } else if (sorted.length === 4 && sizes.every(s => s === 16384)) {
    // Four 16KB ROMs
  } else {
    const sizeList = sizes.map(s => `${s}b`).join(', ');
    setStatus(`Invalid ROM: expected 1×16KB, 1×32KB, 1×64KB, 2×16KB, or 4×16KB — got ${sorted.length} file(s) (${sizeList})`);
    return;
  }

  const buffers = await Promise.all(sorted.map(f => f.arrayBuffer()));
  const totalLen = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const data = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of buffers) {
    data.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  const label = sorted.map(f => f.name).join(' + ');
  await applyROM(data, label);
}

// ── Snapshot loading ────────────────────────────────────────────────────

/** Try to switch to a 128K-class ROM, returning false if none available. */
async function ensure128kROM(): Promise<boolean> {
  const models: SpectrumModel[] = ['128k', '+2', '+2a', '+3'];
  for (const model of models) {
    const entry = await restoreROM(model);
    if (entry) {
      setCurrentModel(model);
      romData = entry.data;
      setRomStatus('');
      await createMachine();
      return true;
    }
  }
  return false;
}

/** Build media callbacks for the MediaManager */
function buildMediaCallbacks(): MediaLoadCallbacks {
  return {
    onStatus: setStatus,
    onTapeLoaded: (blocks, filename) => {
      batch(() => {
        setTapeLoaded(true);
        setTapeName(filename);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(true);
      });
    },
    onDiskLoaded: (image, filename, unit) => {
      if (unit === 0) {
        setCurrentDiskInfo(image);
        setCurrentDiskName(filename);
      } else {
        setCurrentDiskInfoB(image);
        setCurrentDiskNameB(filename);
      }
    },
    onSnapshotLoaded: (_filename) => {
      // No special action needed beyond what MediaManager already does
    },
    unpause,
    ensure128kROM,
  };
}


// ── Tape/Disk loading (via MediaManager) ───────────────────────────────

export function applyTape(data: Uint8Array, filename: string): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }

  mediaManager.applyTape(spectrum, data, filename, {
    onStatus: setStatus,
    onTapeLoaded: (blocks, filename) => {
      batch(() => {
        setTapeLoaded(true);
        setTapeName(filename);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(true);
      });
    },
    unpause,
  });
}

// ── File routing ────────────────────────────────────────────────────────

export async function loadFile(data: Uint8Array, filename: string, unit?: number): Promise<void> {
  await mediaManager.loadFile(spectrum, data, filename, currentModel(), buildMediaCallbacks(), unit);
}

// ── Save snapshot ───────────────────────────────────────────────────────

function downloadFile(data: Uint8Array, filename: string): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function saveSnapshot(format: 'z80' | 'szx' = 'szx'): Promise<void> {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) spectrum.stop();

  const model = is128kClass(currentModel()) ? '128k' : '48k';
  let data: Uint8Array;

  if (format === 'szx') {
    const ayRegs = spectrum.ay.getRegisters();
    data = await saveSZX(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor, ayRegs, spectrum.ay.selectedReg);
  } else {
    // .z80 format
    data = saveZ80(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor, is128kClass(currentModel()));
  }

  const filename = `zx84-${model}.${format}`;

  downloadFile(data, filename);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
}

export function saveScreenshot(format: 'png' | 'scr'): void {
  if (!spectrum) { setStatus('No machine running'); return; }

  if (format === 'scr') {
    // .scr = raw 6912 bytes from 0x4000 (6144 pixels + 768 attrs)
    const screenData = spectrum.memory.flat.slice(0x4000, 0x4000 + 6912);
    downloadFile(screenData, 'screen.scr');
    setStatus('Saved screen.scr');
  } else {
    // PNG export via canvas
    if (!spectrum.display) { setStatus('No display available'); return; }
    const canvas = spectrum.display['canvas'] as HTMLCanvasElement;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'screen.png';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Saved screen.png');
    });
  }
}

export function saveRAM(): void {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused();
  if (!wasPaused) spectrum.stop();

  // Check if RAM is at 0x0000 (special paging mode on +2A/+3)
  const mem = spectrum.memory;
  const startAddr = mem.specialPaging ? 0 : 0x4000;
  const ramData = spectrum.memory.flat.slice(startAddr);

  const filename = startAddr === 0 ? 'ram-64k.bin' : 'ram-48k.bin';
  downloadFile(ramData, filename);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
}

// ── Tape transport ──────────────────────────────────────────────────────

export function tapeRewind(): void {
  if (!spectrum) return;
  spectrum.tape.rewind();
  setTapePosition(0);
}

export function tapePrev(): void {
  if (!spectrum) return;
  if (spectrum.tape.position > 0) spectrum.tape.position--;
  setTapePosition(spectrum.tape.position);
}

export function tapeTogglePlay(): void {
  if (!spectrum) return;
  if (spectrum.tape.playing) {
    spectrum.tape.stopPlayback();
    setTapePlaying(false);
  } else {
    spectrum.tape.paused = false;
    spectrum.tape.startPlayback();
    setTapePaused(false);
    setTapePlaying(true);
  }
}

export function tapeTogglePause(): void {
  if (!spectrum) return;
  spectrum.tape.paused = !spectrum.tape.paused;
  setTapePaused(spectrum.tape.paused);
}

export function tapeNext(): void {
  if (!spectrum) return;
  if (spectrum.tape.position < spectrum.tape.blocks.length) spectrum.tape.position++;
  setTapePosition(spectrum.tape.position);
}

export function tapeSetPosition(pos: number): void {
  if (!spectrum) return;
  spectrum.tape.position = pos;
  setTapePosition(pos);
}

export function toggleAutoRewind(): void {
  settings.setTapeAutoRewind(!settings.tapeAutoRewind());
  settings.persistSetting('tape-auto-rewind', settings.tapeAutoRewind() ? 'on' : 'off');
}

export function ejectTape(): void {
  if (!spectrum) return;
  mediaManager.ejectTape(spectrum, () => {
    batch(() => {
      setTapeLoaded(false);
      setTapeName('');
      setTapeBlocks([]);
      setTapePosition(0);
      setTapePaused(true);
      setTapePlaying(false);
    });
  }, setStatus);
}

export function ejectDisk(unit: number = 0): void {
  if (!spectrum) return;
  mediaManager.ejectDisk(spectrum, unit, (u) => {
    if (u === 0) {
      setCurrentDiskInfo(null);
      setCurrentDiskName('');
      setDiskInfoHtml('');
    } else {
      setCurrentDiskInfoB(null);
      setCurrentDiskNameB('');
    }
  }, setStatus);
}

export function insertBlankDisk(image: DskImage, name: string, unit: number): void {
  if (!spectrum) return;
  spectrum.fdc.insertDisk(image, unit);
  if (unit === 0) {
    setCurrentDiskInfo(image);
    setCurrentDiskName(name);
  } else {
    setCurrentDiskInfoB(image);
    setCurrentDiskNameB(name);
  }
}

export function saveDisk(unit: number): void {
  if (!spectrum) return;
  const image = spectrum.fdc.getDiskImage(unit);
  if (!image) { setStatus(`No disk in drive ${unit === 0 ? 'A' : 'B'}:`); return; }
  const name = unit === 0 ? currentDiskName() : currentDiskNameB();
  const filename = name.replace(/\.[^.]+$/, '') + '.dsk';
  downloadFile(serializeDSK(image), filename);
}

export function loadDiskToUnit(data: Uint8Array, filename: string, unit: number): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }
  mediaManager.loadDisk(spectrum, data, filename, unit, {
    onStatus: setStatus,
    onDiskLoaded: (image, filename, unit) => {
      if (unit === 0) {
        setCurrentDiskInfo(image);
        setCurrentDiskName(filename);
      } else {
        setCurrentDiskInfoB(image);
        setCurrentDiskNameB(filename);
      }
    },
  });
}


// ── Joystick helpers ────────────────────────────────────────────────────

export { KEMPSTON_BITS, CURSOR_KEYS, SINCLAIR1_KEYS, SINCLAIR2_KEYS } from '@/peripherals/joysticks.ts';
import { joyPressForType as _joyPress } from '@/peripherals/joysticks.ts';

export function joyPressForType(dir: string, pressed: boolean, mode: string): void {
  if (!spectrum) return;
  _joyPress(spectrum, dir, pressed, mode);
}

// ── Mouse helpers ────────────────────────────────────────────────────

export type MouseMode = 'kempston' | 'amx' | null;

export function setMouseMode(mode: MouseMode): void {
  if (!spectrum) return;
  spectrum.kempstonMouse.enabled = mode === 'kempston';
  spectrum.amxMouse.enabled = mode === 'amx';
}

export function updateMousePosition(dx: number, dy: number, mode: MouseMode): void {
  if (!spectrum) return;
  if (mode === 'kempston') {
    spectrum.kempstonMouse.updatePosition(dx, dy);
  } else if (mode === 'amx') {
    spectrum.amxMouse.queueMovement(dx, dy);
  }
}

export function setMouseButton(button: number, pressed: boolean, mode: MouseMode): void {
  if (!spectrum) return;
  if (mode === 'kempston') {
    spectrum.kempstonMouse.setButton(button, pressed);
  } else if (mode === 'amx') {
    spectrum.amxMouse.setButton(button, pressed);
  }
}

// ── Multiface ────────────────────────────────────────────────────────

const MF_ROM_CDN = 'https://zx84files.bitsparse.com/roms/';

export async function loadMultifaceROM(s: Spectrum): Promise<boolean> {
  const variant = variantForModel(s.model);
  s.multiface.variant = variant;
  const cacheKey = `mf-rom-${variant}`;

  // Try IndexedDB cache first
  let data = await dbLoad(cacheKey);
  if (!data) {
    try {
      setStatus(`Fetching ${variantLabel(variant)} ROM...`);
      const url = MF_ROM_CDN + romFilename(variant);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = new Uint8Array(await resp.arrayBuffer());
      await dbSave(cacheKey, data);
    } catch (err) {
      console.warn('Failed to fetch Multiface ROM:', err);
      setStatus(`Failed to load ${variantLabel(variant)} ROM`);
      return false;
    }
  }
  s.multiface.loadROM(data);
  console.log('[MF] ROM loaded: variant=%s size=%d byte66=%s',
    variant, data.length, data[0x66]?.toString(16) ?? 'undef');
  setStatus(`${variantLabel(variant)} ROM loaded (${data.length} bytes)`);
  return true;
}

export function triggerNMI(): void {
  if (!spectrum) return;
  const mf = spectrum.multiface;
  console.log('[MF] triggerNMI: enabled=%s romLoaded=%s variant=%s romByte66=%s',
    mf.enabled, mf.romLoaded, mf.variant,
    mf.romLoaded ? mf.mfRom[0x66].toString(16) : 'N/A');
  if (!mf.enabled) { setStatus('Multiface not enabled'); return; }
  if (!mf.romLoaded) { setStatus('Multiface ROM not loaded'); return; }

  const flat = spectrum.cpu.memory;
  console.log('[MF] Before pageIn: flat[0x66]=%s pagedIn=%s',
    flat[0x66].toString(16), mf.pagedIn);
  mf.pressButton(flat, spectrum.cpu, spectrum.memory.slot0Bank);
  console.log('[MF] After pressButton: flat[0x66]=%s PC=%s pagedIn=%s',
    flat[0x66].toString(16), spectrum.cpu.pc.toString(16), mf.pagedIn);
  // Verify flat is still the live CPU memory
  console.log('[MF] flat === cpu.memory: %s, flat === memory.flat: %s',
    flat === spectrum.cpu.memory, flat === spectrum.memory.flat);
  setStatus('Multiface NMI triggered');
}

// ── Restore persisted media (tape + disks) without resetting ─────────

async function restoreMedia(): Promise<void> {
  if (!spectrum) return;

  // Restore tape
  const tape = await restoreTape();
  if (tape) {
    try {
      const ext = tape.name.toLowerCase().split('.').pop();
      const blocks = ext === 'tzx' ? parseTZX(tape.data) : spectrum.tape.parseTAP(tape.data);
      spectrum.tape.blocks = blocks;
      spectrum.tape.position = 0;
      spectrum.tape.paused = true;
      batch(() => {
        setTapeLoaded(true);
        setTapeName(tape.name);
        setTapeBlocks([...blocks]);
        setTapePosition(0);
        setTapePaused(true);
        setTapePlaying(false);
      });
      setStatus(`Tape restored: ${tape.name}`);
    } catch { /* ignore corrupt data */ }
  }

  // Restore disk A
  const diskA = await restoreDisk(0);
  if (diskA) {
    try {
      const image = parseDSK(diskA.data);
      spectrum.loadDisk(image, 0);
      setCurrentDiskInfo(image);
      setCurrentDiskName(diskA.name);
    } catch { /* ignore corrupt data */ }
  }

  // Restore disk B
  const diskB = await restoreDisk(1);
  if (diskB) {
    try {
      const image = parseDSK(diskB.data);
      spectrum.loadDisk(image, 1);
      setCurrentDiskInfoB(image);
      setCurrentDiskNameB(diskB.name);
    } catch { /* ignore corrupt data */ }
  }
}

// ── Init ────────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  const model = currentModel();

  let entry = await restoreROM(model);
  if (!entry) entry = await fetchDefaultROM(model);

  if (entry) {
    romData = entry.data;
    setRomStatus('');
    const hmrRestored = await createMachine();

    // Only restore persisted media if HMR state wasn't just restored
    if (!hmrRestored) {
      await restoreMedia();
    }
  }
}

// ── Transcribe ──────────────────────────────────────────────────────────

export function toggleTranscribeMode(mode: 'text'): void {
  if (transcribeMode() === mode) {
    setTranscribeMode('off');
  } else {
    setTranscribeMode(mode);
  }
}

// ── Renderer switching ──────────────────────────────────────────────────

export function switchRenderer(mode: 'webgl' | 'canvas'): void {
  settings.setRenderer(mode);
  settings.persistSetting('renderer', mode);
}



// ── Audio init ──────────────────────────────────────────────────────────

export function initAudio(): void {
  if (spectrum && !spectrum['audio'].running) {
    spectrum['audio'].init();
  }
}

// ── HMR state preservation ──────────────────────────────────────────────

const HMR_STATE_KEY = 'zx84-hmr-state';

export async function saveHMRState(): Promise<void> {
  if (!spectrum || !romData) return;

  try {
    // Stop emulation temporarily
    const wasPaused = emulationPaused();
    if (!wasPaused) spectrum.stop();

    // Save snapshot data as SZX
    const ayRegs = spectrum.ay.getRegisters();
    const szxData = await saveSZX(
      spectrum.cpu,
      spectrum.memory,
      spectrum.ula.borderColor,
      ayRegs,
      spectrum.ay.selectedReg
    );

    // Convert to base64 for localStorage
    const b64 = btoa(String.fromCharCode(...szxData));

    // Save state bundle
    const state = {
      snapshot: b64,
      model: currentModel(),
      timestamp: Date.now(),
    };

    localStorage.setItem(HMR_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Failed to save HMR state:', err);
  }
}

export async function restoreHMRState(): Promise<boolean> {
  try {
    const raw = localStorage.getItem(HMR_STATE_KEY);
    if (!raw) return false;

    const state = JSON.parse(raw);
    const age = Date.now() - state.timestamp;

    // Only restore if less than 60 seconds old (avoid restoring stale state)
    if (age > 60000) {
      localStorage.removeItem(HMR_STATE_KEY);
      return false;
    }

    // Decode snapshot
    const b64 = state.snapshot;
    const binary = atob(b64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }

    // Wait for spectrum to be ready
    if (!spectrum || !romData) return false;

    // Load SZX snapshot
    spectrum.stop();
    spectrum.reset();
    const result = await loadSZX(data, spectrum.cpu, spectrum.memory);

    // Apply paging state for 128K
    if (result.is128K) {
      spectrum.memory.port7FFD = result.port7FFD;
      spectrum.memory.currentBank = result.port7FFD & 0x07;
      spectrum.memory.currentROM = (result.port7FFD >> 4) & 1;
      spectrum.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
      if (isPlus2AClass(currentModel())) {
        spectrum.memory.port1FFD = result.port1FFD;
        spectrum.memory.specialPaging = (result.port1FFD & 1) !== 0;
      }
      spectrum.memory.applyBanking();
    }

    spectrum.ula.borderColor = result.borderColor;
    spectrum.cpu.memory = spectrum.memory.flat;

    // Restore AY state if present
    if (result.ayRegs) {
      spectrum.ay.setRegisters(result.ayRegs);
      if (result.ayCurrentReg !== undefined) {
        spectrum.ay.selectedReg = result.ayCurrentReg;
      }
    }

    spectrum.start();

    // Clean up
    localStorage.removeItem(HMR_STATE_KEY);

    setStatus('HMR: State restored');
    return true;
  } catch (err) {
    console.warn('Failed to restore HMR state:', err);
    localStorage.removeItem(HMR_STATE_KEY);
    return false;
  }
}

// ── HMR cleanup ─────────────────────────────────────────────────────────

export function destroy(): void {
  floppySound?.destroy();
  floppySound = null;
  if (spectrum) {
    spectrum.destroy();
    spectrum = null;
  }
}
