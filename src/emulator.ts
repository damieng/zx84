/**
 * Machine lifecycle: spectrum instance, ROM management, model switching.
 */

import { signal, batch } from '@preact/signals';
import { Spectrum, type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from '@/spectrum.ts';
import { WebGLRenderer } from '@/display/webgl-renderer.ts';
import { CanvasRenderer } from '@/display/canvas-renderer.ts';
import { FloppySound } from '@/plus3/floppy-sound.ts';
import { Z80 } from '@/cores/z80.ts';
import { loadSNA, saveSNA } from '@/snapshot/sna.ts';
import { loadZ80 } from '@/snapshot/z80format.ts';
import { loadSZX, saveSZX } from '@/snapshot/szx.ts';
import { loadSP } from '@/snapshot/sp.ts';
import { unzip } from '@/snapshot/zip.ts';
import { parseTZX } from '@/tape/tzx.ts';
import { parseDSK } from '@/plus3/dsk.ts';
import { showFilePicker } from '@/ui/zip-picker.ts';
import { disassemble, stripMarkers } from '@/debug/z80-disasm.ts';
import { dbSave, dbLoad, persistLastFile, restoreLastFile, clearLastFile } from '@/store/persistence.ts';
import * as settings from '@/store/settings.ts';
import type { DskImage } from '@/plus3/dsk.ts';
import type { TapeBlock } from '@/tape/tap.ts';
import { onFrame, updateRegsOnce, resetSpeedTracking, forceSpeedUpdate } from '@/frame-bridge.ts';
export { fontDataHash, updateFontPreview, loadFontStore, saveFontStore, capturedFontData } from '@/frame-bridge.ts';

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
export const basicHtml = signal('');
export const basicVarsHtml = signal('');
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
export const ledRainbow = signal(false);

// Clock speed display
export const clockSpeedText = signal('MHz');

// Tape signals
export const tapeLoaded = signal(false);
export const tapeName = signal('');
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
  if (spectrum) {
    // Swap display without rebuilding machine (e.g. renderer switch)
    const w = spectrum.ula.screenWidth;
    const h = spectrum.ula.screenHeight;
    spectrum.display = settings.renderer.value === 'canvas'
      ? new CanvasRenderer(el, w, h)
      : new WebGLRenderer(el, w, h);
    applyDisplaySettings();
  }
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

export async function createMachine(): Promise<boolean> {
  if (!canvasEl) return false;
  if (spectrum) {
    spectrum.destroy();
  }

  const model = currentModel.value;
  spectrum = new Spectrum(model, canvasEl, settings.renderer.value);
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
  return hmrRestored;
}

export function createMachineSync(): void {
  createMachine().catch(err => console.error('createMachine error:', err));
}

export function unpause(): void {
  emulationPaused.value = false;
}

function clearDebugPanels(): void {
  disasmText.value = '';
  sysvarHtml.value = '';
  basicHtml.value = '';
  basicVarsHtml.value = '';
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
  forceSpeedUpdate();
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
export function getPendingRunTo(): number { return pendingRunTo; }
export function clearPendingRunTo(): void { pendingRunTo = -1; }

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

  await createMachine();
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
      currentModel.value = model;
      romData = entry.data;
      setRomStatus('');
      await createMachine();
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
    tapeName.value = filename;
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

export function ejectTape(): void {
  if (!spectrum) return;
  spectrum.tape.blocks = [];
  spectrum.tape.position = 0;
  spectrum.tape.paused = true;
  tapeLoaded.value = false;
  tapeName.value = '';
  tapeBlocks.value = [];
  tapePosition.value = 0;
  tapePaused.value = true;
  setStatus('Tape ejected');
}

export function ejectDisk(): void {
  if (!spectrum) return;
  if (spectrum.fdc) spectrum.fdc.ejectDisk();
  currentDiskInfo = null;
  currentDiskName = '';
  diskInfoHtml.value = '';
  setStatus('Disk ejected');
}

function hex8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

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
    const hmrRestored = await createMachine();

    // Only restore last file if HMR state wasn't just restored
    if (!hmrRestored) {
      const last = await restoreLastFile();
      if (last) {
        await loadFile(last.data, last.name);
      }
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

// ── HMR state preservation ──────────────────────────────────────────────

const HMR_STATE_KEY = 'zx84-hmr-state';

export function saveHMRState(): void {
  if (!spectrum || !romData) return;

  try {
    // Stop emulation temporarily
    const wasPaused = emulationPaused.value;
    if (!wasPaused) spectrum.stop();

    // Save snapshot data as SZX
    const ayRegs = spectrum.ay.getRegisters();
    const szxData = saveSZX(
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
      model: currentModel.value,
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
      if (isPlus2AClass(currentModel.value)) {
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
