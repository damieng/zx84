/**
 * ngspecz - ZX Spectrum Emulator
 * Entry point: DOM wiring, file I/O, ROM persistence, machine lifecycle.
 */

import { Spectrum, type SpectrumModel, is128kClass } from './spectrum.ts';
import { Z80 } from './cores/z80.ts';
import { loadSNA, saveSNA } from './formats/sna.ts';
import { loadZ80 } from './formats/z80format.ts';
import { diagnoseStuckLoop } from './diagnostics.ts';
import { unzip } from './formats/zip.ts';
import { parseTZX } from './formats/tzx.ts';
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
    if (val === '48k' || val === '128k' || val === '+2') return val as SpectrumModel;
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
const romBtn = document.getElementById('rom-btn') as HTMLButtonElement;
const romStatus = document.getElementById('rom-status') as HTMLSpanElement;
const snapInput = document.getElementById('snap-input') as HTMLInputElement;
const snapLoadBtn = document.getElementById('snap-load-btn') as HTMLButtonElement;
const snapSaveBtn = document.getElementById('snap-save-btn') as HTMLButtonElement;
const tapeInput = document.getElementById('tape-input') as HTMLInputElement;
const tapeLoadBtn = document.getElementById('tape-load-btn') as HTMLButtonElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const stuckBtn = document.getElementById('stuck-btn') as HTMLButtonElement;
const diagCopy = document.getElementById('diag-copy') as HTMLButtonElement;
const diagOutput = document.getElementById('diag-output') as HTMLTextAreaElement;

const scaleSelect = document.getElementById('scale') as HTMLSelectElement;
const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
const volumeValue = document.getElementById('volume-value') as HTMLSpanElement;
const smoothingSlider = document.getElementById('smoothing-slider') as HTMLInputElement;
const smoothingValue = document.getElementById('smoothing-value') as HTMLSpanElement;
const curvatureSlider = document.getElementById('curvature-slider') as HTMLInputElement;
const curvatureValue = document.getElementById('curvature-value') as HTMLSpanElement;
const scanlinesSlider = document.getElementById('scanlines-slider') as HTMLInputElement;
const scanlinesValue = document.getElementById('scanlines-value') as HTMLSpanElement;
const dotmaskSelect = document.getElementById('dotmask-select') as HTMLSelectElement;

const ledKbd = document.getElementById('led-kbd') as HTMLDivElement;
const ledKemp = document.getElementById('led-kemp') as HTMLDivElement;
const ledTape = document.getElementById('led-tape') as HTMLDivElement;
const ledLoad = document.getElementById('led-load') as HTMLDivElement;
const ledRst16 = document.getElementById('led-rst16') as HTMLDivElement;
const ledBeep = document.getElementById('led-beep') as HTMLDivElement;
const ledAy = document.getElementById('led-ay') as HTMLDivElement;

const banksOutput = document.getElementById('banks-output') as HTMLPreElement;

const regsOutput = document.getElementById('regs-output') as HTMLPreElement;

const tapeBlocksContainer = document.getElementById('tape-blocks') as HTMLDivElement;
const tapeRewindBtn = document.getElementById('tape-rewind') as HTMLButtonElement;
const tapePrevBtn = document.getElementById('tape-prev') as HTMLButtonElement;
const tapePauseBtn = document.getElementById('tape-pause') as HTMLButtonElement;
const tapeNextBtn = document.getElementById('tape-next') as HTMLButtonElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function setRomStatus(msg: string): void {
  romStatus.textContent = msg;
  romStatus.style.display = msg ? '' : 'none';
}

function updateActivityLEDs(): void {
  if (!spectrum) return;
  tickAutoType();
  const a = spectrum.activity;
  ledKbd.classList.toggle('on', a.ulaReads > 0);
  ledKemp.classList.toggle('on', a.kempstonReads > 0);
  ledTape.classList.toggle('on', a.ulaReads > 100);
  ledLoad.classList.toggle('on', a.tapeLoads > 0);
  ledRst16.classList.toggle('on', a.rst16Calls > 0);
  ledBeep.classList.toggle('on', a.beeperToggled);
  ledAy.classList.toggle('on', a.ayWrites > 0);
  updateTapeHighlight();
  updateRegsDisplay();
}

// ── Tape viewer panel ───────────────────────────────────────────────────────

import type { TAPBlock } from './formats/tap.ts';

