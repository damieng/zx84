/**
 * ngspecz - ZX Spectrum Emulator
 * Entry point: DOM wiring, file I/O, ROM persistence, machine lifecycle.
 */

import { Spectrum, type SpectrumModel } from './spectrum.ts';
import { loadSNA } from './formats/sna.ts';
import { loadZ80 } from './formats/z80format.ts';
import { diagnoseStuckLoop } from './diagnostics.ts';
import { unzip } from './formats/zip.ts';
import { showFilePicker } from './ui/zip-picker.ts';

// ── IndexedDB ROM persistence ──────────────────────────────────────────────

const DB_NAME = 'ngspecz';
const DB_VERSION = 1;
const STORE_NAME = 'roms';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSave(key: string, data: Uint8Array): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbLoad(key: string): Promise<Uint8Array | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// ── In-memory ROM cache (keyed by model) ───────────────────────────────────

interface ROMEntry {
  data: Uint8Array;
  label: string;
}

const romCache: Record<string, ROMEntry> = {};

async function persistROM(model: SpectrumModel, data: Uint8Array, label: string): Promise<void> {
  romCache[model] = { data, label };
  await dbSave(`rom-${model}`, data);
  try { localStorage.setItem(`ngspecz-rom-label-${model}`, label); } catch { /* */ }
}

async function restoreROM(model: SpectrumModel): Promise<ROMEntry | null> {
  if (romCache[model]) return romCache[model];
  const data = await dbLoad(`rom-${model}`);
  if (!data) return null;
  const label = localStorage.getItem(`ngspecz-rom-label-${model}`) || 'saved ROM';
  romCache[model] = { data, label };
  return romCache[model];
}

function saveModel(model: SpectrumModel): void {
  try { localStorage.setItem('ngspecz-model', model); } catch { /* */ }
}

function loadSavedModel(): SpectrumModel | null {
  try {
    const val = localStorage.getItem('ngspecz-model');
    if (val === '48k' || val === '128k') return val;
  } catch { /* */ }
  return null;
}

// ── Snapshot persistence ────────────────────────────────────────────────────

function saveSnapshot(data: Uint8Array, name: string): void {
  try {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    localStorage.setItem('snapshot', btoa(binary));
    localStorage.setItem('snapshot-name', name);
  } catch { /* quota exceeded */ }
}

function loadSavedSnapshot(): { data: Uint8Array; name: string } | null {
  try {
    const b64 = localStorage.getItem('snapshot');
    const name = localStorage.getItem('snapshot-name');
    if (!b64 || !name) return null;
    const binary = atob(b64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }
    return { data, name };
  } catch { return null; }
}

// ── DOM refs ───────────────────────────────────────────────────────────────

let spectrum: Spectrum | null = null;
let romData: Uint8Array | null = null;
let currentModel: SpectrumModel = '48k';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const modelSelect = document.getElementById('model') as HTMLSelectElement;
const romInput = document.getElementById('rom-input') as HTMLInputElement;
const romBtn = document.getElementById('rom-btn') as HTMLSpanElement;
const romStatus = document.getElementById('rom-status') as HTMLSpanElement;
const snapInput = document.getElementById('snap-input') as HTMLInputElement;
const snapBtn = document.getElementById('snap-btn') as HTMLSpanElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const stuckBtn = document.getElementById('stuck-btn') as HTMLButtonElement;
const diagCopy = document.getElementById('diag-copy') as HTMLButtonElement;
const diagOutput = document.getElementById('diag-output') as HTMLTextAreaElement;

const scaleSelect = document.getElementById('scale') as HTMLSelectElement;
const crtToggle = document.getElementById('crt-toggle') as HTMLInputElement;

const ledKbd = document.getElementById('led-kbd') as HTMLDivElement;
const ledKemp = document.getElementById('led-kemp') as HTMLDivElement;
const ledTape = document.getElementById('led-tape') as HTMLDivElement;
const ledBeep = document.getElementById('led-beep') as HTMLDivElement;
const ledAy = document.getElementById('led-ay') as HTMLDivElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function setRomStatus(msg: string): void {
  romStatus.textContent = msg;
}

