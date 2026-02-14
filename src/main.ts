/**
 * ZX84 - ZX Spectrum Emulator
 * Entry point: DOM wiring, file I/O, ROM persistence, machine lifecycle.
 */

import { Spectrum, type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from './spectrum.ts';
import { FloppySound } from './floppy-sound.ts';
import { Z80 } from './cores/z80.ts';
import { loadSNA, saveSNA } from './formats/sna.ts';
import { loadZ80 } from './formats/z80format.ts';
import { diagnoseStuckLoop } from './diagnostics.ts';
import { unzip } from './formats/zip.ts';
import { parseTZX } from './formats/tzx.ts';
import { parseDSK } from './formats/dsk.ts';
import { showFilePicker } from './ui/zip-picker.ts';

// ── IndexedDB ROM persistence ──────────────────────────────────────────────

const DB_NAME = 'zx84';
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

/** +2A and +3 share the same 64KB ROM, so alias them to one key. */
function romKey(model: SpectrumModel): string {
  return model === '+3' ? '+2a' : model;
}

async function persistROM(model: SpectrumModel, data: Uint8Array, label: string): Promise<void> {
  const key = romKey(model);
  romCache[key] = { data, label };
  await dbSave(`rom-${key}`, data);
  try { localStorage.setItem(`zx84-rom-label-${key}`, label); } catch { /* */ }
}

async function restoreROM(model: SpectrumModel): Promise<ROMEntry | null> {
  const key = romKey(model);
  if (romCache[key]) return romCache[key];
  const data = await dbLoad(`rom-${key}`);
  if (!data) return null;
  const label = localStorage.getItem(`zx84-rom-label-${key}`) || 'saved ROM';
  romCache[key] = { data, label };
  return romCache[key];
}

function saveModel(model: SpectrumModel): void {
  try { localStorage.setItem('zx84-model', model); } catch { /* */ }
}

function loadSavedModel(): SpectrumModel | null {
  try {
    const val = localStorage.getItem('zx84-model');
    if (val === '48k' || val === '128k' || val === '+2' || val === '+2a' || val === '+3') return val as SpectrumModel;
  } catch { /* */ }
  return null;
}

// ── Last-file persistence (IndexedDB — handles large DSK/TZX/etc.) ──────────

async function persistLastFile(data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave('last-file', data);
    localStorage.setItem('zx84-last-file', filename);
  } catch { /* quota or write error */ }
}

async function restoreLastFile(): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem('zx84-last-file');
    if (!name) return null;
    const data = await dbLoad('last-file');
    if (!data) return null;
    return { data, name };
  } catch { return null; }
}

