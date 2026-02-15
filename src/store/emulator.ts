/**
 * Machine lifecycle: spectrum instance, ROM management, model switching.
 */

import { signal, batch } from '@preact/signals';
import { Spectrum, type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from '../spectrum.ts';
import { FloppySound } from '../plus3/floppy-sound.ts';
import { Z80 } from '../cores/z80.ts';
import { loadSNA, saveSNA } from '../formats/sna.ts';
import { loadZ80 } from '../formats/z80format.ts';
import { loadSZX } from '../formats/szx.ts';
import { loadSP } from '../formats/sp.ts';
import { unzip } from '../formats/zip.ts';
import { parseTZX } from '../formats/tzx.ts';
import { parseDSK } from '../formats/dsk.ts';
import { showFilePicker } from '../ui/zip-picker.ts';
import { disassemble, disassembleAroundPC, formatDisasmHtml, stripMarkers } from '../z80-disasm.ts';
import { dbSave, dbLoad, persistLastFile, restoreLastFile, clearLastFile } from './persistence.ts';
import * as settings from './settings.ts';
import type { DskImage } from '../formats/dsk.ts';
import type { TapeBlock } from '../formats/tap.ts';

// ── State ───────────────────────────────────────────────────────────────

export const statusText = signal('Load a ROM to start');
export const romStatusText = signal('');
export const currentModel = signal<SpectrumModel>(loadSavedModel() ?? '128k');
export const emulationPaused = signal(false);
export const turboMode = signal(false);
export const tracing = signal(false);

// Per-frame updated signals (written by bridge)
export const regsHtml = signal('');
export const sysvarHtml = signal('');
export const banksHtml = signal('');
export const diskInfoHtml = signal('');
export const driveHtml = signal('');
export const trapLogHtml = signal('');
export const showTrapLog = signal(false);
export const disasmText = signal('');

// LED states
export const ledKbd = signal(false);
export const ledKemp = signal(false);
export const ledEar = signal(false);
export const ledLoad = signal(false);
export const ledRst16 = signal(false);
export const ledText = signal(false);
export const ledBeep = signal(false);
export const ledAy = signal(false);
export const ledDsk = signal(false);

// Clock speed display
export const clockSpeedText = signal('MHz');

// Tape signals
export const tapeLoaded = signal(false);
export const tapeBlocks = signal<TapeBlock[]>([]);
export const tapePosition = signal(0);
export const tapePaused = signal(true);
export const tapePlaying = signal(false);

// Transcribe mode
export const transcribeMode = signal<'off' | 'rst16' | 'text'>('off');
export const transcribeText = signal('');

// ── Non-signal state (plain variables) ──────────────────────────────────

export let spectrum: Spectrum | null = null;
export let romData: Uint8Array | null = null;
export let floppySound: FloppySound | null = null;
export let currentDiskInfo: DskImage | null = null;
export let currentDiskName = '';
export let canvasEl: HTMLCanvasElement | null = null;


// Clock speed tracking (1-second average)
let speedLastTime = 0;
let speedLastTStates = 0;
let speedFrameCount = 0;

// Font preview cache
let romFontCacheAddr = -1;
let romFontCacheHash = -1;
export let capturedFontData: Uint8Array | null = null;

// ── ROM cache ───────────────────────────────────────────────────────────

interface ROMEntry {
  data: Uint8Array;
  label: string;
}

const romCache: Record<string, ROMEntry> = {};

export async function persistROM(model: SpectrumModel, data: Uint8Array, label: string): Promise<void> {
  romCache[model] = { data, label };
  await dbSave(`rom-${model}`, data);
  try { localStorage.setItem(`zx84-rom-label-${model}`, label); } catch { /* */ }
}

export async function restoreROM(model: SpectrumModel): Promise<ROMEntry | null> {
  if (romCache[model]) return romCache[model];
  const data = await dbLoad(`rom-${model}`);
  if (!data) return null;
  const label = localStorage.getItem(`zx84-rom-label-${model}`) || 'saved ROM';
  romCache[model] = { data, label };
  return romCache[model];
}

const DEFAULT_ROM_URLS: Record<SpectrumModel, string> = {
  '48k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '128k': 'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/128/spec128uk.rom',
  '+2':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/plus2/plus2uk.rom',
  '+2a':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus2a/plus2a.rom',
  '+3':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus3/plus3.rom',
};

export async function fetchDefaultROM(model: SpectrumModel): Promise<ROMEntry | null> {
  const url = DEFAULT_ROM_URLS[model];
  if (!url) return null;
  setStatus(`Downloading ${model.toUpperCase()} ROM…`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    const name = url.split('/').pop()!;
    await persistROM(model, data, name);
    setStatus(`${model.toUpperCase()} ROM loaded`);
    return { data, label: name };
  } catch (err) {
    setStatus(`Failed to download ROM: ${(err as Error).message}`);
    return null;
  }
}

function loadSavedModel(): SpectrumModel | null {
  try {
    const val = localStorage.getItem('zx84-model');
    if (val === '48k' || val === '128k' || val === '+2' || val === '+2a' || val === '+3') return val as SpectrumModel;
  } catch { /* */ }
  return null;
}

function saveModel(model: SpectrumModel): void {
  try { localStorage.setItem('zx84-model', model); } catch { /* */ }
}

// ── Actions ─────────────────────────────────────────────────────────────

export function setStatus(msg: string): void {
  statusText.value = msg;
}

export function setRomStatus(msg: string): void {
  romStatusText.value = msg;
}

export function setCanvas(el: HTMLCanvasElement): void {
  canvasEl = el;
  if (spectrum) createMachine();
}

export function applyDisplaySettings(): void {
  if (!spectrum) return;
  spectrum.setBorderSize(settings.borderSize.value as 0 | 1 | 2);
  if (spectrum.display) {
    spectrum.display.setScale(settings.scale.value);
    spectrum.display.setBrightness(settings.brightness.value / 50);
    spectrum.display.setContrast(settings.contrast.value / 50);
    spectrum.display.setSmoothing(settings.smoothing.value / 100);
    spectrum.display.setCurvature(settings.curvature.value / 100 * 0.15);
    spectrum.display.setScanlines(settings.scanlines.value / 100);
    spectrum.display.setMaskType(settings.maskType.value);
    spectrum.display.setDotPitch(settings.dotPitch.value / 10);
    spectrum.display.setCurvatureMode(settings.curvatureMode.value);
  }
  spectrum['audio'].setVolume(settings.volume.value / 100);
  const mix = settings.ayMix.value / 100;
  spectrum.beeperGain = Math.min(1, 2 * (1 - mix));
  spectrum.ayGain = Math.min(1, 2 * mix);
  spectrum.subFrameRendering = settings.subFrameRendering.value;
}

export function createMachine(): void {
  if (!canvasEl) return;
  if (spectrum) {
    spectrum.destroy();
  }

  const model = currentModel.value;
  spectrum = new Spectrum(model, canvasEl, settings.renderer.value);
  spectrum.onStatus = (msg: string) => setStatus(msg);
  spectrum.onFrame = onFrame;
  applyDisplaySettings();
  speedLastTime = performance.now();
  speedLastTStates = 0;
  speedFrameCount = 0;
  clockSpeedText.value = 'MHz';

  if (romData) {
    spectrum.loadROM(romData);
    spectrum.reset();
    spectrum.start();
  }

  // Apply saved AY stereo mode
  const savedAyStereo = settings.ayStereo.value as 'MONO' | 'ABC' | 'BCA' | 'CBA';
  spectrum.ay.setStereoMode(savedAyStereo);

  // Apply saved disk mode for +3
  if (isPlus3(model)) {
    spectrum.diskMode = settings.diskMode.value;
  }

  // Floppy sound
  currentDiskInfo = null;
  currentDiskName = '';
  if (isPlus3(model)) {
    if (!floppySound) floppySound = new FloppySound();
    floppySound.reset();
  } else {
    floppySound?.destroy();
    floppySound = null;
  }

  batch(() => {
    tapeLoaded.value = false;
    tapeBlocks.value = [];
    tapePosition.value = 0;
    tapePaused.value = true;
    tapePlaying.value = false;
    turboMode.value = false;
  });

  unpause();
}

export function unpause(): void {
  emulationPaused.value = false;
}

function clearDebugPanels(): void {
  disasmText.value = '';
  sysvarHtml.value = '';
}

export function togglePause(): void {
  if (!spectrum) return;
  if (emulationPaused.value) {
    clearDebugPanels();
    spectrum.start();
  } else {
    spectrum.stop();
    updateRegsOnce();
  }
  emulationPaused.value = !emulationPaused.value;
}

export function stepInto(): void {
  if (!spectrum) return;
  if (!emulationPaused.value) {
    spectrum.stop();
    emulationPaused.value = true;
  }
  spectrum.cpu.step();
  updateRegsOnce();
}

export function stepOver(): void {
  if (!spectrum) return;
  if (!emulationPaused.value) {
    spectrum.stop();
    emulationPaused.value = true;
  }
  const cpu = spectrum.cpu;
  const op = cpu.memory[cpu.pc];
  // CALL nn / CALL cc,nn / RST: step until SP returns to current level
  const isCall = op === 0xCD ||                                           // CALL nn
    (op & 0xC7) === 0xC4 ||                                              // CALL cc,nn
    (op & 0xC7) === 0xC7 ||                                              // RST
    (op === 0xED && ((cpu.memory[(cpu.pc + 1) & 0xFFFF] & 0xC7) === 0xB0)); // block repeat (LDIR etc)
  // Conditional jumps: run to the next instruction (skip if taken)
  const isCondJump =
    op === 0x10 ||                  // DJNZ e        (2 bytes)
    (op & 0xE7) === 0x20 ||        // JR cc,e        (2 bytes: 20/28/30/38)
    (op & 0xC7) === 0xC2;          // JP cc,nn       (3 bytes: C2/CA/D2/DA/E2/EA/F2/FA)
  if (isCondJump) {
    const instrLen = (op & 0xC7) === 0xC2 ? 3 : 2;
    const nextPC = (cpu.pc + instrLen) & 0xFFFF;
    const limit = cpu.tStates + 5_000_000;
    cpu.step();
    while (cpu.pc !== nextPC && cpu.tStates < limit) {
      cpu.step();
    }
  } else if (!isCall) {
    cpu.step();
  } else {
    const targetSP = cpu.sp;
    const limit = cpu.tStates + 5_000_000; // safety: max ~1.4 seconds
    cpu.step(); // execute the CALL/RST
    while (cpu.sp < targetSP && cpu.tStates < limit) {
      cpu.step();
    }
  }
  updateRegsOnce();
}

export function stepOut(): void {
  if (!spectrum) return;
  if (!emulationPaused.value) {
    spectrum.stop();
    emulationPaused.value = true;
  }
  const cpu = spectrum.cpu;
  const targetSP = cpu.sp + 2; // SP after RET pops return address
  const limit = cpu.tStates + 10_000_000; // safety: max ~2.8 seconds
  // Run until we execute a RET that brings SP back to or above target
  while (cpu.sp < targetSP && cpu.tStates < limit) {
    cpu.step();
  }
  updateRegsOnce();
}

export function resetMachine(): void {
  floppySound?.reset();
  if (spectrum) {
    spectrum.turbo = false;
    turboMode.value = false;
    spectrum.tape.rewind();
    spectrum.tape.paused = true;
    tapePaused.value = true;
    spectrum.reset();
    if (romData) spectrum.start();
    batch(() => {
      tapeLoaded.value = spectrum!.tape.loaded;
      tapeBlocks.value = [...spectrum!.tape.blocks];
      tapePosition.value = 0;
    });
    unpause();
  }
  if (transcribeMode.value !== 'off') {
    transcribeMode.value = 'off';
  }
  clearLastFile();
}

export function toggleTurbo(): void {
  if (!spectrum) return;
  spectrum.turbo = !spectrum.turbo;
  turboMode.value = spectrum.turbo;
  speedFrameCount = 49; // force immediate MHz update
}

export function toggleBreakpoint(addr: number): void {
  if (!spectrum) return;
  if (spectrum.breakpoints.has(addr)) {
    spectrum.breakpoints.delete(addr);
    setStatus(`Breakpoint removed at ${hex16(addr)}`);
  } else {
    spectrum.breakpoints.add(addr);
    setStatus(`Breakpoint set at ${hex16(addr)}`);
  }
  updateRegsOnce();
}

export function runTo(addr: number): void {
  if (!spectrum) return;
  // Add a temporary breakpoint, resume, and clean up when it hits
  const wasSet = spectrum.breakpoints.has(addr);
  spectrum.breakpoints.add(addr);
  if (!wasSet) {
    pendingRunTo = addr;
  }
  if (emulationPaused.value) {
    clearDebugPanels();
    spectrum.start();
    emulationPaused.value = false;
  }
}

/** Address of a temporary "run to" breakpoint to clean up on hit */
let pendingRunTo = -1;

export function copyCpuState(): void {
  if (!spectrum) return;
  const cpu = spectrum.cpu;
  const f = cpu.f;
  const flags = [
    `Sign=${(f & Z80.FLAG_S) ? 1 : 0}`,
    `Zero=${(f & Z80.FLAG_Z) ? 1 : 0}`,
    `Half=${(f & Z80.FLAG_H) ? 1 : 0}`,
    `P/V=${(f & Z80.FLAG_PV) ? 1 : 0}`,
    `Sub=${(f & Z80.FLAG_N) ? 1 : 0}`,
    `Carry=${(f & Z80.FLAG_C) ? 1 : 0}`,
  ].join('  ');
  const iff = cpu.iff1 ? 'EI' : 'DI';
  const halt = cpu.halted ? ' HALT' : '';
  const lines = [
    `AF  ${hex16(cpu.af)}  AF' ${hex16((cpu.a_ << 8) | cpu.f_)}`,
    `BC  ${hex16(cpu.bc)}  BC' ${hex16((cpu.b_ << 8) | cpu.c_)}`,
    `DE  ${hex16(cpu.de)}  DE' ${hex16((cpu.d_ << 8) | cpu.e_)}`,
    `HL  ${hex16(cpu.hl)}  HL' ${hex16((cpu.h_ << 8) | cpu.l_)}`,
    `IX  ${hex16(cpu.ix)}  IY  ${hex16(cpu.iy)}  ${iff}  IM${cpu.im}${halt}`,
    `SP  ${hex16(cpu.sp)}  PC  ${hex16(cpu.pc)}  IR  ${hex8(cpu.i)}${hex8(cpu.r)}`,
    `Flags: ${flags}`,
  ];
  // Disassembly at PC
  const mem = cpu.memory;
  const dLines = disassemble(mem, cpu.pc, 16);
  lines.push('');
  for (const dl of dLines) {
    const addr = hex16(dl.addr);
    const bytes: string[] = [];
    for (let i = 0; i < dl.length; i++) bytes.push(hex8(mem[(dl.addr + i) & 0xFFFF]));
    const bytesStr = bytes.join(' ').padEnd(11);
    const mnem = stripMarkers(dl.text);
    lines.push(`${dl.addr === cpu.pc ? '>' : ' '} ${addr}  ${bytesStr}  ${mnem}`);
  }
  navigator.clipboard.writeText(lines.join('\n'));
  setStatus('CPU state + disassembly copied to clipboard');
}

export type TraceMode = 'full' | 'contention' | 'portio';

export function startTrace(mode: TraceMode = 'full'): void {
  if (!spectrum) return;
  spectrum.startTrace(mode);
  tracing.value = true;
}

export function stopTrace(): void {
  if (!spectrum) return;
  const text = spectrum.stopTrace();
  tracing.value = false;
  navigator.clipboard.writeText(text);
  const lines = text.split('\n').length;
  setStatus(`Trace copied to clipboard (${lines.toLocaleString()} lines)`);
}

// ── Model switching ─────────────────────────────────────────────────────

export async function switchModel(model: SpectrumModel): Promise<void> {
  currentModel.value = model;
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

  createMachine();
}

// ── ROM loading ─────────────────────────────────────────────────────────

export async function applyROM(data: Uint8Array, fileLabel: string): Promise<void> {
  romData = data;

  let detectedModel: SpectrumModel;
  if (data.length >= 65536) {
    detectedModel = isPlus2AClass(currentModel.value) ? currentModel.value : '+2a';
  } else if (data.length >= 32768) {
    detectedModel = is128kClass(currentModel.value) ? currentModel.value : '128k';
  } else if (data.length >= 16384) {
    detectedModel = '48k';
  } else {
    setStatus(`ROM too small (${data.length} bytes)`);
    return;
  }

  currentModel.value = detectedModel;
  saveModel(detectedModel);

  await persistROM(detectedModel, data, fileLabel);
  setRomStatus('');

  createMachine();
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
      currentModel.value = model;
      romData = entry.data;
      setRomStatus('');
      createMachine();
      return true;
    }
  }
  return false;
}