const HEADER_TYPES: Record<number, string> = {
  0: 'Program',
  1: 'Number array',
  2: 'Character array',
  3: 'Bytes',
};

function tzxTag(block: TAPBlock): string {
  if (!block.tzx) return '';
  const t = block.tzx.type;
  if (t === 'standard') return ' [STD]';
  if (t === 'turbo') return ' [TURBO]';
  if (t === 'pure-data') return ' [PURE]';
  return '';
}

function tzxTimingDetail(block: TAPBlock): string {
  if (!block.tzx) return '';
  const m = block.tzx;
  const parts: string[] = [`pause=${m.pause}ms`];
  if (m.pilotPulse !== undefined) parts.push(`pilot=${m.pilotPulse}T x${m.pilotCount}`);
  if (m.syncPulse1 !== undefined) parts.push(`sync=${m.syncPulse1}/${m.syncPulse2}T`);
  if (m.bit0Pulse !== undefined) parts.push(`bit=${m.bit0Pulse}/${m.bit1Pulse}T`);
  if (m.usedBits !== undefined && m.usedBits !== 8) parts.push(`used=${m.usedBits}bits`);
  return parts.join(' ');
}

function parseTapeBlockMeta(block: TAPBlock, index: number): { line: string; detail: string } {
  const tag = tzxTag(block);
  const timing = tzxTimingDetail(block);

  if (block.flag === 0x00 && block.data.length >= 15) {
    // Header block
    const typeId = block.data[0];
    const typeName = HEADER_TYPES[typeId] ?? `Type ${typeId}`;
    let filename = '';
    for (let i = 1; i <= 10; i++) filename += String.fromCharCode(block.data[i]);
    const dataLen = block.data[11] | (block.data[12] << 8);
    const param1 = block.data[13] | (block.data[14] << 8);
    const line = `${index}: H "${filename.trimEnd()}"${tag}`;
    let detail = `${typeName} ${dataLen}b`;
    if (typeId === 0 && param1 < 10000) detail += ` LINE ${param1}`;
    else if (typeId === 3) detail += ` @ ${param1}`;
    if (timing) detail += `\n${timing}`;
    return { line, detail };
  }
  // Data block
  const size = block.data.length;
  let detail = '';
  if (timing) detail = timing;
  return { line: `${index}: D ${size}b${tag}`, detail };
}

let tapeBlockElements: HTMLDivElement[] = [];
let lastRenderedTapePosition = -1;

function buildTapeBlockList(): void {
  tapeBlocksContainer.innerHTML = '';
  tapeBlockElements = [];
  lastRenderedTapePosition = -1;

  if (!spectrum || !spectrum.tape.loaded) {
    const empty = document.createElement('div');
    empty.className = 'tape-empty';
    empty.textContent = 'No tape loaded';
    tapeBlocksContainer.appendChild(empty);
    return;
  }

  const blocks = spectrum.tape.blocks;

  for (let i = 0; i < blocks.length; i++) {
    const meta = parseTapeBlockMeta(blocks[i], i);
    const el = document.createElement('div');
    el.className = 'tape-block';
    el.textContent = meta.line;
    if (meta.detail) {
      for (const line of meta.detail.split('\n')) {
        const detailEl = document.createElement('div');
        detailEl.className = 'tb-detail';
        detailEl.textContent = line;
        el.appendChild(detailEl);
      }
    }
    el.addEventListener('click', () => {
      if (spectrum) {
        spectrum.tape.position = i;
        lastRenderedTapePosition = -1; // force refresh
        updateTapeHighlight();
      }
    });
    tapeBlocksContainer.appendChild(el);
    tapeBlockElements.push(el);
  }

  updateTapeHighlight();
}

function updateTapeHighlight(): void {
  if (!spectrum || !spectrum.tape.loaded) return;
  const pos = spectrum.tape.position;
  if (pos === lastRenderedTapePosition) return;
  lastRenderedTapePosition = pos;

  for (let i = 0; i < tapeBlockElements.length; i++) {
    const el = tapeBlockElements[i];
    el.classList.toggle('played', i < pos);
    el.classList.toggle('current', i === pos);
  }

  // Auto-scroll current block into view
  if (pos < tapeBlockElements.length) {
    tapeBlockElements[pos].scrollIntoView({ block: 'nearest' });
  }
}