function clearLastFile(): void {
  try {
    localStorage.removeItem('zx84-last-file');
  } catch { /* */ }
  // IndexedDB entry left in place — harmless, overwritten on next save
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
const statusEl = document.getElementById('status') as HTMLDivElement;
// Logo is static HTML — no buildTime stamp
const cpuPlayBtn = document.getElementById('cpu-play') as HTMLButtonElement;
const cpuResetBtn = document.getElementById('cpu-reset') as HTMLButtonElement;
const cpuLoopBtn = document.getElementById('cpu-loop') as HTMLButtonElement;
const cpuMhzBtn = document.getElementById('cpu-mhz') as HTMLButtonElement;
const transcribeOverlay = document.getElementById('transcribe-overlay') as HTMLPreElement;

const scaleSelect = document.getElementById('scale') as HTMLSelectElement;
const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
const volumeValue = document.getElementById('volume-value') as HTMLSpanElement;
const brightnessSlider = document.getElementById('brightness-slider') as HTMLInputElement;
const brightnessValue = document.getElementById('brightness-value') as HTMLSpanElement;
const contrastSlider = document.getElementById('contrast-slider') as HTMLInputElement;
const contrastValue = document.getElementById('contrast-value') as HTMLSpanElement;
const smoothingSlider = document.getElementById('smoothing-slider') as HTMLInputElement;
const smoothingValue = document.getElementById('smoothing-value') as HTMLSpanElement;
const curvatureSlider = document.getElementById('curvature-slider') as HTMLInputElement;
const curvatureValue = document.getElementById('curvature-value') as HTMLSpanElement;
const scanlinesSlider = document.getElementById('scanlines-slider') as HTMLInputElement;
const scanlinesValue = document.getElementById('scanlines-value') as HTMLSpanElement;
const dotmaskSelect = document.getElementById('dotmask-select') as HTMLSelectElement;
const borderSizeSelect = document.getElementById('border-size') as HTMLSelectElement;
const fontSelect = document.getElementById('font-select') as HTMLSelectElement;
const fontAddBtn = document.getElementById('font-add-btn') as HTMLButtonElement;
const fontInput = document.getElementById('font-input') as HTMLInputElement;
const fontPreview = document.getElementById('font-preview') as HTMLCanvasElement;
const romFontPreview = document.getElementById('rom-font-preview') as HTMLCanvasElement;

const ledKbd = document.getElementById('led-kbd') as HTMLDivElement;
const ledKemp = document.getElementById('led-kemp') as HTMLDivElement;
const ledTape = document.getElementById('led-tape') as HTMLDivElement;
const ledLoad = document.getElementById('led-load') as HTMLDivElement;
const ledRst16 = document.getElementById('led-rst16') as HTMLDivElement;
const ledBeep = document.getElementById('led-beep') as HTMLDivElement;
const ledAy = document.getElementById('led-ay') as HTMLDivElement;
const ledDsk = document.getElementById('led-dsk') as HTMLDivElement;

const banksPanel = document.getElementById('banks-panel') as HTMLDivElement;
const banksOutput = document.getElementById('banks-output') as HTMLPreElement;
const diskInfoPanel = document.getElementById('disk-info-panel') as HTMLDivElement;
const diskInfoOutput = document.getElementById('disk-info-output') as HTMLPreElement;
const drivePanel = document.getElementById('drive-panel') as HTMLDivElement;
const driveOutput = document.getElementById('drive-output') as HTMLPreElement;
const diskModeSelect = document.getElementById('disk-mode') as HTMLSelectElement;
const trapLog = document.getElementById('trap-log') as HTMLPreElement;

const regsOutput = document.getElementById('regs-output') as HTMLPreElement;

let floppySound: FloppySound | null = null;
let currentDiskInfo: import('./formats/dsk.ts').DskImage | null = null;
let currentDiskName = '';

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

let speedLastTime = 0;
let speedLastTStates = 0;
let speedFrameCount = 0;

function updateClockSpeed(): void {
  if (!spectrum) return;
  speedFrameCount++;
  if (speedFrameCount < 50) return;
  speedFrameCount = 0;
  const now = performance.now();
  const elapsed = (now - speedLastTime) / 1000;
  const tStates = spectrum.cpu.tStates - speedLastTStates;
  speedLastTime = now;
  speedLastTStates = spectrum.cpu.tStates;
  if (elapsed > 0) {
    const mhz = (tStates / elapsed) / 1_000_000;
    cpuMhzBtn.textContent = `${mhz.toFixed(2)} MHz`;
  }
}

function updateActivityLEDs(): void {
  if (!spectrum) return;
  tickAutoType();
  renderFontPreview();
  updateClockSpeed();
  const a = spectrum.activity;
  ledKbd.classList.toggle('on', a.ulaReads > 0);
  ledKemp.classList.toggle('on', a.kempstonReads > 0);
  ledTape.classList.toggle('on', a.ulaReads > 100);
  ledLoad.classList.toggle('on', a.tapeLoads > 0);
  ledRst16.classList.toggle('on', a.rst16Calls > 0);
  ledBeep.classList.toggle('on', a.beeperToggled);
  ledAy.classList.toggle('on', a.ayWrites > 0);
  ledDsk.classList.toggle('on', a.fdcAccesses > 0);
  if (floppySound && isPlus3(currentModel)) {
    // Lazy-attach to AudioContext when it becomes available
    if (!floppySound['ctx'] && spectrum['audio'].ctx) {
      floppySound.attach(spectrum['audio'].ctx);
    }
    floppySound.update(spectrum.fdc.motorOn, spectrum.fdc.currentTrack);
  }
  updateTapeHighlight();
  updateRegsDisplay();
  updateTranscribeOverlay();
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
    const v = localStorage.getItem('zx84-scale');
    if (v === '1' || v === '2' || v === '3' || v === '4') return Number(v);
  } catch { /* */ }
  return 2;
}