function updateActivityLEDs(): void {
  if (!spectrum) return;
  tickAutoType();
  const a = spectrum.activity;
  // KBD: ULA port reads (keyboard polling, low frequency)
  ledKbd.classList.toggle('on', a.ulaReads > 0);
  // KEMP: Kempston joystick port reads
  ledKemp.classList.toggle('on', a.kempstonReads > 0);
  // TAPE: high-frequency ULA reads indicate tape loading (>100/frame)
  ledTape.classList.toggle('on', a.ulaReads > 100);
  // BEEP: beeper bit toggled during this frame
  ledBeep.classList.toggle('on', a.beeperToggled);
  // AY: AY register writes during this frame
  ledAy.classList.toggle('on', a.ayWrites > 0);
}

// ── Auto-type for TAP auto-loading ──────────────────────────────────────────

type KeySpec = { row: number; bit: number };

// 48K: J → LOAD keyword, SymShift+P → ", SymShift+P → ", ENTER
const AUTO_LOAD_48K: KeySpec[][] = [
  [{ row: 6, bit: 3 }],                        // J (LOAD in K mode)
  [{ row: 7, bit: 1 }, { row: 5, bit: 0 }],   // SymShift + P (")
  [{ row: 7, bit: 1 }, { row: 5, bit: 0 }],   // SymShift + P (")
  [{ row: 6, bit: 0 }],                        // ENTER
];

// 128K: ENTER selects "Tape Loader" from the boot menu
const AUTO_LOAD_128K: KeySpec[][] = [
  [{ row: 6, bit: 0 }],                        // ENTER
];

const AUTO_TYPE_INIT_DELAY = 100; // frames before first keystroke
const AUTO_TYPE_HOLD = 5;        // frames to hold each key
const AUTO_TYPE_GAP = 5;         // frames gap between keystrokes

let autoTypeKeys: KeySpec[][] = [];
let autoTypeFrame = 0;

function startAutoType(sequence: KeySpec[][]): void {
  cancelAutoType();
  autoTypeKeys = sequence;
  autoTypeFrame = -AUTO_TYPE_INIT_DELAY;
}

function cancelAutoType(): void {
  if (autoTypeKeys.length === 0 || !spectrum) return;
  // Release any currently held keys
  const f = autoTypeFrame - 1;
  if (f >= 0) {
    const cycle = AUTO_TYPE_HOLD + AUTO_TYPE_GAP;
    const step = Math.floor(f / cycle);
    const phase = f % cycle;
    if (step < autoTypeKeys.length && phase < AUTO_TYPE_HOLD) {
      for (const key of autoTypeKeys[step]) {
        spectrum.keyboard.setKey(key.row, key.bit, false);
      }
    }
  }
  autoTypeKeys = [];
}

function tickAutoType(): void {
  if (autoTypeKeys.length === 0 || !spectrum) return;

  autoTypeFrame++;
  if (autoTypeFrame <= 0) return; // still in initial delay

  const f = autoTypeFrame - 1;
  const cycle = AUTO_TYPE_HOLD + AUTO_TYPE_GAP;
  const step = Math.floor(f / cycle);
  const phase = f % cycle;

  if (step >= autoTypeKeys.length) {
    autoTypeKeys = [];
    return;
  }

  if (phase === 0) {
    for (const key of autoTypeKeys[step]) {
      spectrum.keyboard.setKey(key.row, key.bit, true);
    }
  } else if (phase === AUTO_TYPE_HOLD) {
    for (const key of autoTypeKeys[step]) {
      spectrum.keyboard.setKey(key.row, key.bit, false);
    }
  }
}

function getSavedScale(): number {
  try {
    const v = localStorage.getItem('ngspecz-scale');
    if (v === '1' || v === '2' || v === '3') return Number(v);
  } catch { /* */ }
  return 2;
}

function getSavedCRT(): boolean {
  try { return localStorage.getItem('ngspecz-crt') === '1'; } catch { return false; }
}

function applyDisplaySettings(): void {
  if (!spectrum) return;
  const scale = Number(scaleSelect.value);
  spectrum.display.setScale(scale);
  spectrum.display.setCRT(crtToggle.checked);
}