async function applySnapshot(data: Uint8Array, filename: string): Promise<boolean> {
  if (!spectrum) {
    setStatus('Load a ROM first');
    return false;
  }

  const ext = filename.toLowerCase().split('.').pop();

  try {
    if (ext === 'sna') {
      if (data.length > 49179 && !is128kClass(currentModel.value)) {
        if (!await ensure128kROM()) {
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

      if (result.is128K && !is128kClass(currentModel.value)) {
        if (!await ensure128kROM()) {
          setStatus('128K .z80 snapshot requires a 128K ROM — load one first');
          return false;
        }
        spectrum!.stop();
        spectrum!.reset();
        loadZ80(data, spectrum!.cpu, spectrum!.memory);
      }

      spectrum!.ula.borderColor = result.borderColor;
      spectrum!.cpu.memory = spectrum!.memory.flat;
      spectrum!.start();
      setStatus(`Loaded ${result.is128K ? '128K' : '48K'} .z80: ${filename}`);
    } else if (ext === 'szx') {
      spectrum.stop();
      spectrum.reset();
      const result = await loadSZX(data, spectrum.cpu, spectrum.memory);

      if (result.is128K && !is128kClass(currentModel.value)) {
        if (!await ensure128kROM()) {
          setStatus('128K .szx snapshot requires a 128K ROM — load one first');
          return false;
        }
        spectrum!.stop();
        spectrum!.reset();
        await loadSZX(data, spectrum!.cpu, spectrum!.memory);
      }

      // Apply paging state for 128K
      if (result.is128K) {
        spectrum!.memory.port7FFD = result.port7FFD;
        spectrum!.memory.currentBank = result.port7FFD & 0x07;
        spectrum!.memory.currentROM = (result.port7FFD >> 4) & 1;
        spectrum!.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
        if (isPlus2AClass(currentModel.value)) {
          spectrum!.memory.port1FFD = result.port1FFD;
          spectrum!.memory.specialPaging = (result.port1FFD & 1) !== 0;
        }
        spectrum!.memory.applyBanking();
      }

      spectrum!.ula.borderColor = result.borderColor;
      spectrum!.cpu.memory = spectrum!.memory.flat;

      // Restore AY state if present
      if (result.ayRegs) {
        spectrum!.ay.setRegisters(result.ayRegs);
        if (result.ayCurrentReg !== undefined) {
          spectrum!.ay.selectedReg = result.ayCurrentReg;
        }
      }

      spectrum!.start();
      setStatus(`Loaded ${result.is128K ? '128K' : '48K'} .szx: ${filename}`);
    } else if (ext === 'sp') {
      spectrum.stop();
      spectrum.reset();
      const result = loadSP(data, spectrum.cpu, spectrum.memory);

      if (result.is128K && !is128kClass(currentModel.value)) {
        if (!await ensure128kROM()) {
          setStatus('128K .sp snapshot requires a 128K ROM — load one first');
          return false;
        }
        spectrum!.stop();
        spectrum!.reset();
        loadSP(data, spectrum!.cpu, spectrum!.memory);
      }

      // Apply paging state for 128K
      if (result.is128K) {
        spectrum!.memory.port7FFD = result.port7FFD;
        spectrum!.memory.currentBank = result.port7FFD & 0x07;
        spectrum!.memory.currentROM = (result.port7FFD >> 4) & 1;
        spectrum!.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
        spectrum!.memory.applyBanking();
      }

      spectrum!.ula.borderColor = result.borderColor;
      spectrum!.cpu.memory = spectrum!.memory.flat;
      spectrum!.start();
      setStatus(`Loaded ${result.is128K ? '128K' : '48K'} .sp: ${filename}`);
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

// ── Tape loading ────────────────────────────────────────────────────────

export function applyTape(data: Uint8Array, filename: string): void {
  if (!spectrum) { setStatus('Load a ROM first'); return; }

  // Stop the machine first to prevent the frame loop from interfering
  spectrum.stop();

  const ext = filename.toLowerCase().split('.').pop();
  let blocks: TapeBlock[];
  try {
    if (ext === 'tzx') {
      blocks = parseTZX(data);
    } else {
      blocks = spectrum.tape.parseTAP(data);
    }
  } catch (e) {
    spectrum.start();
    setStatus(`Error: ${(e as Error).message}`);
    return;
  }

  // Set tape state on the deck — start paused so the playback engine
  // doesn't race ahead through blocks before the ROM actually tries to LOAD.
  spectrum.tape.blocks = blocks;
  spectrum.tape.position = 0;
  spectrum.tape.paused = true;

  // Reset machine (preserves tape) and restart
  spectrum.reset();
  spectrum.start();

  // Update UI signals after machine state is settled
  batch(() => {
    tapeLoaded.value = true;
    tapeBlocks.value = [...blocks];
    tapePosition.value = 0;
    tapePaused.value = true;
    tapePlaying.value = true;
  });

  unpause();
  setStatus(`Tape loaded: ${filename}`);
}

// ── File routing ────────────────────────────────────────────────────────

export async function loadFile(data: Uint8Array, filename: string): Promise<void> {
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

  if (ext === 'sna' || ext === 'z80' || ext === 'szx' || ext === 'sp') {
    if (await applySnapshot(data, filename)) {
      persistLastFile(data, filename);
    }
    return;
  }

  setStatus(`Unknown file type: .${ext}`);
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

  await loadFile(chosen.data, chosen.name);
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

export function saveSnapshot(format: 'sna' | 'z80' = 'sna'): void {
  if (!spectrum) { setStatus('No machine running'); return; }

  const wasPaused = emulationPaused.value;
  if (!wasPaused) spectrum.stop();

  // For now, .z80 saves as .sna (full .z80 writer not yet implemented)
  const data = saveSNA(spectrum.cpu, spectrum.memory, spectrum.ula.borderColor);
  const model = is128kClass(currentModel.value) ? '128k' : '48k';
  const ext = format === 'z80' ? 'sna' : format; // TODO: implement .z80 writer
  const filename = `zx84-${model}.${ext}`;

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

  const wasPaused = emulationPaused.value;
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
  tapePosition.value = 0;
}

export function tapePrev(): void {
  if (!spectrum) return;
  if (spectrum.tape.position > 0) spectrum.tape.position--;
  tapePosition.value = spectrum.tape.position;
}

export function tapeTogglePause(): void {
  if (!spectrum) return;
  spectrum.tape.paused = !spectrum.tape.paused;
  tapePaused.value = spectrum.tape.paused;
}

export function tapeNext(): void {
  if (!spectrum) return;
  if (spectrum.tape.position < spectrum.tape.blocks.length) spectrum.tape.position++;
  tapePosition.value = spectrum.tape.position;
}

export function tapeSetPosition(pos: number): void {
  if (!spectrum) return;
  spectrum.tape.position = pos;
  tapePosition.value = pos;
}

export function toggleAutoRewind(): void {
  settings.tapeAutoRewind.value = !settings.tapeAutoRewind.value;
  settings.persistSetting('tape-auto-rewind', settings.tapeAutoRewind.value ? 'on' : 'off');
}

// ── Per-frame bridge ────────────────────────────────────────────────────

function hex8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

const FLAG_TIPS: Record<string, string> = {
  Sign: 'Set if result is negative (bit 7 of result)',
  Zero: 'Set if result is zero',
  Half: 'Half-carry: set on carry from bit 3 to bit 4',
  Prty: 'Parity/Overflow: set on even parity or arithmetic overflow',
  Subt: 'Subtract: set if last operation was a subtraction',
  Crry: 'Carry: set on carry from bit 7 or borrow',
};

function flagHtml(label: string, on: boolean): string {
  const tip = FLAG_TIPS[label] || '';
  return on
    ? `<span class="flag-on" data-tip="${tip}">☑ ${label}</span>`
    : `<span class="flag-off" data-tip="${tip}">☐ ${label}</span>`;
}

function renderRegs(cpu: Z80, tStatesPerFrame?: number): string {
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

  const r = (name: string, tip: string) => `<span class="reg-name" data-tip="${tip}">${name}</span>`;
  return [
    `${r('AF','Accumulator and Flags')}  ${hex16(cpu.af)}  ${r("AF'",'Shadow Accumulator and Flags')} ${hex16((cpu.a_ << 8) | cpu.f_)}   ${flags1}`,
    `${r('BC','General-purpose register pair B and C')}  ${hex16(cpu.bc)}  ${r("BC'",'Shadow BC')} ${hex16((cpu.b_ << 8) | cpu.c_)}   ${flags2}`,
    `${r('DE','General-purpose register pair D and E')}  ${hex16(cpu.de)}  ${r("DE'",'Shadow DE')} ${hex16((cpu.d_ << 8) | cpu.e_)}   ${flags3}`,
    `${r('HL','General-purpose register pair H and L')}  ${hex16(cpu.hl)}  ${r("HL'",'Shadow HL')} ${hex16((cpu.h_ << 8) | cpu.l_)}   ${tStatesPerFrame != null ? `${r('T/F','T-states per frame')} ${tStatesPerFrame.toLocaleString()}` : ''}`,
    `${r('IX','Index register X')}  ${hex16(cpu.ix)}  ${r('IY','Index register Y')}  ${hex16(cpu.iy)}   ${iff}  ${r('IM','Interrupt mode')}${cpu.im}${halt}`,
    `${r('SP','Stack pointer')}  ${hex16(cpu.sp)}  ${r('PC','Program counter')}  ${hex16(cpu.pc)}   ${r('IR','Interrupt vector + Refresh counter')}  ${hex8(cpu.i)}${hex8(cpu.r)}`,
  ].join('\n');
}

function renderSysVars(mem: Uint8Array, model: SpectrumModel): string {
  const w = (lo: number) => mem[lo] | (mem[lo + 1] << 8);
  const rows: [string, string, string, string, string, string][] = [
    ['ERR_NR',  hex8(mem[0x5C3A]),        '1 less than error report code',
     'FLAGS',   hex8(mem[0x5C3B]),         'Various flags to control the BASIC system'],
    ['FLAGS2',  hex8(mem[0x5C71]),         'More flags',
     'TV_FLAG', hex8(mem[0x5C3C]),         'Flags associated with the TV'],
    ['MODE',    hex8(mem[0x5C41]),         'Current cursor mode: K/L/C/E/G',
     'PPC',     hex16(w(0x5C45)),          'Line number of statement currently being executed'],
    ['CHARS',   hex16(w(0x5C36)),          'Address of character set (256 less than actual)',
     'UDG',     hex16(w(0x5C7B)),          'Address of first user-defined graphic'],
    ['DF_CC',   hex16(w(0x5C84)),          'Address in display file of PRINT position',
     'DFCCL',   hex16(w(0x5C86)),          'Like DF_CC for lower part of screen'],
    ['S_POSN',  hex8(mem[0x5C88]) + ',' + hex8(mem[0x5C89]), 'Column and line number for PRINT position',
     'ATTR_P',  hex8(mem[0x5C8D]),         'Permanent current colours (as set by INK, PAPER etc.)'],
    ['ATTR_T',  hex8(mem[0x5C8F]),         'Temporary current colours (as used by PRINT items)',
     'BORDCR',  hex8(mem[0x5C48]),         'Border colour * 8; also attributes for lower screen'],
    ['CHANS',   hex16(w(0x5C4F)),          'Address of channel data area',
     'CURCHL',  hex16(w(0x5C51)),          'Address of currently selected channel information'],
    ['PROG',    hex16(w(0x5C53)),          'Address of BASIC program',
     'VARS',    hex16(w(0x5C4B)),          'Address of variables area'],
    ['E_LINE',  hex16(w(0x5C59)),          'Address of command being typed in',
     'STKEND',  hex16(w(0x5C65)),          'Address of start of spare space (end of calculator stack)'],
    ['RAMTOP',  hex16(w(0x5CB2)),          'Address of last byte of BASIC system area',
     'P_RAMT',  hex16(w(0x5CB4)),          'Address of last byte of physical RAM'],
    ['DF_SZ',   hex8(mem[0x5C6B]),         'Number of lines in lower part of screen',
     'SCR_CT',  hex8(mem[0x5C8C]),         'Scroll count — number of scrolls before "scroll?" message'],
  ];

  // 128K/+2/+2A/+3: extra sysvars in the old printer buffer (5B00-5BFF)
  if (is128kClass(model)) {
    rows.push(
      ['BANKM',  hex8(mem[0x5B5C]),          'Copy of port 7FFD (paging control)',
       'BAUD',   hex16(w(0x5B5F)),            'RS232 bit period in T-states/26'],
      ['SERFL',  hex8(mem[0x5B61]) + ',' + hex8(mem[0x5B62]), 'RS232 second-char-received flag and data',
       'COL',    hex8(mem[0x5B63]),            'Current column from 1 to WIDTH'],
      ['WIDTH',  hex8(mem[0x5B64]),            'Paper column width (default 80)',
       'TVPARS', hex8(mem[0x5B65]),            'Number of inline RS232 parameters expected'],
      ['FLAGS3', hex8(mem[0x5B66]),            'Printer/device flags (bit 3: RS232, bit 4: disk)',
       'OLDSP',  hex16(w(0x5B6A)),             'Old stack pointer when TSTACK in use'],
    );
  }

  // +2A/+3: disk-related variables
  if (isPlus2AClass(model)) {
    rows.push(
      ['BNK678', hex8(mem[0x5B67]),            'Copy of port 1FFD (ext. paging, disk motor, strobe)',
       'LODDRV', String.fromCharCode(mem[0x5B79] || 0x54), 'Default device for LOAD/VERIFY/MERGE'],
      ['SAVDRV', String.fromCharCode(mem[0x5B7A] || 0x54), 'Default device for SAVE',
       'DUMPLF', hex8(mem[0x5B7B]),            'Line feed units for COPY EXP (normally 9)'],
    );
  }

  const s = (name: string, tip: string) =>
    `<span class="reg-name" data-tip="${tip}">${name}</span>`;
  return rows.map(([n1, v1, t1, n2, v2, t2]) =>
    `${s(n1, t1)}${n1.length < 7 ? ' '.repeat(7 - n1.length) : ''} ${v1.length < 5 ? ' '.repeat(5 - v1.length) : ''}${v1}       ${s(n2, t2)}${n2.length < 7 ? ' '.repeat(7 - n2.length) : ''} ${v2.length < 5 ? ' '.repeat(5 - v2.length) : ''}${v2}`
  ).join('\n');
}

function renderBanks(): string {
  if (!spectrum) return '';
  const mem = spectrum.memory;
  const model = currentModel.value;
  const n = '<span class="reg-name">';
  const e = '</span>';
  const plus2a = isPlus2AClass(model);

  // Helper to format a memory region
  const region = (addr: string, label: string) => `${n}${addr}${e} ${label}`;

  const lines: string[] = [];

  // Determine memory layout
  if (plus2a && mem.specialPaging) {
    // Special paging mode - all RAM
    const mode = (mem.port1FFD >> 1) & 3;
    const configs = [
      ['0', '1', '2', '3'],
      ['4', '5', '6', '7'],
      ['4', '5', '6', '3'],
      ['4', '7', '6', '3'],
    ];
    const [b0, b1, b2, b3] = configs[mode];
    lines.push(
      region('C000-FFFF', `RAM Bank ${b3}`),
      region('8000-BFFF', `RAM Bank ${b2}`),
      region('4000-7FFF', `RAM Bank ${b1}`),
      region('0000-3FFF', `RAM Bank ${b0}`),
    );
  } else {
    // Normal paging
    const romNum = mem.currentROM;
    let romLabel = '';
    if (plus2a) {
      romLabel = `ROM Page ${romNum}`;
    } else {
      romLabel = romNum === 0 ? '128K Editor ROM' : '48K BASIC ROM';
    }

    const screenBank = (mem.port7FFD & 0x08) ? 7 : 5;
    const isScreenPage = (bank: number) => bank === screenBank;

    lines.push(
      region('C000-FFFF', `RAM Bank ${mem.currentBank}${isScreenPage(mem.currentBank) ? ' (Screen)' : ''}`),
      region('8000-BFFF', `RAM Bank 2`),
      region('4000-7FFF', `RAM Bank 5${isScreenPage(5) ? ' (Screen)' : ''}`),
      region('0000-3FFF', romLabel),
    );
  }

  // Port values and status
  let portLine = `${n}7FFD${e} ${hex8(mem.port7FFD)}`;
  if (plus2a) portLine += `  ${n}1FFD${e} ${hex8(mem.port1FFD)}`;
  portLine += `  ${n}Lock${e} ${mem.pagingLocked ? 'Y' : 'N'}`;

  lines.push('', portLine);

  return lines.join('\n');
}

function renderDiskInfoStr(): string {
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

function renderDriveStr(): string {
  if (!spectrum) return '';
  const fdc = spectrum.fdc;
  fdc.tickFrame();
  const n = '<span class="reg-name">';
  const e = '</span>';
  const motor = fdc.motorOn ? 'On' : 'Off';
  const track = fdc.currentTrack.toString().padStart(2, '0');
  const head = fdc.currentHead;
  const sector = fdc.isExecuting ? fdc.currentSector.toString().padStart(2, '0') : '--';
  const operation = fdc.isExecuting ? (fdc.isWriting ? 'WRITE' : 'READ') : '(idle)';
  return [
    `${n}Motor${e}  ${motor}  ${n}Operation${e} ${operation}`,
    `${n}Head${e} ${head}  ${n}Track${e}  ${track}  ${n}Sector${e} ${sector}`,
  ].join('\n');
}

/** Update banks, disk info, drive status, and trap log signals. */
function updateHardwareSignals(model: SpectrumModel): void {
  if (is128kClass(model)) {
    banksHtml.value = renderBanks();
  }
  if (isPlus3(model)) {
    if (currentDiskInfo) {
      diskInfoHtml.value = renderDiskInfoStr();
    }
    driveHtml.value = renderDriveStr();
    if (spectrum!.diskMode === 'bios' && spectrum!.biosTrap) {
      const entries = spectrum!.biosTrap.trapLog;
      trapLogHtml.value = entries.length > 0
        ? entries.map(e =>
            e.startsWith('UNTRAPPED')
              ? `<span class="trap-warn">${e}</span>`
              : e
          ).join('\n')
        : '<span style="color:#666">(no traps fired)</span>';
      showTrapLog.value = true;
    } else {
      showTrapLog.value = false;
    }
  }
}

/** Update disassembly and system variable signals. */
function updateDebugSignals(): void {
  sysvarHtml.value = renderSysVars(spectrum!.cpu.memory, currentModel.value);
  const cpu = spectrum!.cpu;
  const dLines = disassembleAroundPC(cpu.memory, cpu.pc, 24);
  disasmText.value = formatDisasmHtml(dLines, cpu.memory, cpu.pc, spectrum!.breakpoints);
}

function updateRegsOnce(): void {
  if (!spectrum) return;
  batch(() => {
    regsHtml.value = renderRegs(spectrum!.cpu, spectrum!.tStatesPerFrame);
    updateDebugSignals();
    updateHardwareSignals(currentModel.value);
  });
}

function updateClockSpeed(): void {
  if (!spectrum) return;
  speedFrameCount++;
  if (speedFrameCount < 50) return;   // update every ~1 second
  speedFrameCount = 0;
  const now = performance.now();
  const elapsed = (now - speedLastTime) / 1000;
  const tStates = spectrum.cpu.tStates - speedLastTStates;
  speedLastTime = now;
  speedLastTStates = spectrum.cpu.tStates;
  if (elapsed > 0) {
    const mhz = (tStates / elapsed) / 1_000_000;
    clockSpeedText.value = `${mhz.toFixed(2)} MHz`;
  }
}

// Font preview (called per-frame)
export function fontDataHash(data: Uint8Array, offset: number, len: number): number {
  let h = 0;
  for (let i = 0; i < len; i++) h = (h * 31 + data[offset + i]) | 0;
  return h;
}

export function updateFontPreview(): { type: 'custom'; data: Uint8Array } | { type: 'rom'; data: Uint8Array } | null {
  const name = settings.fontName.value;

  if (name) {
    const store = loadFontStore();
    const b64 = store[name];
    if (!b64) return null;
    const binary = atob(b64);
    const font = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) font[i] = binary.charCodeAt(i);
    romFontCacheAddr = -1;
    romFontCacheHash = -1;
    return { type: 'custom', data: font };
  } else {
    if (!spectrum) return null;
    const mem = spectrum.memory.flat;
    let charsAddr = mem[0x5C36] | (mem[0x5C37] << 8);
    if (charsAddr === 0) charsAddr = 0x3C00;
    const fontStart = charsAddr + 256;
    if (fontStart + 768 > 65536) return null;

    let spaceBlank = true;
    for (let i = 0; i < 8; i++) { if (mem[fontStart + i] !== 0) { spaceBlank = false; break; } }
    if (!spaceBlank) return null;

    const hash = fontDataHash(mem, fontStart, 768);
    if (fontStart === romFontCacheAddr && hash === romFontCacheHash) return null;
    romFontCacheAddr = fontStart;
    romFontCacheHash = hash;

    capturedFontData = mem.slice(fontStart, fontStart + 768);
    return { type: 'rom', data: capturedFontData };
  }
}

export function loadFontStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem('zx84-fonts');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveFontStore(store: Record<string, string>): void {
  try { localStorage.setItem('zx84-fonts', JSON.stringify(store)); } catch { /* */ }
}

function onFrame(): void {
  if (!spectrum) return;
  updateClockSpeed();

  const a = spectrum.activity;
  const model = currentModel.value;

  // Check if a breakpoint fired this frame
  if (spectrum.breakpointHit >= 0) {
    spectrum.stop();
    emulationPaused.value = true;
    const addr = spectrum.breakpointHit;
    if (pendingRunTo === addr) {
      spectrum.breakpoints.delete(addr);
      pendingRunTo = -1;
      setStatus(`Run-to reached ${hex16(addr)}`);
    } else {
      setStatus(`Breakpoint hit at ${hex16(addr)}`);
    }
  }

  // Sync tracing signal if trace auto-stopped (buffer full)
  if (tracing.value && !spectrum.tracing) {
    const text = spectrum.stopTrace();
    tracing.value = false;
    navigator.clipboard.writeText(text);
    setStatus(`Trace auto-stopped and copied (${text.split('\n').length.toLocaleString()} lines)`);
  }

  batch(() => {
    ledKbd.value = a.ulaReads > 0;
    ledKemp.value = a.kempstonReads > 0;
    ledEar.value = a.earReads > 100;
    ledLoad.value = a.tapeLoads > 0;
    ledBeep.value = a.beeperToggled;
    ledAy.value = a.ayWrites > 5;
    ledDsk.value = a.fdcAccesses > 0;

    // Transcribe mode LEDs
    ledRst16.value = transcribeMode.value === 'rst16' || a.rst16Calls > 0;
    ledText.value = transcribeMode.value === 'text';

    // Tape position + pause state (pause may change via ROM trap auto-unpause)
    if (spectrum!.tape.loaded) {
      tapePosition.value = spectrum!.tape.position;
      if (tapePaused.value !== spectrum!.tape.paused) {
        tapePaused.value = spectrum!.tape.paused;
      }
    }

    // Registers + sysvars always updated
    regsHtml.value = renderRegs(spectrum!.cpu, spectrum!.tStatesPerFrame);
    sysvarHtml.value = renderSysVars(spectrum!.cpu.memory, model);

    // Disassembly only when paused (breakpoint hit etc.)
    if (emulationPaused.value) {
      const cpu = spectrum!.cpu;
      const dLines = disassembleAroundPC(cpu.memory, cpu.pc, 24);
      disasmText.value = formatDisasmHtml(dLines, cpu.memory, cpu.pc, spectrum!.breakpoints);
    }

    updateHardwareSignals(model);

    // Transcribe overlay
    if (transcribeMode.value !== 'off') {
      if (transcribeMode.value === 'text') {
        transcribeText.value = spectrum!.ocrScreen();
      } else {
        const grid = spectrum!.screenGrid;
        let text = '';
        for (let row = 0; row < 24; row++) {
          const offset = row * 32;
          for (let col = 0; col < 32; col++) {
            text += grid[offset + col];
          }
          if (row < 23) text += '\n';
        }
        transcribeText.value = text;
      }
    }
  });

  // Floppy sound (non-signal, side effect)
  if (floppySound && isPlus3(model)) {
    if (!floppySound['ctx'] && spectrum['audio'].ctx) {
      floppySound.attach(spectrum['audio'].ctx);
    }
    floppySound.update(spectrum.fdc.motorOn, spectrum.fdc.currentTrack);
  }
}

// ── Joystick helpers ────────────────────────────────────────────────────

export const KEMPSTON_BITS: Record<string, number> = {
  right: 0, left: 1, down: 2, up: 3, fire: 4,
};

export const CURSOR_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 4 },
  down:  { row: 4, bit: 4 },
  up:    { row: 4, bit: 3 },
  right: { row: 4, bit: 2 },
  fire:  { row: 4, bit: 0 },
};

export const SINCLAIR2_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 0 },
  right: { row: 3, bit: 1 },
  down:  { row: 3, bit: 2 },
  up:    { row: 3, bit: 3 },
  fire:  { row: 3, bit: 4 },
};

export const SINCLAIR1_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 4, bit: 4 },
  right: { row: 4, bit: 3 },
  down:  { row: 4, bit: 2 },
  up:    { row: 4, bit: 1 },
  fire:  { row: 4, bit: 0 },
};