function getSaved(key: string, fallback: string): string {
  try { return localStorage.getItem(`zx84-${key}`) ?? fallback; } catch { return fallback; }
}

function applyDisplaySettings(): void {
  if (!spectrum) return;
  spectrum.setBorderSize(Number(borderSizeSelect.value) as 0 | 1 | 2);
  spectrum.display.setScale(Number(scaleSelect.value));
  spectrum.display.setBrightness(Number(brightnessSlider.value) / 50);
  spectrum.display.setContrast(Number(contrastSlider.value) / 50);
  spectrum.display.setSmoothing(Number(smoothingSlider.value) / 100);
  spectrum.display.setCurvature(Number(curvatureSlider.value) / 100 * 0.15);
  spectrum.display.setScanlines(Number(scanlinesSlider.value) / 100);
  spectrum.display.setDotmask(Number(dotmaskSelect.value) as number);
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
  speedLastTime = performance.now();
  speedLastTStates = 0;
  speedFrameCount = 0;
  cpuMhzBtn.textContent = 'MHz';

  if (romData) {
    spectrum.loadROM(romData);
    spectrum.reset();
    spectrum.start();
  }

  // Apply saved disk mode for +3
  if (isPlus3(currentModel)) {
    const savedDiskMode = getSaved('disk-mode', 'fdc');
    if (savedDiskMode === 'bios' || savedDiskMode === 'fdc') {
      spectrum.diskMode = savedDiskMode as 'fdc' | 'bios';
      diskModeSelect.value = savedDiskMode;
    }
  }

  // Floppy sound — create for +3, destroy otherwise
  currentDiskInfo = null;
  currentDiskName = '';
  if (isPlus3(currentModel)) {
    if (!floppySound) floppySound = new FloppySound();
    floppySound.reset();
  } else {
    floppySound?.destroy();
    floppySound = null;
  }

  buildTapeBlockList(); // hides panel — new machine has no tape
  renderFontPreview();
  unpause();
}

// ── Wire file-pick buttons to hidden inputs ────────────────────────────────

romBtn.addEventListener('click', () => romInput.click());
snapLoadBtn.addEventListener('click', () => snapInput.click());

// ── Save snapshot ───────────────────────────────────────────────────────────