function createMachine(): void {
  if (spectrum) {
    spectrum.destroy();
  }

  spectrum = new Spectrum(currentModel, canvas);
  spectrum.onStatus = setStatus;
  spectrum.onFrame = updateActivityLEDs;
  applyDisplaySettings();

  if (romData) {
    spectrum.loadROM(romData);
    spectrum.reset();
    spectrum.start();
  }
}

// ── Wire file-pick buttons to hidden inputs ────────────────────────────────

romBtn.addEventListener('click', () => romInput.click());
snapBtn.addEventListener('click', () => snapInput.click());

// ── Model selector ─────────────────────────────────────────────────────────

modelSelect.addEventListener('change', async () => {
  currentModel = modelSelect.value as SpectrumModel;
  saveModel(currentModel);

  // Try to load saved ROM for this model
  const entry = await restoreROM(currentModel);
  if (entry) {
    romData = entry.data;
    setRomStatus(`${currentModel.toUpperCase()} — ${entry.label}`);
  } else {
    romData = null;
    setRomStatus('');
    setStatus(`No ROM saved for ${currentModel.toUpperCase()} — load one`);
  }

  createMachine();
});

// ── Scale / CRT controls ────────────────────────────────────────────────────

scaleSelect.addEventListener('change', () => {
  const scale = Number(scaleSelect.value);
  if (spectrum) spectrum.display.setScale(scale);
  try { localStorage.setItem('ngspecz-scale', String(scale)); } catch { /* */ }
});

crtToggle.addEventListener('change', () => {
  if (spectrum) spectrum.display.setCRT(crtToggle.checked);
  try { localStorage.setItem('ngspecz-crt', crtToggle.checked ? '1' : '0'); } catch { /* */ }
});

// ── ROM file input ─────────────────────────────────────────────────────────

async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  romData = data;

  // Detect model from ROM size
  let detectedModel: SpectrumModel;
  if (data.length >= 32768) {
    detectedModel = '128k';
  } else if (data.length >= 16384) {
    detectedModel = '48k';
  } else {
    setStatus(`ROM too small (${data.length} bytes)`);
    return;
  }

  currentModel = detectedModel;
  modelSelect.value = detectedModel;
  saveModel(detectedModel);

  await persistROM(detectedModel, data, fileLabel);
  setRomStatus(`${detectedModel.toUpperCase()} — ${fileLabel}`);

  createMachine();
}

romInput.addEventListener('change', async () => {
  const files = romInput.files;
  if (!files || files.length === 0) return;

  let data: Uint8Array;
  let label: string;

  if (files.length === 1) {
    data = new Uint8Array(await files[0].arrayBuffer());
    label = files[0].name;
  } else {
    const sorted = Array.from(files).sort((a, b) => a.name.localeCompare(b.name));
    const buffers = await Promise.all(sorted.map(f => f.arrayBuffer()));
    const totalLen = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    data = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of buffers) {
      data.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    label = sorted.map(f => f.name).join(' + ');
  }

  await applyROM(data, label);
});

// ── Snapshot loading ──────────────────────────────────────────────────────