export function joyPressForType(dir: string, pressed: boolean, mode: string): void {
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

// ── Init ────────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  const model = currentModel.value;

  let entry = await restoreROM(model);
  if (!entry) entry = await fetchDefaultROM(model);

  if (entry) {
    romData = entry.data;
    setRomStatus('');
    createMachine();

    const last = await restoreLastFile();
    if (last) {
      await loadFile(last.data, last.name);
    }
  }
}

// ── Transcribe ──────────────────────────────────────────────────────────

export function toggleTranscribeMode(mode: 'rst16' | 'text'): void {
  if (transcribeMode.value === mode) {
    transcribeMode.value = 'off';
  } else {
    transcribeMode.value = mode;
  }
}

// ── Renderer switching ──────────────────────────────────────────────────

export function switchRenderer(mode: 'webgl' | 'canvas'): void {
  settings.renderer.value = mode;
  settings.persistSetting('renderer', mode);
}

// ── Disk mode change ────────────────────────────────────────────────────

export function setDiskMode(mode: 'fdc' | 'bios'): void {
  settings.diskMode.value = mode;
  if (spectrum) spectrum.diskMode = mode;
  settings.persistSetting('disk-mode', mode);
}

// ── Audio init ──────────────────────────────────────────────────────────

export function initAudio(): void {
  if (spectrum && !spectrum['audio'].running) {
    spectrum['audio'].init();
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