snapSaveBtn.addEventListener('click', () => {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused;
  if (!wasPaused) spectrum.stop();

  const data = saveSNA(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor);
  const model = is128kClass(currentModel) ? '128k' : '48k';
  const filename = `zx84-${model}.sna`;

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
  cpuPlayBtn.textContent = emulationPaused ? '\u25B6' : '\u23F8';
  cpuPlayBtn.title = emulationPaused ? 'Resume emulation' : 'Pause emulation';
  cpuPlayBtn.classList.toggle('active', emulationPaused);
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
    ? `<span class="flag-on">☑ ${label}</span>`
    : `<span class="flag-off">☐ ${label}</span>`;
}

function renderRegs(cpu: Z80): string {
  const f = cpu.f;
  const flags1 = [
    flagHtml('Sign', (f & Z80.FLAG_S) !== 0),
    flagHtml('Zero', (f & Z80.FLAG_Z) !== 0),
  ].join(' ');

  const flags2 = [
    flagHtml('Half', (f & Z80.FLAG_H) !== 0),
    flagHtml('Prty', (f & Z80.FLAG_PV) !== 0),
  ].join(' ');

  const flags3 = [
    flagHtml('Subt', (f & Z80.FLAG_N) !== 0),
    flagHtml('Crry', (f & Z80.FLAG_C) !== 0),
  ].join(' ');

  const iff = cpu.iff1 ? 'EI' : 'DI';
  const halt = cpu.halted ? ' HALT' : '';

  const n = '<span class="reg-name">';
  const e = '</span>';
  return [
    `${n}AF${e}  ${hex16(cpu.af)}  ${n}AF'${e} ${hex16((cpu.a_ << 8) | cpu.f_)}   ${flags1}`,
    `${n}BC${e}  ${hex16(cpu.bc)}  ${n}BC'${e} ${hex16((cpu.b_ << 8) | cpu.c_)}   ${flags2}`,
    `${n}DE${e}  ${hex16(cpu.de)}  ${n}DE'${e} ${hex16((cpu.d_ << 8) | cpu.e_)}   ${flags3}`,
    `${n}HL${e}  ${hex16(cpu.hl)}  ${n}HL'${e} ${hex16((cpu.h_ << 8) | cpu.l_)}`,
    `${n}IX${e}  ${hex16(cpu.ix)}  ${n}IY${e}  ${hex16(cpu.iy)}   ${iff}  ${n}IM${e}${cpu.im}${halt}`,
    `${n}SP${e}  ${hex16(cpu.sp)}  ${n}PC${e}  ${hex16(cpu.pc)}   ${n}IR${e}  ${hex8(cpu.i)}${hex8(cpu.r)}`,
  ].join('\n');
}

function renderBanks(mem: import('./memory.ts').SpectrumMemory): string {
  const n = '<span class="reg-name">';
  const e = '</span>';
  const scr = (mem.port7FFD & 0x08) ? 7 : 5;
  const plus2a = isPlus2AClass(currentModel);

  let portLine = `${n}7FFD${e} ${hex8(mem.port7FFD)}`;
  if (plus2a) portLine += `  ${n}1FFD${e} ${hex8(mem.port1FFD)}`;
  const lines = [portLine];

  let romLabel: string;
  if (plus2a) {
    romLabel = `(page ${mem.currentROM})`;
  } else {
    romLabel = mem.currentROM === 0 ? '(128K editor)' : '(48K BASIC)';
  }

  lines.push(
    `${n}ROM${e}   ${mem.currentROM}  ${romLabel}`,
    `${n}Bank${e}  ${mem.currentBank}  ${n}at${e} C000-FFFF`,
    `${n}Screen${e} ${scr}  ${n}Lock${e} ${mem.pagingLocked ? 'Yes' : 'No'}`,
  );

  if (plus2a && mem.specialPaging) {
    const mode = (mem.port1FFD >> 1) & 3;
    lines.push(`${n}Special${e} mode ${mode}`);
  }

  return lines.join('\n');
}

function renderDiskInfo(): string {
  if (!currentDiskInfo) return '';
  const n = '<span class="reg-name">';
  const e = '</span>';
  const img = currentDiskInfo;
  const t0 = img.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 0;
  return [
    currentDiskName,
    `${n}Sides${e} ${img.numSides}  ${n}Tracks${e} ${img.numTracks}  ${n}Sectors${e} ${spt}`,
    `${n}Format${e} ${img.diskFormat}`,
    `${n}Prot.${e}  ${img.protection || 'None'}`,
  ].join('\n');
}

function renderDrive(): string {
  if (!spectrum) return '';
  const fdc = spectrum.fdc;
  fdc.tickFrame();
  const n = '<span class="reg-name">';
  const e = '</span>';
  const motor = fdc.motorOn ? 'On' : 'Off';
  const track = fdc.currentTrack.toString().padStart(2, '0');
  const head = fdc.currentHead;
  const sector = fdc.isExecuting ? fdc.currentSector.toString().padStart(2, '0') : '--';
  const ioMode = fdc.isExecuting ? (fdc.isWriting ? 'WRITE' : 'READ') : '(idle)';
  return [
    `${n}Motor${e}  ${motor}  ${n}Head${e} ${head}`,
    `${n}Track${e}  ${track}  ${n}Sector${e} ${sector}  ${ioMode}`,
  ].join('\n');
}

function updateRegsDisplay(): void {
  if (!spectrum) return;
  regsOutput.innerHTML = renderRegs(spectrum.cpu);
  if (is128kClass(currentModel)) {
    banksOutput.innerHTML = renderBanks(spectrum.memory);
    banksPanel.style.display = '';
  } else {
    banksPanel.style.display = 'none';
  }
  if (isPlus3(currentModel)) {
    if (currentDiskInfo) {
      diskInfoOutput.innerHTML = renderDiskInfo();
      diskInfoPanel.style.display = '';
    } else {
      diskInfoPanel.style.display = 'none';
    }
    driveOutput.innerHTML = renderDrive();
    drivePanel.style.display = '';
    // Trap log — always show when in BIOS mode
    if (spectrum.diskMode === 'bios' && spectrum.biosTrap) {
      const entries = spectrum.biosTrap.trapLog;
      trapLog.innerHTML = entries.length > 0
        ? entries.map(e =>
            e.startsWith('UNTRAPPED')
              ? `<span class="trap-warn">${e}</span>`
              : e
          ).join('\n')
        : '<span style="color:#666">(no traps fired)</span>';
      trapLog.style.display = '';
      if (entries.length > 0) trapLog.scrollTop = trapLog.scrollHeight;
    } else {
      trapLog.style.display = 'none';
    }
  } else {
    diskInfoPanel.style.display = 'none';
    drivePanel.style.display = 'none';
  }
}

cpuPlayBtn.addEventListener('click', () => {
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

// ── Disk mode selector ──────────────────────────────────────────────────────

diskModeSelect.addEventListener('change', () => {
  const mode = diskModeSelect.value as 'fdc' | 'bios';
  if (spectrum) spectrum.diskMode = mode;
  try { localStorage.setItem('zx84-disk-mode', mode); } catch { /* */ }
  diskModeSelect.blur();
});

// ── Display / Sound controls ─────────────────────────────────────────────────

scaleSelect.addEventListener('change', () => {
  const scale = Number(scaleSelect.value);
  if (spectrum) spectrum.display.setScale(scale);
  try { localStorage.setItem('zx84-scale', String(scale)); } catch { /* */ }
  if (transcribeActive) positionTranscribeOverlay();
});

volumeSlider.addEventListener('input', () => {
  const v = Number(volumeSlider.value);
  volumeValue.textContent = String(v);
  if (spectrum) spectrum['audio'].setVolume(v / 100);
  try { localStorage.setItem('zx84-volume', String(v)); } catch { /* */ }
});

smoothingSlider.addEventListener('input', () => {
  const v = Number(smoothingSlider.value);
  smoothingValue.textContent = String(v);
  if (spectrum) spectrum.display.setSmoothing(v / 100);
  try { localStorage.setItem('zx84-smoothing', String(v)); } catch { /* */ }
});

curvatureSlider.addEventListener('input', () => {
  const v = Number(curvatureSlider.value);
  curvatureValue.textContent = String(v);
  if (spectrum) spectrum.display.setCurvature(v / 100 * 0.15);
  try { localStorage.setItem('zx84-curvature', String(v)); } catch { /* */ }
});

scanlinesSlider.addEventListener('input', () => {
  const v = Number(scanlinesSlider.value);
  scanlinesValue.textContent = String(v);
  if (spectrum) spectrum.display.setScanlines(v / 100);
  try { localStorage.setItem('zx84-scanlines', String(v)); } catch { /* */ }
});

dotmaskSelect.addEventListener('change', () => {
  const v = Number(dotmaskSelect.value);
  if (spectrum) spectrum.display.setDotmask(v as number);
  try { localStorage.setItem('zx84-dotmask', String(v)); } catch { /* */ }
});

brightnessSlider.addEventListener('input', () => {
  const v = Number(brightnessSlider.value);
  brightnessValue.textContent = String(v);
  if (spectrum) spectrum.display.setBrightness(v / 50);
  try { localStorage.setItem('zx84-brightness', String(v)); } catch { /* */ }
});

contrastSlider.addEventListener('input', () => {
  const v = Number(contrastSlider.value);
  contrastValue.textContent = String(v);
  if (spectrum) spectrum.display.setContrast(v / 50);
  try { localStorage.setItem('zx84-contrast', String(v)); } catch { /* */ }
});

borderSizeSelect.addEventListener('change', () => {
  const v = Number(borderSizeSelect.value) as 0 | 1 | 2;
  if (spectrum) spectrum.setBorderSize(v);
  try { localStorage.setItem('zx84-border-size', String(v)); } catch { /* */ }
  if (transcribeActive) positionTranscribeOverlay();
  borderSizeSelect.blur();
});

// ── Font management ──────────────────────────────────────────────────────────

function loadFontStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem('zx84-fonts');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveFontStore(store: Record<string, string>): void {
  try { localStorage.setItem('zx84-fonts', JSON.stringify(store)); } catch { /* */ }
}

function populateFontSelect(): void {
  const store = loadFontStore();
  const saved = getSaved('font', '');
  while (fontSelect.options.length > 1) fontSelect.remove(1);
  for (const name of Object.keys(store).sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    fontSelect.appendChild(opt);
  }
  fontSelect.value = saved;
}

function renderTextToCanvas(cvs: HTMLCanvasElement, fontData: Uint8Array, text: string): void {
  const scale = 2;
  const w = text.length * 8 * scale;
  const h = 8 * scale;
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const stride = w * 4;

  for (let ci = 0; ci < text.length; ci++) {
    const ch = text.charCodeAt(ci) - 32;
    if (ch < 0 || ch >= 96) continue;
    const off = ch * 8;
    for (let row = 0; row < 8; row++) {
      const byte = fontData[off + row];
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) {
          const x = (ci * 8 + bit) * scale;
          const y = row * scale;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = (y + sy) * stride + (x + sx) * 4;
              d[px] = 0xCD; d[px + 1] = 0xCD; d[px + 2] = 0xCD; d[px + 3] = 0xFF;
            }
          }
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}

let romFontCacheAddr = -1;
let romFontCacheHash = -1;

function fontDataHash(data: Uint8Array, offset: number, len: number): number {
  let h = 0;
  for (let i = 0; i < len; i++) h = (h * 31 + data[offset + i]) | 0;
  return h;
}

function renderFontPreview(): void {
  return; // font UI hidden
  const name = fontSelect.value;

  if (name) {
    // Show replacement font preview
    const store = loadFontStore();
    const b64 = store[name];
    if (!b64) { fontPreview.style.display = 'none'; romFontPreview.style.display = 'none'; return; }
    const binary = atob(b64);
    const font = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) font[i] = binary.charCodeAt(i);
    renderTextToCanvas(fontPreview, font, 'Flexible');
    fontPreview.style.display = 'block';
    romFontPreview.style.display = 'none';
    romFontCacheAddr = -1;
    romFontCacheHash = -1;
  } else {
    // Show ROM font from CHARS sysvar (23606/0x5C36)
    fontPreview.style.display = 'none';
    if (!spectrum) { romFontPreview.style.display = 'none'; return; }
    const mem = spectrum.memory.flat;
    let charsAddr = mem[0x5C36] | (mem[0x5C37] << 8);
    if (charsAddr === 0) charsAddr = 0x3C00; // ROM hasn't initialised CHARS yet
    const fontStart = charsAddr + 256;
    if (fontStart + 768 > 65536) { romFontPreview.style.display = 'none'; return; }

    const hash = fontDataHash(mem, fontStart, 768);
    if (fontStart === romFontCacheAddr && hash === romFontCacheHash) return;
    romFontCacheAddr = fontStart;
    romFontCacheHash = hash;

    renderTextToCanvas(romFontPreview, mem.subarray(fontStart, fontStart + 768), 'Flexible');
    romFontPreview.style.display = 'block';
  }
}

fontAddBtn.addEventListener('click', () => fontInput.click());

fontInput.addEventListener('change', () => {
  const file = fontInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const data = new Uint8Array(reader.result as ArrayBuffer);
    if (data.length !== 768) {
      setStatus(`Font must be 768 bytes (got ${data.length})`);
      fontInput.value = '';
      return;
    }
    const name = file.name.replace(/\.[^.]+$/, '');
    let binary = '';
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    const store = loadFontStore();
    store[name] = btoa(binary);
    saveFontStore(store);
    populateFontSelect();
    fontSelect.value = name;
    try { localStorage.setItem('zx84-font', name); } catch { /* */ }
    renderFontPreview();
    setStatus(`Font "${name}" added`);
    fontInput.value = '';
  };
  reader.readAsArrayBuffer(file);
});

fontSelect.addEventListener('change', () => {
  try { localStorage.setItem('zx84-font', fontSelect.value); } catch { /* */ }
  renderFontPreview();
  fontSelect.blur();
});

// ── ROM file input ─────────────────────────────────────────────────────────

async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  romData = data;

  // Detect model from ROM size
  let detectedModel: SpectrumModel;
  if (data.length >= 65536) {
    detectedModel = isPlus2AClass(currentModel) ? currentModel : '+2a';
  } else if (data.length >= 32768) {
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
  } else if (sorted.length === 1 && sizes[0] === 65536) {
    // Single 64KB ROM → +2A
  } else if (sorted.length === 2 && sizes[0] === 16384 && sizes[1] === 16384) {
    // Two 16KB ROMs → 128K
  } else if (sorted.length === 4 && sizes.every(s => s === 16384)) {
    // Four 16KB ROMs → +2A
  } else {
    const sizeList = sizes.map(s => `${s}b`).join(', ');
    setStatus(`Invalid ROM: expected 1×16KB, 1×32KB, 1×64KB, 2×16KB, or 4×16KB — got ${sorted.length} file(s) (${sizeList})`);
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
        const entryPlus2a = (entry128 || entryPlus2) ? null : await restoreROM('+2a');
        const entryPlus3 = (entry128 || entryPlus2 || entryPlus2a) ? null : await restoreROM('+3');
        const entry = entry128 || entryPlus2 || entryPlus2a || entryPlus3;
        if (entry) {
          currentModel = entry128 ? '128k' : entryPlus2 ? '+2' : entryPlus2a ? '+2a' : '+3';
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
        const entryPlus2a = (entry128 || entryPlus2) ? null : await restoreROM('+2a');
        const entryPlus3 = (entry128 || entryPlus2 || entryPlus2a) ? null : await restoreROM('+3');
        const entry = entry128 || entryPlus2 || entryPlus2a || entryPlus3;
        if (entry) {
          currentModel = entry128 ? '128k' : entryPlus2 ? '+2' : entryPlus2a ? '+2a' : '+3';
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

  // Use internal filename, not the zip name
  await loadFile(chosen.data, chosen.name);
}

/** Route a loaded file to the correct handler based on extension. */
async function loadFile(data: Uint8Array, filename: string): Promise<void> {
  const ext = filename.toLowerCase().split('.').pop();

  if (ext === 'zip') {
    await handleZipFile(data);
    return;
  }

  if (ext === 'tap' || ext === 'tzx') {
    applyTape(data, filename);

    persistLastFile(data, filename);
    return;
  }

  if (ext === 'dsk') {
    if (!spectrum) { setStatus('Load a ROM first'); return; }
    try {
      const image = parseDSK(data);
      currentDiskInfo = image;
      currentDiskName = filename;
      spectrum.loadDisk(image);
      setStatus(`Disk loaded: ${filename}`);
  
      persistLastFile(data, filename);
    } catch (e) {
      setStatus(`DSK error: ${(e as Error).message}`);
    }
    return;
  }

  if (ext === 'sna' || ext === 'z80') {
    if (await applySnapshot(data, filename)) {
  
      persistLastFile(data, filename);
    }
    return;
  }

  setStatus(`Unknown file type: .${ext}`);
}

snapInput.addEventListener('change', async () => {
  const file = snapInput.files?.[0];
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  await loadFile(data, file.name);
  snapInput.value = '';
});

// ── Tape loading ────────────────────────────────────────────────────────────

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

// ── Reset ──────────────────────────────────────────────────────────────────

cpuResetBtn.addEventListener('click', () => {
  cancelAutoType();
  floppySound?.reset();
  if (spectrum) {
    spectrum.turbo = false;
    cpuMhzBtn.classList.remove('active');
    cpuMhzBtn.title = 'Toggle turbo speed';
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
  if (transcribeActive) {
    transcribeActive = false;
    canvas.classList.remove('dimmed');
    transcribeOverlay.classList.remove('active');
  }
  clearLastFile();
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
  try { localStorage.setItem('zx84-capture-cursor', captureCursor.checked ? '1' : '0'); } catch { /* */ }
});

// ── Diagnostics ─────────────────────────────────────────────────────────────

// ── CPU control bar ─────────────────────────────────────────────────────────

cpuLoopBtn.addEventListener('click', () => {
  if (!spectrum) return;
  spectrum.stop();
  const result = diagnoseStuckLoop(spectrum.cpu, spectrum.memory);
  spectrum.start();
  navigator.clipboard.writeText(result);
  setStatus('Loop capture copied to clipboard');
});

cpuMhzBtn.addEventListener('click', () => {
  if (!spectrum) return;
  spectrum.turbo = !spectrum.turbo;
  cpuMhzBtn.classList.toggle('active', spectrum.turbo);
  cpuMhzBtn.title = spectrum.turbo ? 'Switch to normal speed' : 'Toggle turbo speed';
  speedFrameCount = 49; // force immediate MHz update
});

let transcribeActive = false;

/** Natural (unscaled) pixel size of the 32x24 monospace block. Measured once. */
let transcribeNatW = 0;
let transcribeNatH = 0;

function positionTranscribeOverlay(): void {
  if (!spectrum) return;
  const scale = spectrum.display.scale;
  const borderPx = (spectrum.ula.screenWidth - 256) / 2;
  const offsetLeft = borderPx * scale + 2; // +2 for CSS border
  const offsetTop = borderPx * scale + 2;
  const targetW = 256 * scale;
  const targetH = 192 * scale;

  const ov = transcribeOverlay;
  ov.style.left = offsetLeft + 'px';
  ov.style.top = offsetTop + 'px';

  // Measure natural size once (32 chars x 24 lines at the CSS font-size)
  if (!transcribeNatW) {
    ov.style.transform = 'none';
    transcribeNatW = ov.scrollWidth || 1;
    transcribeNatH = ov.scrollHeight || 1;
  }
  ov.style.transform = `scale(${targetW / transcribeNatW},${targetH / transcribeNatH})`;
}

function updateTranscribeOverlay(): void {
  if (!transcribeActive || !spectrum) return;
  // Don't clobber the DOM while the user is selecting text
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed &&
      transcribeOverlay.contains(sel.anchorNode)) return;
  const grid = spectrum.screenGrid;
  let text = '';
  for (let row = 0; row < 24; row++) {
    const offset = row * 32;
    for (let col = 0; col < 32; col++) {
      text += grid[offset + col];
    }
    if (row < 23) text += '\n';
  }
  transcribeOverlay.textContent = text;
}

ledRst16.addEventListener('click', () => {
  if (!spectrum) return;
  transcribeActive = !transcribeActive;
  canvas.classList.toggle('dimmed', transcribeActive);
  transcribeOverlay.classList.toggle('active', transcribeActive);
  if (transcribeActive) {
    updateTranscribeOverlay();
    positionTranscribeOverlay();
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

  const savedBrightness = getSaved('brightness', '0');
  brightnessSlider.value = savedBrightness;
  brightnessValue.textContent = savedBrightness;

  const savedContrast = getSaved('contrast', '50');
  contrastSlider.value = savedContrast;
  contrastValue.textContent = savedContrast;

  const savedDotmask = getSaved('dotmask', '0');
  dotmaskSelect.value = savedDotmask;

  const savedBorderSize = getSaved('border-size', '2');
  borderSizeSelect.value = savedBorderSize;

  populateFontSelect();
  renderFontPreview();

  const savedCaptureCursor = getSaved('capture-cursor', '0');
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

    // Restore last loaded file (SNA/TAP/TZX/DSK/etc.)
    const last = await restoreLastFile();
    if (last) {
      await loadFile(last.data, last.name);
    }
  } else {
    setStatus('Load a ROM to start');
  }
}

init();

// ── Vite HMR cleanup ─────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.on('hmr-freeze', () => {
    const btns = document.getElementById('toolbar-btns');
    if (btns && !btns.querySelector('.hmr-spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'hmr-spinner';
      btns.insertBefore(spinner, btns.firstChild);
    }
  });

  import.meta.hot.on('hmr-thaw', () => {
    document.querySelector('.hmr-spinner')?.remove();
  });

  import.meta.hot.dispose(() => {
    floppySound?.destroy();
    floppySound = null;
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