async function applySnapshot(data: Uint8Array, filename: string): Promise<boolean> {
  if (!spectrum) {
    setStatus('Load a ROM first');
    return false;
  }

  const ext = filename.toLowerCase().split('.').pop();

  try {
    if (ext === 'sna') {
      if (data.length > 49179 && currentModel !== '128k') {
        const entry128 = await restoreROM('128k');
        if (entry128) {
          currentModel = '128k';
          modelSelect.value = '128k';
          romData = entry128.data;
          setRomStatus(`128K — ${entry128.label}`);
          createMachine();
        } else {
          setStatus('128K SNA requires a 128K ROM — load one first');
          return false;
        }
      }

      spectrum!.stop();
      spectrum!.reset();
      const result = loadSNA(data, spectrum!.cpu, spectrum!.memory);
      spectrum!.ula.borderColor = result.borderColor;
      spectrum!.cpu.memory = spectrum!.memory.flat;
      spectrum!.start();
      setStatus(`Loaded ${result.is128K ? '128K' : '48K'} SNA: ${filename}`);
    } else if (ext === 'z80') {
      spectrum.stop();
      spectrum.reset();
      const result = loadZ80(data, spectrum.cpu, spectrum.memory);

      if (result.is128K && currentModel !== '128k') {
        const entry128 = await restoreROM('128k');
        if (entry128) {
          currentModel = '128k';
          modelSelect.value = '128k';
          romData = entry128.data;
          setRomStatus(`128K — ${entry128.label}`);
          createMachine();
          spectrum!.stop();
          spectrum!.reset();
          loadZ80(data, spectrum!.cpu, spectrum!.memory);
          spectrum!.ula.borderColor = result.borderColor;
          spectrum!.cpu.memory = spectrum!.memory.flat;
          spectrum!.start();
        } else {
          setStatus('128K .z80 snapshot requires a 128K ROM — load one first');
          return false;
        }
      } else {
        spectrum.ula.borderColor = result.borderColor;
        spectrum.cpu.memory = spectrum.memory.flat;
        spectrum.start();
      }
      setStatus(`Loaded ${result.is128K ? '128K' : '48K'} .z80: ${filename}`);
    } else if (ext === 'tap') {
      spectrum.loadTAP(data);
      spectrum.tape.rewind();
      spectrum.stop();
      spectrum.reset();
      spectrum.start();
      startAutoType(currentModel === '128k' ? AUTO_LOAD_128K : AUTO_LOAD_48K);
      setStatus(`TAP loaded — auto-loading ${filename}`);
    } else {
      setStatus(`Unknown format: .${ext}`);
      return false;
    }
  } catch (e) {
    setStatus(`Error: ${(e as Error).message}`);
    return false;
  }
  return true;
}

async function handleZipFile(data: Uint8Array): Promise<void> {
  let entries;
  try {
    entries = await unzip(data);
  } catch (e) {
    setStatus(`ZIP error: ${(e as Error).message}`);
    return;
  }

  if (entries.length === 0) {
    setStatus('ZIP contains no loadable files');
    return;
  }

  let chosen;
  if (entries.length === 1) {
    chosen = entries[0];
  } else {
    const names = entries.map(e => e.name);
    const picked = await showFilePicker(names);
    if (!picked) {
      setStatus('Load cancelled');
      return;
    }
    chosen = entries.find(e => e.name === picked)!;
  }

  if (await applySnapshot(chosen.data, chosen.name)) {
    saveSnapshot(chosen.data, chosen.name);
  }
}

snapInput.addEventListener('change', async () => {
  const file = snapInput.files?.[0];
  if (!file) return;

  const data = new Uint8Array(await file.arrayBuffer());

  if (file.name.toLowerCase().endsWith('.zip')) {
    await handleZipFile(data);
  } else {
    if (await applySnapshot(data, file.name)) {
      saveSnapshot(data, file.name);
    }
  }

  snapInput.value = '';
});

// ── Reset ──────────────────────────────────────────────────────────────────

resetBtn.addEventListener('click', () => {
  cancelAutoType();
  if (spectrum) {
    spectrum.reset();
    if (romData) spectrum.start();
  }
  diagOutput.value = '';
  try {
    localStorage.removeItem('snapshot');
    localStorage.removeItem('snapshot-name');
  } catch { /* */ }
});

// ── Joystick ────────────────────────────────────────────────────────────

const joyType = document.getElementById('joy-type') as HTMLSelectElement;
const joyBtns = {
  up:    document.getElementById('joy-up')!,
  down:  document.getElementById('joy-down')!,
  left:  document.getElementById('joy-left')!,
  right: document.getElementById('joy-right')!,
  fire:  document.getElementById('joy-fire')!,
};

// Kempston bits: 0=right, 1=left, 2=down, 3=up, 4=fire
const KEMPSTON_BITS: Record<string, number> = {
  right: 0, left: 1, down: 2, up: 3, fire: 4,
};

// Cursor joystick: 5=left, 6=down, 7=up, 8=right, 0=fire
const CURSOR_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 4 }, // 5
  down:  { row: 4, bit: 4 }, // 6
  up:    { row: 4, bit: 3 }, // 7
  right: { row: 4, bit: 2 }, // 8
  fire:  { row: 4, bit: 0 }, // 0
};

