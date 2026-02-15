/**
 * Per-frame bridge: reads machine state, updates UI signals.
 *
 * Extracted from emulator.ts — contains all render helpers,
 * LED/clock/font updates, and the onFrame callback.
 */

import { batch } from '@preact/signals';
import { Z80 } from './cores/z80.ts';
import { type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from './spectrum.ts';
import { disassembleAroundPC, formatDisasmHtml } from './debug/z80-disasm.ts';
import { parseBasicProgram, parseBasicVariables } from './debug/basic-parser.ts';
import * as settings from './store/settings.ts';
import {
  spectrum, floppySound, currentDiskInfo, currentDiskName,
  currentModel, emulationPaused, tracing,
  regsHtml, sysvarHtml, basicHtml, basicVarsHtml,
  banksHtml, diskInfoHtml, driveHtml, trapLogHtml, showTrapLog, disasmText,
  clockSpeedText,
  tapePosition, tapePaused, transcribeMode, transcribeText,
  ledKbd, ledKemp, ledEar, ledLoad, ledRst16, ledText,
  ledBeep, ledAy, ledDsk, ledRainbow,
  setStatus, getPendingRunTo, clearPendingRunTo,
} from './emulator.ts';

// ── Hex formatting ──────────────────────────────────────────────────────

function hex8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

// ── Register rendering ──────────────────────────────────────────────────

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

// ── System variables rendering ──────────────────────────────────────────

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

// ── Hardware panel rendering ────────────────────────────────────────────

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

// ── Debug panel updates ─────────────────────────────────────────────────

/** Update disassembly, system variables, BASIC listing, and variables signals. */
function updateDebugSignals(): void {
  sysvarHtml.value = renderSysVars(spectrum!.cpu.memory, currentModel.value);
  basicHtml.value = parseBasicProgram(spectrum!.cpu.memory);
  basicVarsHtml.value = parseBasicVariables(spectrum!.cpu.memory);
  const cpu = spectrum!.cpu;
  const dLines = disassembleAroundPC(cpu.memory, cpu.pc, 24);
  disasmText.value = formatDisasmHtml(dLines, cpu.memory, cpu.pc, spectrum!.breakpoints);
}

export function updateRegsOnce(): void {
  if (!spectrum) return;
  batch(() => {
    regsHtml.value = renderRegs(spectrum!.cpu, spectrum!.tStatesPerFrame);
    updateDebugSignals();
    updateHardwareSignals(currentModel.value);
  });
}

// ── Clock speed tracking ────────────────────────────────────────────────

let speedLastTime = 0;
let speedLastTStates = 0;
let speedFrameCount = 0;

export function resetSpeedTracking(): void {
  speedLastTime = performance.now();
  speedLastTStates = 0;
  speedFrameCount = 0;
  clockSpeedText.value = 'MHz';
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

/** Force immediate MHz update on next frame (e.g. after turbo toggle). */
export function forceSpeedUpdate(): void {
  speedFrameCount = 49;
}

// ── Font preview ────────────────────────────────────────────────────────

let romFontCacheAddr = -1;
let romFontCacheHash = -1;
export let capturedFontData: Uint8Array | null = null;

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

// ── onFrame callback ────────────────────────────────────────────────────

export function onFrame(): void {
  if (!spectrum) return;
  updateClockSpeed();

  const a = spectrum.activity;
  const model = currentModel.value;

  // Check if a breakpoint fired this frame
  if (spectrum.breakpointHit >= 0) {
    spectrum.stop();
    emulationPaused.value = true;
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
    ledRainbow.value = a.attrWrites > 768;

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

    // Registers + sysvars + BASIC + vars always updated
    regsHtml.value = renderRegs(spectrum!.cpu, spectrum!.tStatesPerFrame);
    sysvarHtml.value = renderSysVars(spectrum!.cpu.memory, model);
    basicHtml.value = parseBasicProgram(spectrum!.cpu.memory);
    basicVarsHtml.value = parseBasicVariables(spectrum!.cpu.memory);

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