// Transport controls
tapeRewindBtn.addEventListener('click', () => {
  if (!spectrum) return;
  spectrum.tape.rewind();
  lastRenderedTapePosition = -1;
  updateTapeHighlight();
});

tapePrevBtn.addEventListener('click', () => {
  if (!spectrum) return;
  if (spectrum.tape.position > 0) spectrum.tape.position--;
  lastRenderedTapePosition = -1;
  updateTapeHighlight();
});

tapePauseBtn.addEventListener('click', () => {
  if (!spectrum) return;
  spectrum.tape.paused = !spectrum.tape.paused;
  tapePauseBtn.classList.toggle('active', spectrum.tape.paused);
  tapePauseBtn.textContent = spectrum.tape.paused ? '\u25B6' : '\u23F8';
  tapePauseBtn.title = spectrum.tape.paused ? 'Resume' : 'Pause';
});

tapeNextBtn.addEventListener('click', () => {
  if (!spectrum) return;
  if (spectrum.tape.position < spectrum.tape.blocks.length) spectrum.tape.position++;
  lastRenderedTapePosition = -1;
  updateTapeHighlight();
});

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
    if (v === '1' || v === '2' || v === '3' || v === '4') return Number(v);
  } catch { /* */ }
  return 2;
}

function getSaved(key: string, fallback: string): string {
  try { return localStorage.getItem(`ngspecz-${key}`) ?? fallback; } catch { return fallback; }
}

function applyDisplaySettings(): void {
  if (!spectrum) return;
  spectrum.display.setScale(Number(scaleSelect.value));
  spectrum.display.setSmoothing(Number(smoothingSlider.value) / 100);
  spectrum.display.setCurvature(Number(curvatureSlider.value) / 100 * 0.15);
  spectrum.display.setScanlines(Number(scanlinesSlider.value) / 100);
  spectrum.display.setDotmask(Number(dotmaskSelect.value) as 0 | 1 | 2);
  spectrum['audio'].setVolume(Number(volumeSlider.value) / 100);
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

  buildTapeBlockList(); // hides panel — new machine has no tape
  unpause();
}

// ── Wire file-pick buttons to hidden inputs ────────────────────────────────

romBtn.addEventListener('click', () => romInput.click());
snapLoadBtn.addEventListener('click', () => snapInput.click());
tapeLoadBtn.addEventListener('click', () => tapeInput.click());

// ── Save snapshot ───────────────────────────────────────────────────────────

snapSaveBtn.addEventListener('click', () => {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused;
  if (!wasPaused) spectrum.stop();

  const data = saveSNA(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor);
  const model = is128kClass(currentModel) ? '128k' : '48k';
  const filename = `ngspecz-${model}.sna`;

  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  if (!wasPaused) spectrum.start();
  setStatus(`Saved ${filename}`);
});

// ── Play / Pause ────────────────────────────────────────────────────────────

let emulationPaused = false;

function updatePlayBtn(): void {
  playBtn.textContent = emulationPaused ? '\u25B6' : '\u23F8';
  playBtn.title = emulationPaused ? 'Resume emulation' : 'Pause emulation';
}

function unpause(): void {
  emulationPaused = false;
  updatePlayBtn();
}

// ── Register & bank display ─────────────────────────────────────────────────

function hex8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

function flagHtml(label: string, on: boolean): string {
  return on
    ? `<span class="flag-on">${label}</span>`
    : `<span class="flag-off">${label.toLowerCase()}</span>`;
}