// Sinclair IF2 (port 2, left joystick): 1=left, 2=right, 3=down, 4=up, 5=fire
const SINCLAIR2_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 0 }, // 1
  right: { row: 3, bit: 1 }, // 2
  down:  { row: 3, bit: 2 }, // 3
  up:    { row: 3, bit: 3 }, // 4
  fire:  { row: 3, bit: 4 }, // 5
};

// Sinclair 1 (right joystick): 6=left, 7=right, 8=down, 9=up, 0=fire
const SINCLAIR1_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 4, bit: 4 }, // 6
  right: { row: 4, bit: 3 }, // 7
  down:  { row: 4, bit: 2 }, // 8
  up:    { row: 4, bit: 1 }, // 9
  fire:  { row: 4, bit: 0 }, // 0
};

function joyPress(dir: string, pressed: boolean): void {
  if (!spectrum) return;
  const mode = joyType.value;

  if (mode === 'kempston') {
    const bit = KEMPSTON_BITS[dir];
    if (pressed) {
      spectrum.kempstonState |= (1 << bit);
    } else {
      spectrum.kempstonState &= ~(1 << bit);
    }
  } else {
    const map = mode === 'cursor' ? CURSOR_KEYS
              : mode === 'sinclair2' ? SINCLAIR2_KEYS
              : SINCLAIR1_KEYS;
    const key = map[dir];
    if (key) spectrum.keyboard.setKey(key.row, key.bit, pressed);
  }
}

// Mouse/touch handlers for joystick buttons
for (const [dir, el] of Object.entries(joyBtns)) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    el.classList.add('pressed');
    joyPress(dir, true);
  });
  el.addEventListener('mouseup', (e) => {
    e.preventDefault();
    el.classList.remove('pressed');
    joyPress(dir, false);
  });
  el.addEventListener('mouseleave', () => {
    el.classList.remove('pressed');
    joyPress(dir, false);
  });
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    el.classList.add('pressed');
    joyPress(dir, true);
  });
  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    el.classList.remove('pressed');
    joyPress(dir, false);
  });
  el.addEventListener('touchcancel', () => {
    el.classList.remove('pressed');
    joyPress(dir, false);
  });
}

// ── Stuck Loop diagnostics ─────────────────────────────────────────────────

stuckBtn.addEventListener('click', () => {
  if (!spectrum) {
    diagOutput.value = 'No machine running.';
    return;
  }
  // Pause emulation, run diagnostic, resume
  spectrum.stop();
  diagOutput.value = diagnoseStuckLoop(spectrum.cpu);
  spectrum.start();
});

diagCopy.addEventListener('click', () => {
  if (diagOutput.value) {
    navigator.clipboard.writeText(diagOutput.value);
  }
});

// ── Keyboard ───────────────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  if (!spectrum) return;
  cancelAutoType();
  if (spectrum.keyboard.handleKeyEvent(e.code, true)) {
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!spectrum) return;
  if (spectrum.keyboard.handleKeyEvent(e.code, false)) {
    e.preventDefault();
  }
}

function onFirstClick(): void {
  if (spectrum && !spectrum['audio'].running) {
    spectrum['audio'].init();
  }
}

document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
document.addEventListener('click', onFirstClick, { once: true });

// ── Restore saved state on startup ─────────────────────────────────────────

async function init(): Promise<void> {
  // Restore display settings into UI before any machine creation
  const savedScale = getSavedScale();
  scaleSelect.value = String(savedScale);
  const savedCRT = getSavedCRT();
  crtToggle.checked = savedCRT;

  const savedModel = loadSavedModel();
  if (savedModel) {
    currentModel = savedModel;
    modelSelect.value = savedModel;
  }

  const entry = await restoreROM(currentModel);
  if (entry) {
    romData = entry.data;
    setRomStatus(`${currentModel.toUpperCase()} — ${entry.label}`);
    setStatus('Restored ROM from last session');
    createMachine();

    // Restore saved snapshot
    const snap = loadSavedSnapshot();
    if (snap) {
      await applySnapshot(snap.data, snap.name);
    }
  } else {
    setStatus('Load a ROM to start');
  }
}

init();

// ── Vite HMR cleanup ─────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (spectrum) {
      spectrum.destroy();
      spectrum = null;
    }
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('click', onFirstClick);
  });
  import.meta.hot.accept();
}
