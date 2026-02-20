/**
 * Per-frame bridge: reads machine state, updates UI signals.
 *
 * Extracted from emulator.ts — contains all render helpers,
 * LED/clock/font updates, and the onFrame callback.
 */

import { batch } from 'solid-js';
import { type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from '@/spectrum.ts';
import { disassembleAroundPC, formatDisasmHtml } from '@/debug/z80-disasm.ts';
import type { FontSource } from '@/debug/screen-text.ts';
import { parseBasicProgram, parseBasicVariables } from '@/debug/basic-parser.ts';
import { isCollapsed } from '@/ui/panes.ts';
import * as settings from '@/store/settings.ts';
import {
  spectrum, floppySound,
  currentModel, emulationPaused, tracing,
  setRegsRev, setSysvarRev, setBasicHtml, setBasicVarsHtml,
  setBanksHtml, setDriveHtml, setDriveAStatus, setDriveBStatus, setShowTrapLog, setDisasmText,
  setClockSpeedText,
  setTapePosition, tapePaused, setTapePaused, tapePlaying, setTapePlaying, transcribeMode, setTranscribeText, setTranscribeHtml,
  setLedKbd, setLedKemp, setLedEar, setLedLoad, setLedText,
  setLedBeep, setLedAy, setLedDsk, setLedRainbow, setLedMouse, setLedTapeTurbo,
  setStatus, setEmulationPaused, setTracing,
  getPendingRunTo, clearPendingRunTo,
} from '@/emulator.ts';

// ── Hex formatting ──────────────────────────────────────────────────────

function hex8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

// ── Hardware panel rendering ────────────────────────────────────────────

function renderBanks(): string {
  if (!spectrum) return '';
  const mem = spectrum.memory;
  const model = currentModel();
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

// Disk info now rendered directly in DrivePane component

function renderDriveStatus(unit: number): string {
  if (!spectrum) return '';
  const fdc = spectrum.fdc;
  const n = '<span class="reg-name">';
  const e = '</span>';
  
  const isActive = fdc.currentUnit === unit;
  const track = fdc.getUnitTrack(unit).toString().padStart(2, '0');
  const sector = fdc.isExecuting && isActive ? fdc.currentSector.toString().padStart(2, '0') : '--';
  
  let status: string;
  if (!fdc.motorOn || !isActive) {
    status = 'Off  ';
  } else if (fdc.isExecuting) {
    status = fdc.isWriting ? 'Write' : 'Read ';
  } else {
    status = 'Spin ';
  }
  
  return `${status} ${n}Track${e} ${track} ${n}Sector${e} ${sector}`;
}

/** Update banks, disk info, drive status, and trap log signals. */
function updateHardwareSignals(model: SpectrumModel): void {
  if (is128kClass(model)) {
    setBanksHtml(renderBanks());
  }
  if (isPlus3(model)) {
    spectrum!.fdc.tickFrame();
    setDriveAStatus(renderDriveStatus(0));
    setDriveBStatus(renderDriveStatus(1));
    setDriveHtml(renderDriveStatus(0)); // legacy
    setShowTrapLog(false);
  }
}

// ── Debug panel updates ─────────────────────────────────────────────────

/** Update disassembly, system variables, BASIC listing, and variables signals. */
function updateDebugSignals(): void {
  setSysvarRev(v => v + 1);
  setBasicHtml(parseBasicProgram(spectrum!.cpu.memory));
  setBasicVarsHtml(parseBasicVariables(spectrum!.cpu.memory));
  const cpu = spectrum!.cpu;
  const dLines = disassembleAroundPC(cpu.memory, cpu.pc, 24);
  setDisasmText(formatDisasmHtml(dLines, cpu.memory, cpu.pc, spectrum!.breakpoints));
}

export function updateRegsOnce(): void {
  if (!spectrum) return;
  batch(() => {
    setRegsRev(v => v + 1);
    updateDebugSignals();
    updateHardwareSignals(currentModel());
  });
}

// ── Throttle for expensive per-frame work ───────────────────────────────

let _lastSlowUpdate = 0;

// ── Clock speed tracking ────────────────────────────────────────────────

let speedLastTime = 0;
let speedLastTStates = 0;
let speedFrameCount = 0;

export function resetSpeedTracking(): void {
  speedLastTime = performance.now();
  speedLastTStates = 0;
  speedFrameCount = 0;
  setClockSpeedText('MHz');
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
    setClockSpeedText(`${mhz.toFixed(2)} MHz`);
  }
}

/** Force immediate MHz update on next frame (e.g. after turbo toggle). */
export function forceSpeedUpdate(): void {
  speedFrameCount = 49;
}

// ── Font preview ────────────────────────────────────────────────────────

let cachedExtraFonts: FontSource[] | undefined;
let romFontCacheAddr = -1;
let romFontCacheHash = -1;
export let capturedFontData: Uint8Array | null = null;

export function fontDataHash(data: Uint8Array, offset: number, len: number): number {
  let h = 0;
  for (let i = 0; i < len; i++) h = (h * 31 + data[offset + i]) | 0;
  return h;
}

export interface FontEntry {
  id: string;
  label: string;
  address: number | null;
  technique: 'file' | 'chars' | 'copyr' | 'scgrab';
  data: string;            // base64
}

export function updateFontPreview(): { type: 'custom'; data: Uint8Array } | { type: 'rom'; data: Uint8Array } | null {
  const id = settings.fontName();

  if (id) {
    const entries = loadFontStore();
    const entry = entries.find(e => e.id === id);
    if (!entry) return null;
    const binary = atob(entry.data);
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

export function loadFontStore(): FontEntry[] {
  try {
    const raw = localStorage.getItem('zx84-fonts');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Migrate old Record<string, string> format
    if (!Array.isArray(parsed)) {
      const entries: FontEntry[] = [];
      for (const [name, b64] of Object.entries(parsed)) {
        entries.push({ id: name, label: name, address: null, technique: 'file', data: b64 as string });
      }
      saveFontStore(entries);
      return entries;
    }
    return parsed;
  } catch { return []; }
}

export function saveFontStore(store: FontEntry[]): void {
  try { localStorage.setItem('zx84-fonts', JSON.stringify(store)); } catch { /* */ }
}

// ── onFrame callback ────────────────────────────────────────────────────

export function onFrame(): void {
  if (!spectrum) return;
  updateClockSpeed();

  const a = spectrum.activity;
  const model = currentModel();

  // Check if a breakpoint fired this frame
  if (spectrum.breakpointHit >= 0) {
    spectrum.stop();
    setEmulationPaused(true);
    const addr = spectrum.breakpointHit;
    if (getPendingRunTo() === addr) {
      spectrum.breakpoints.delete(addr);
      clearPendingRunTo();
      setStatus(`Run-to reached ${hex16(addr)}`);
    } else {
      setStatus(`Breakpoint hit at ${hex16(addr)}`);
    }
  }

  // Sync tracing signal if trace auto-stopped (buffer full)
  if (tracing() && !spectrum.tracing) {
    const text = spectrum.stopTrace();
    setTracing(false);
    navigator.clipboard.writeText(text);
    setStatus(`Trace auto-stopped and copied (${text.split('\n').length.toLocaleString()} lines)`);
  }

  batch(() => {
    setLedKbd(a.ulaReads > 0);
    setLedKemp(a.kempstonReads > 0);
    setLedEar(a.earReads > 100);
    setLedLoad(a.tapeLoads > 0);
    setLedBeep(a.beeperToggled);
    setLedAy(a.ayWrites > 5);
    setLedDsk(a.fdcAccesses > 0);
    setLedRainbow(a.attrWrites > 768);
    setLedMouse(a.mouseReads > 0);
    setLedTapeTurbo(spectrum!.tapeTurboActive);

    // Transcribe mode LEDs
    setLedText(transcribeMode() === 'text' || a.earReads > 0);

    // Tape position + play/pause state (may change via ROM trap or loader detector)
    if (spectrum!.tape.loaded) {
      setTapePosition(spectrum!.tape.position);

      // Auto-rewind: if tape just finished and auto-rewind is on, rewind to
      // start in play+paused state — ready for the next EAR read to unpause.
      if (!spectrum!.tape.playing && spectrum!.tape.finished && settings.tapeAutoRewind()) {
        spectrum!.tape.position = 0;
        spectrum!.tape.paused = true;
        spectrum!.tape.startPlayback();
        setTapePosition(0);
      }

      if (tapePlaying() !== spectrum!.tape.playing) {
        setTapePlaying(spectrum!.tape.playing);
      }
      if (tapePaused() !== spectrum!.tape.paused) {
        setTapePaused(spectrum!.tape.paused);
      }
    }

    // Registers — only if debugger pane is open
    if (!isCollapsed('disasm-panel')) {
      setRegsRev(v => v + 1);

      // Disassembly only when paused (breakpoint hit etc.)
      if (emulationPaused()) {
        const cpu = spectrum!.cpu;
        const dLines = disassembleAroundPC(cpu.memory, cpu.pc, 24);
        setDisasmText(formatDisasmHtml(dLines, cpu.memory, cpu.pc, spectrum!.breakpoints));
      }
    }

    // Sysvars + BASIC — throttled to ~1Hz, only if pane is open
    const now = performance.now();
    if (now - _lastSlowUpdate > 1000) {
      _lastSlowUpdate = now;
      if (!isCollapsed('sysvar-panel')) {
        setSysvarRev(v => v + 1);
      }
      if (!isCollapsed('basic-panel')) {
        setBasicHtml(parseBasicProgram(spectrum!.cpu.memory));
      }
      if (!isCollapsed('basic-vars-panel')) {
        setBasicVarsHtml(parseBasicVariables(spectrum!.cpu.memory));
      }
    }

    updateHardwareSignals(model);

    // Transcribe overlay
    if (transcribeMode() !== 'off') {
      if (!spectrum!.screenText.active) {
        // Just toggled on — activate and snapshot the font store
        spectrum!.screenText.activate();
        cachedExtraFonts = loadFontStore().map(e => {
          const binary = atob(e.data);
          const data = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
          return { label: e.label, data };
        });
      }
      const result = spectrum!.ocrScreenStyled(cachedExtraFonts);
      setTranscribeText(result.text);
      setTranscribeHtml(result.html);
      // Blank matched character cells in the framebuffer and re-upload
      if (result.mask.length > 0) {
        spectrum!.ula.blankCells(spectrum!.memory.screenBank, result.mask, 0x4000);
        if (spectrum!.display) spectrum!.display.updateTexture(spectrum!.ula.pixels);
      }
    } else {
      if (spectrum!.screenText.active) {
        spectrum!.screenText.deactivate();
        cachedExtraFonts = undefined;
      }
    }
  });

  // Floppy sound (non-signal, side effect)
  if (floppySound && isPlus3(model) && settings.diskSoundEnabled()) {
    // Attach to audio context if not already attached
    if (!floppySound['ctx'] && spectrum!['audio'].ctx) {
      floppySound.attach(spectrum!['audio'].ctx);
    }
    // Update motor state (this generates the sounds)
    floppySound.update(spectrum!.fdc.motorOn, spectrum!.fdc.currentTrack);
  } else if (floppySound) {
    // Stop any running motor sound when disabled
    floppySound.reset();
  }
}