function renderRegs(cpu: Z80): string {
  const f = cpu.f;
  const flags = [
    flagHtml('S', (f & Z80.FLAG_S) !== 0),
    flagHtml('Z', (f & Z80.FLAG_Z) !== 0),
    flagHtml('H', (f & Z80.FLAG_H) !== 0),
    flagHtml('P', (f & Z80.FLAG_PV) !== 0),
    flagHtml('N', (f & Z80.FLAG_N) !== 0),
    flagHtml('C', (f & Z80.FLAG_C) !== 0),
  ].join(' ');

  const n = '<span class="reg-name">';
  const e = '</span>';
  return [
    `${n}AF${e}  ${hex16(cpu.af)}    ${n}AF'${e} ${hex16((cpu.a_ << 8) | cpu.f_)}`,
    `${n}BC${e}  ${hex16(cpu.bc)}    ${n}BC'${e} ${hex16((cpu.b_ << 8) | cpu.c_)}`,
    `${n}DE${e}  ${hex16(cpu.de)}    ${n}DE'${e} ${hex16((cpu.d_ << 8) | cpu.e_)}`,
    `${n}HL${e}  ${hex16(cpu.hl)}    ${n}HL'${e} ${hex16((cpu.h_ << 8) | cpu.l_)}`,
    `${n}IX${e}  ${hex16(cpu.ix)}    ${n}IY${e}  ${hex16(cpu.iy)}`,
    `${n}SP${e}  ${hex16(cpu.sp)}    ${n}PC${e}  ${hex16(cpu.pc)}`,
    `${n}IR${e}  ${hex8(cpu.i)}${hex8(cpu.r)}    ${n}IM${e}  ${cpu.im}`,
    ``,
    `${n}Flags${e} ${flags}`,
    `${n}IFF${e}   ${cpu.iff1 ? 'EI' : 'DI'}${cpu.halted ? '  HALT' : ''}`,
  ].join('\n');
}

function renderBanks(mem: import('./memory.ts').SpectrumMemory): string {
  const n = '<span class="reg-name">';
  const e = '</span>';
  const scr = (mem.port7FFD & 0x08) ? 7 : 5;
  return [
    `${n}ROM${e}   ${mem.currentROM}  ${mem.currentROM === 0 ? '(128K editor)' : '(48K BASIC)'}`,
    `${n}Bank${e}  ${mem.currentBank}  ${n}at${e} C000-FFFF`,
    `${n}Screen${e} ${scr}  ${n}Lock${e} ${mem.pagingLocked ? 'Yes' : 'No'}`,
    `${n}7FFD${e}  ${hex8(mem.port7FFD)}`,
  ].join('\n');
}

function updateRegsDisplay(): void {
  if (!spectrum) return;
  regsOutput.innerHTML = renderRegs(spectrum.cpu);
  if (is128kClass(currentModel)) {
    banksOutput.innerHTML = renderBanks(spectrum.memory);
    banksOutput.style.display = '';
  } else {
    banksOutput.style.display = 'none';
  }
}

playBtn.addEventListener('click', () => {
  if (!spectrum) return;
  if (emulationPaused) {
    spectrum.start();
  } else {
    spectrum.stop();
    updateRegsDisplay(); // snapshot registers at the moment of pause
  }
  emulationPaused = !emulationPaused;
  updatePlayBtn();
});

// ── Model selector ─────────────────────────────────────────────────────────

modelSelect.addEventListener('change', async () => {
  currentModel = modelSelect.value as SpectrumModel;
  saveModel(currentModel);

  // Try to load saved ROM for this model
  const entry = await restoreROM(currentModel);
  if (entry) {
    romData = entry.data;
    setRomStatus('');
  } else {
    romData = null;
    setRomStatus('');
    setStatus(`No ROM saved for ${currentModel.toUpperCase()} — load one`);
  }

  createMachine();
  modelSelect.blur(); // release focus so keys go to the emulator, not the dropdown
});

// ── Display / Sound controls ─────────────────────────────────────────────────

scaleSelect.addEventListener('change', () => {
  const scale = Number(scaleSelect.value);
  if (spectrum) spectrum.display.setScale(scale);
  try { localStorage.setItem('ngspecz-scale', String(scale)); } catch { /* */ }
});

volumeSlider.addEventListener('input', () => {
  const v = Number(volumeSlider.value);
  volumeValue.textContent = String(v);
  if (spectrum) spectrum['audio'].setVolume(v / 100);
  try { localStorage.setItem('ngspecz-volume', String(v)); } catch { /* */ }
});

smoothingSlider.addEventListener('input', () => {
  const v = Number(smoothingSlider.value);
  smoothingValue.textContent = String(v);
  if (spectrum) spectrum.display.setSmoothing(v / 100);
  try { localStorage.setItem('ngspecz-smoothing', String(v)); } catch { /* */ }
});

curvatureSlider.addEventListener('input', () => {
  const v = Number(curvatureSlider.value);
  curvatureValue.textContent = String(v);
  if (spectrum) spectrum.display.setCurvature(v / 100 * 0.15);
  try { localStorage.setItem('ngspecz-curvature', String(v)); } catch { /* */ }
});

scanlinesSlider.addEventListener('input', () => {
  const v = Number(scanlinesSlider.value);
  scanlinesValue.textContent = String(v);
  if (spectrum) spectrum.display.setScanlines(v / 100);
  try { localStorage.setItem('ngspecz-scanlines', String(v)); } catch { /* */ }
});

dotmaskSelect.addEventListener('change', () => {
  const v = Number(dotmaskSelect.value);
  if (spectrum) spectrum.display.setDotmask(v as 0 | 1 | 2);
  try { localStorage.setItem('ngspecz-dotmask', String(v)); } catch { /* */ }
});

// ── ROM file input ─────────────────────────────────────────────────────────

async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  romData = data;

  // Detect model from ROM size
  let detectedModel: SpectrumModel;
  if (data.length >= 32768) {
    detectedModel = is128kClass(currentModel) ? currentModel : '128k';
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
  setRomStatus('');

  createMachine();
}

romInput.addEventListener('change', async () => {
  const files = romInput.files;
  if (!files || files.length === 0) return;

  const sorted = Array.from(files).sort((a, b) => a.name.localeCompare(b.name));
  const sizes = sorted.map(f => f.size);

  // Validate ROM file count and sizes
  if (sorted.length === 1 && sizes[0] === 16384) {
    // Single 16KB ROM → 48K
  } else if (sorted.length === 1 && sizes[0] === 32768) {
    // Single 32KB ROM → 128K
  } else if (sorted.length === 2 && sizes[0] === 16384 && sizes[1] === 16384) {
    // Two 16KB ROMs → 128K
  } else {
    const sizeList = sizes.map(s => `${s}b`).join(', ');
    setStatus(`Invalid ROM: expected 1×16KB, 1×32KB, or 2×16KB — got ${sorted.length} file(s) (${sizeList})`);
    romInput.value = '';
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
  romInput.value = '';
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
      if (data.length > 49179 && !is128kClass(currentModel)) {
        const entry128 = await restoreROM('128k');
        const entryPlus2 = entry128 ? null : await restoreROM('+2');
        const entry = entry128 || entryPlus2;
        if (entry) {
          currentModel = entry128 ? '128k' : '+2';
          modelSelect.value = currentModel;
          romData = entry.data;
          setRomStatus('');
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

      if (result.is128K && !is128kClass(currentModel)) {
        const entry128 = await restoreROM('128k');
        const entryPlus2 = entry128 ? null : await restoreROM('+2');
        const entry = entry128 || entryPlus2;
        if (entry) {
          currentModel = entry128 ? '128k' : '+2';
          modelSelect.value = currentModel;
          romData = entry.data;
          setRomStatus('');
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
    } else {
      setStatus(`Unknown format: .${ext}`);
      return false;
    }
  } catch (e) {
    setStatus(`Error: ${(e as Error).message}`);
    return false;
  }
  unpause();
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

  const chosenExt = chosen.name.toLowerCase().split('.').pop();
  if (chosenExt === 'tap' || chosenExt === 'tzx') {
    applyTape(chosen.data, chosen.name);
  } else if (await applySnapshot(chosen.data, chosen.name)) {
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

// ── Tape loading (right sidebar) ────────────────────────────────────────────

function applyTape(data: Uint8Array, filename: string): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }

  const ext = filename.toLowerCase().split('.').pop();
  try {
    if (ext === 'tzx') {
      spectrum.tape.blocks = parseTZX(data);
      spectrum.tape.position = 0;
    } else {
      spectrum.loadTAP(data);
    }
  } catch (e) {
    setStatus(`Error: ${(e as Error).message}`);
    return;
  }

  spectrum.tape.rewind();
  spectrum.tape.paused = false;
  tapePauseBtn.classList.remove('active');
  tapePauseBtn.textContent = '\u23F8';
  tapePauseBtn.title = 'Pause';
  buildTapeBlockList();
  spectrum.stop();
  spectrum.reset();
  spectrum.start();
  spectrum.tape.startPlayback();
  startAutoType(is128kClass(currentModel) ? AUTO_LOAD_128K : AUTO_LOAD_48K);
  unpause();
  setStatus(`Tape loaded — auto-loading ${filename}`);
}

tapeInput.addEventListener('change', async () => {
  const file = tapeInput.files?.[0];
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());

  if (file.name.toLowerCase().endsWith('.zip')) {
    await handleZipFile(data);
  } else {
    applyTape(data, file.name);
  }
  tapeInput.value = '';
});

// ── Reset ──────────────────────────────────────────────────────────────────

resetBtn.addEventListener('click', () => {
  cancelAutoType();
  if (spectrum) {
    spectrum.tape.rewind();
    spectrum.tape.paused = false;
    tapePauseBtn.classList.remove('active');
    tapePauseBtn.textContent = '\u23F8';
    tapePauseBtn.title = 'Pause';
    spectrum.reset();
    if (romData) spectrum.start();
    buildTapeBlockList();
    unpause();
  }
  diagOutput.value = '';
  try {
    localStorage.removeItem('snapshot');
    localStorage.removeItem('snapshot-name');
  } catch { /* */ }
});

// ── Joystick ────────────────────────────────────────────────────────────

const joyP1 = document.getElementById('joy-p1') as HTMLSelectElement;
const joyP2 = document.getElementById('joy-p2') as HTMLSelectElement;
const captureCursor = document.getElementById('capture-cursor') as HTMLInputElement;
const joySelectors = [joyP1, joyP2];

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

function joyPressForType(dir: string, pressed: boolean, mode: string): void {
  if (!spectrum || mode === 'none') return;

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

// Wire each d-pad to its player's joystick type
document.querySelectorAll('.joy-dpad').forEach(dpad => {
  const playerIdx = Number((dpad as HTMLElement).dataset.player) - 1;
  const selector = joySelectors[playerIdx];

  dpad.querySelectorAll('.joy-btn').forEach(el => {
    const dir = (el as HTMLElement).dataset.dir;
    if (!dir) return;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('pressed');
      joyPressForType(dir, true, selector.value);
    });
    el.addEventListener('mouseup', (e) => {
      e.preventDefault();
      el.classList.remove('pressed');
      joyPressForType(dir, false, selector.value);
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('pressed');
      joyPressForType(dir, false, selector.value);
    });
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      el.classList.add('pressed');
      joyPressForType(dir, true, selector.value);
    });
    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      el.classList.remove('pressed');
      joyPressForType(dir, false, selector.value);
    });
    el.addEventListener('touchcancel', () => {
      el.classList.remove('pressed');
      joyPressForType(dir, false, selector.value);
    });
  });
});

captureCursor.addEventListener('change', () => {
  try { localStorage.setItem('ngspecz-capture-cursor', captureCursor.checked ? '1' : '0'); } catch { /* */ }
});

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

const HOST_KEY_TO_JOY: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  AltRight: 'fire',
};

function onKeyDown(e: KeyboardEvent): void {
  if (!spectrum) return;
  cancelAutoType();

  const joyDir = HOST_KEY_TO_JOY[e.code];
  if (joyDir && captureCursor.checked && joyP1.value !== 'none') {
    joyPressForType(joyDir, true, joyP1.value);
    e.preventDefault();
    return;
  }

  if (spectrum.keyboard.handleKeyEvent(e.code, true)) {
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!spectrum) return;

  const joyDir = HOST_KEY_TO_JOY[e.code];
  if (joyDir && captureCursor.checked && joyP1.value !== 'none') {
    joyPressForType(joyDir, false, joyP1.value);
    e.preventDefault();
    return;
  }

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
  // Restore display/sound settings into UI before any machine creation
  const savedScale = getSavedScale();
  scaleSelect.value = String(savedScale);

  const savedVolume = getSaved('volume', '70');
  volumeSlider.value = savedVolume;
  volumeValue.textContent = savedVolume;

  const savedSmoothing = getSaved('smoothing', '0');
  smoothingSlider.value = savedSmoothing;
  smoothingValue.textContent = savedSmoothing;

  const savedCurvature = getSaved('curvature', '0');
  curvatureSlider.value = savedCurvature;
  curvatureValue.textContent = savedCurvature;

  const savedScanlines = getSaved('scanlines', '0');
  scanlinesSlider.value = savedScanlines;
  scanlinesValue.textContent = savedScanlines;

  const savedDotmask = getSaved('dotmask', '0');
  dotmaskSelect.value = savedDotmask;

  const savedCaptureCursor = getSaved('capture-cursor', '1');
  captureCursor.checked = savedCaptureCursor === '1';

  const savedModel = loadSavedModel();
  if (savedModel) {
    currentModel = savedModel;
    modelSelect.value = savedModel;
  }

  const entry = await restoreROM(currentModel);
  if (entry) {
    romData = entry.data;
    setRomStatus('');
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
