/**
 * MCP Server for ZX84 emulator.
 *
 * Wraps the Spectrum emulator as a persistent MCP tool server so Claude Code
 * can interact with it without spinning up/tearing down the harness each time.
 *
 * Usage:
 *   npx tsx src/mcp-server.ts [--model 48k|128k|+2|+2a|+3]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Spectrum, type SpectrumModel, is128kClass } from './spectrum.ts';
import { disasmOne, disassemble, stripMarkers } from './debug/z80-disasm.ts';
import { loadSNA } from './snapshot/sna.ts';
import { loadZ80 } from './snapshot/z80format.ts';
import { loadSZX, saveSZX } from './snapshot/szx.ts';
import { parseDSK } from './plus3/dsk.ts';
import { parseTZX } from './tape/tzx.ts';
import { variantForModel, variantLabel, romFilename } from './peripherals/multiface.ts';

// ── ROM URLs ─────────────────────────────────────────────────────────────

const ROM_URLS: Record<SpectrumModel, string> = {
  '48k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '128k': 'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/128/spec128uk.rom',
  '+2':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/plus2/plus2uk.rom',
  '+2a':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus2a/plus2a.rom',
  '+3':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus3/plus3.rom',
};

const CACHE_DIR = path.join(import.meta.dirname!, '.cache');

async function fetchROM(model: SpectrumModel): Promise<Uint8Array> {
  const url = ROM_URLS[model];
  const filename = url.split('/').pop()!;
  const cachePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(cachePath)) return new Uint8Array(fs.readFileSync(cachePath));
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ROM`);
  const data = new Uint8Array(await resp.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, data);
  return data;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const h8 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const h16 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

function parseAddr(s: string): number {
  s = s.trim().toLowerCase();
  if (s.startsWith('0x')) return parseInt(s.slice(2), 16);
  if (s.startsWith('$')) return parseInt(s.slice(1), 16);
  // Always hex — this is a Z80 debugger
  return parseInt(s, 16);
}

const KEY_NAME_MAP: Record<string, string> = {
  'a': 'KeyA', 'b': 'KeyB', 'c': 'KeyC', 'd': 'KeyD', 'e': 'KeyE',
  'f': 'KeyF', 'g': 'KeyG', 'h': 'KeyH', 'i': 'KeyI', 'j': 'KeyJ',
  'k': 'KeyK', 'l': 'KeyL', 'm': 'KeyM', 'n': 'KeyN', 'o': 'KeyO',
  'p': 'KeyP', 'q': 'KeyQ', 'r': 'KeyR', 's': 'KeyS', 't': 'KeyT',
  'u': 'KeyU', 'v': 'KeyV', 'w': 'KeyW', 'x': 'KeyX', 'y': 'KeyY',
  'z': 'KeyZ',
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  'enter': 'Enter', 'space': 'Space',
  'shift': 'ShiftLeft', 'sym': 'ControlLeft',
  'backspace': 'Backspace', 'delete': 'Delete',
  'left': 'ArrowLeft', 'right': 'ArrowRight',
  'up': 'ArrowUp', 'down': 'ArrowDown',
  'capslock': 'CapsLock', 'escape': 'Escape', 'esc': 'Escape',
};

function formatStep(spec: Spectrum): string {
  const cpu = spec.cpu;
  const snap = spec.memory.snapshot();
  const line = disasmOne(snap, cpu.pc);
  const mnem = stripMarkers(line.text).padEnd(20);
  return (
    `${h16(cpu.pc)}  ${mnem}` +
    `A=${h8(cpu.a)} F=${h8(cpu.f)} ` +
    `BC=${h16(cpu.bc)} DE=${h16(cpu.de)} HL=${h16(cpu.hl)} ` +
    `SP=${h16(cpu.sp)}  T=${cpu.tStates}`
  );
}

function formatRegs(spec: Spectrum): string {
  const cpu = spec.cpu;
  const f = cpu.f;
  const flags = [
    (f & 0x80) ? 'S' : '-', (f & 0x40) ? 'Z' : '-',
    (f & 0x10) ? 'H' : '-', (f & 0x04) ? 'P' : '-',
    (f & 0x02) ? 'N' : '-', (f & 0x01) ? 'C' : '-',
  ].join('');
  const iff = cpu.iff1 ? 'EI' : 'DI';
  const halt = cpu.halted ? ' HALT' : '';
  const lines = [
    `AF  ${h16(cpu.af)}  AF' ${h16((cpu.a_ << 8) | cpu.f_)}   Flags: ${flags}`,
    `BC  ${h16(cpu.bc)}  BC' ${h16((cpu.b_ << 8) | cpu.c_)}`,
    `DE  ${h16(cpu.de)}  DE' ${h16((cpu.d_ << 8) | cpu.e_)}`,
    `HL  ${h16(cpu.hl)}  HL' ${h16((cpu.h_ << 8) | cpu.l_)}`,
    `IX  ${h16(cpu.ix)}  IY  ${h16(cpu.iy)}   ${iff}  IM${cpu.im}${halt}`,
    `SP  ${h16(cpu.sp)}  PC  ${h16(cpu.pc)}   IR  ${h8(cpu.i)}${h8(cpu.r)}`,
    `T-states: ${cpu.tStates}`,
  ];
  if (is128kClass(spec.model)) {
    const mem = spec.memory;
    lines.push(`Bank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`);
  }
  return lines.join('\n');
}

/** Returns a one-line watchpoint/breakpoint hit message, or null if none. */
function checkWatchHit(spec: Spectrum): string | null {
  if (spec.portWatchHit !== null) {
    const { port, value, dir } = spec.portWatchHit;
    return `Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`;
  }
  if (spec.memWatchHit !== null) {
    const { addr, value, dir } = spec.memWatchHit;
    return `Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`;
  }
  if (spec.breakpointHit >= 0) {
    return `Breakpoint at ${h16(spec.breakpointHit)}. T=${spec.cpu.tStates}\n${formatStep(spec)}`;
  }
  return null;
}

function formatHexDump(readByte: (addr: number) => number, start: number, len: number): string {
  const lines: string[] = [];
  for (let i = 0; i < len; i += 16) {
    const addr = (start + i) & 0xFFFF;
    let hex = '';
    let ascii = '';
    for (let j = 0; j < 16 && i + j < len; j++) {
      const b = readByte((addr + j) & 0xFFFF);
      hex += h8(b) + ' ';
      ascii += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
    }
    lines.push(`${h16(addr)}  ${hex.padEnd(48)} ${ascii}`);
  }
  return lines.join('\n');
}

function doFindBytes(readByte: (addr: number) => number, needle: Uint8Array): string {
  const results: number[] = [];
  for (let i = 0; i <= 0xFFFF - needle.length + 1; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (readByte(i + j) !== needle[j]) { match = false; break; }
    }
    if (match) results.push(i);
    if (results.length >= 64) break;
  }
  if (results.length === 0) return 'Not found';
  return `Found ${results.length} match(es): ${results.map(h16).join(', ')}`;
}

async function loadFileInto(spec: Spectrum, filepath: string, diskUnit: number = 0): Promise<string> {
  if (!fs.existsSync(filepath)) return `File not found: ${filepath}`;
  const data = new Uint8Array(fs.readFileSync(filepath));
  const ext = path.extname(filepath).toLowerCase();
  const filename = path.basename(filepath);

  if (ext === '.tap') {
    spec.loadTAP(data);
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    return `TAP loaded: ${filename} (${spec.tape.blocks.length} blocks)`;
  } else if (ext === '.tzx') {
    const blocks = parseTZX(data);
    spec.tape.blocks = blocks;
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    return `TZX loaded: ${filename} (${blocks.length} blocks)`;
  } else if (ext === '.dsk') {
    const image = parseDSK(data);
    spec.loadDisk(image, diskUnit);
    const driveLetter = diskUnit === 0 ? 'A' : 'B';
    return `DSK loaded: ${filename} → Drive ${driveLetter}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`;
  } else if (ext === '.sna') {
    spec.reset();
    const result = loadSNA(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    return `SNA loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`;
  } else if (ext === '.z80') {
    spec.reset();
    const result = loadZ80(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    return `Z80 loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`;
  } else if (ext === '.szx') {
    // Auto-detect model from SZX header byte 6 (machine ID).
    // Must switch before loading so memory.is128K is set correctly and ROM pages are right.
    const SZX_ID_MODEL: Record<number, SpectrumModel> = {
      0: '48k', 1: '48k', 2: '128k', 3: '+2', 4: '+2a', 5: '+3', 6: '+3',
    };
    const szxModel: SpectrumModel = (data.length >= 7 ? SZX_ID_MODEL[data[6]] : undefined) ?? '48k';
    if (szxModel !== model) await initMachine(szxModel);
    else spec.reset();
    const result = await loadSZX(data, spec.cpu, spec.memory);
    if (result.is128K) {
      // Use direct property assignment + applyBanking() — NOT bankSwitch().
      // bankSwitch() uses slot-diffing and won't re-populate fixed slots (bank5/bank2).
      spec.memory.port7FFD    = result.port7FFD;
      spec.memory.port1FFD    = result.port1FFD;
      spec.memory.currentBank = result.port7FFD & 0x07;
      spec.memory.pagingLocked  = (result.port7FFD & 0x20) !== 0;
      spec.memory.specialPaging = (result.port1FFD & 1) !== 0;
      // +2A/+3 ROM index uses bits from both ports; others use only 7FFD bit 4
      spec.memory.currentROM = (szxModel === '+2a' || szxModel === '+3')
        ? (((result.port1FFD >> 2) & 1) << 1) | ((result.port7FFD >> 4) & 1)
        : (result.port7FFD >> 4) & 1;
      spec.memory.applyBanking();
    }
    spec.ula.borderColor = result.borderColor;
    return `SZX loaded: ${filename} (${szxModel}) PC=${h16(spec.cpu.pc)}`;
  }
  return `Unsupported file type: ${ext}`;
}

// ── Text result helper ───────────────────────────────────────────────────

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

// ── Emulator state ───────────────────────────────────────────────────────

let model: SpectrumModel;
let spec: Spectrum;
let romData: Uint8Array;

// ── FDC log ring buffer ───────────────────────────────────────────────────
const FDC_LOG_MAX = 2000;
const fdcLog: string[] = [];

function wireFdcLog(): void {
  spec.fdc.logFn = (...args: any[]) => {
    const line = args.map(a => String(a)).join(' ');
    fdcLog.push(line);
    if (fdcLog.length > FDC_LOG_MAX) fdcLog.shift();
  };
}

async function initMachine(m: SpectrumModel): Promise<string> {
  model = m;
  romData = await fetchROM(model);
  spec = new Spectrum(model);
  spec.scanlineAccuracy = 'low';
  spec.loadROM(romData);
  spec.reset();
  wireFdcLog();
  installTrapHook();
  return `Machine ready: ${model.toUpperCase()} PC=${h16(spec.cpu.pc)}`;
}

// ── MCP Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'zx84',
  version: '1.0.0',
});

// -- run --
server.tool(
  'run',
  'Run the emulator for N frames (default 1). Returns breakpoint info if hit.',
  { frames: z.number().int().positive().default(1).describe('Number of frames to run') },
  async ({ frames }) => {
    const ran = spec.runUntil(frames);
    if (spec.portWatchHit !== null) {
      const { port, value, dir } = spec.portWatchHit;
      return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
    }
    if (spec.memWatchHit !== null) {
      const { addr, value, dir } = spec.memWatchHit;
      return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
    }
    if (spec.breakpointHit >= 0) {
      return text(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran}/${frames} frame(s). T=${spec.cpu.tStates}\n${formatStep(spec)}`);
    }
    return text(`Ran ${frames} frame(s). T=${spec.cpu.tStates}`);
  },
);

// -- step_frame --
server.tool(
  'step_frame',
  'Run exactly one frame (to the next frame boundary). Equivalent to run with frames=1.',
  {},
  async () => {
    spec.tick();
    if (spec.portWatchHit !== null) {
      const { port, value, dir } = spec.portWatchHit;
      return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
    }
    if (spec.memWatchHit !== null) {
      const { addr, value, dir } = spec.memWatchHit;
      return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
    }
    if (spec.breakpointHit >= 0) {
      return text(`Breakpoint at ${h16(spec.breakpointHit)}. T=${spec.cpu.tStates}\n${formatStep(spec)}`);
    }
    return text(`Frame complete. T=${spec.cpu.tStates}`);
  },
);

// -- step --
server.tool(
  'step',
  'Single-step N Z80 instructions (default 1), showing disassembly and registers for each.',
  { count: z.number().int().positive().default(1).describe('Number of instructions to step') },
  async ({ count }) => {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(formatStep(spec));
      spec.cpu.step();
    }
    return text(lines.join('\n'));
  },
);

// -- continue --
server.tool(
  'continue',
  'Continue execution until a breakpoint is hit (max N frames, default 5000).',
  { max_frames: z.number().int().positive().default(5000).describe('Maximum frames before giving up') },
  async ({ max_frames }) => {
    if (spec.breakpoints.size === 0 && spec.portWatchpoints.size === 0 && spec.memWatchpoints.length === 0 && traps.size === 0)
      return text('No breakpoints or traps set. Use "breakpoint", "port_watchpoint", "memory_watchpoint", or "trap" first.');
    const ran = spec.runUntil(max_frames);
    if (spec.portWatchHit !== null) {
      const { port, value, dir } = spec.portWatchHit;
      return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  after ${ran} frame(s)  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
    }
    if (spec.memWatchHit !== null) {
      const { addr, value, dir } = spec.memWatchHit;
      return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  after ${ran} frame(s)  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
    }
    if (spec.breakpointHit >= 0) {
      return text(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran} frame(s). T=${spec.cpu.tStates}\n${formatStep(spec)}`);
    }
    return text(`No breakpoint hit after ${max_frames} frames (T=${spec.cpu.tStates})`);
  },
);

// -- registers --
server.tool(
  'registers',
  'Display all CPU registers, flags, interrupt state, and banking info.',
  {},
  async () => text(formatRegs(spec)),
);

// -- set_register --
server.tool(
  'set_register',
  'Set a CPU register. Supported: A F AF B C BC D E DE H L HL SP PC IX IY.',
  {
    register: z.string().describe('Register name (e.g. A, BC, HL, SP, PC, IX, IY)'),
    value: z.string().describe('Value (hex or decimal, e.g. "FF", "0x1234", "512")'),
  },
  async ({ register, value }) => {
    const reg = register.toUpperCase();
    const val = parseAddr(value);
    const cpu = spec.cpu;
    switch (reg) {
      case 'A':  cpu.a  = val & 0xFF; break;
      case 'F':  cpu.f  = val & 0xFF; break;
      case 'AF': cpu.af = val & 0xFFFF; break;
      case 'B':  cpu.b  = val & 0xFF; break;
      case 'C':  cpu.c  = val & 0xFF; break;
      case 'BC': cpu.bc = val & 0xFFFF; break;
      case 'D':  cpu.d  = val & 0xFF; break;
      case 'E':  cpu.e  = val & 0xFF; break;
      case 'DE': cpu.de = val & 0xFFFF; break;
      case 'H':  cpu.h  = val & 0xFF; break;
      case 'L':  cpu.l  = val & 0xFF; break;
      case 'HL': cpu.hl = val & 0xFFFF; break;
      case 'SP': cpu.sp = val & 0xFFFF; break;
      case 'PC': cpu.pc = val & 0xFFFF; break;
      case 'IX': cpu.ix = val & 0xFFFF; break;
      case 'IY': cpu.iy = val & 0xFFFF; break;
      default: return text(`Unknown register: ${reg}`);
    }
    return text(`${reg} = ${val <= 0xFF ? h8(val) : h16(val)}`);
  },
);

// -- disassemble --
server.tool(
  'disassemble',
  'Disassemble Z80 code at a given address (default: PC). Shows N lines (default 16).',
  {
    address: z.string().optional().describe('Start address (hex/decimal). Defaults to current PC.'),
    lines: z.number().int().positive().default(16).describe('Number of lines to disassemble'),
  },
  async ({ address, lines: n }) => {
    const addr = address ? parseAddr(address) : spec.cpu.pc;
    const snap = spec.memory.snapshot();
    const result = disassemble(snap, addr, n);
    const out: string[] = [];
    for (const l of result) {
      const bytes: string[] = [];
      for (let i = 0; i < l.length; i++) bytes.push(h8(snap[(l.addr + i) & 0xFFFF]));
      const prefix = l.addr === spec.cpu.pc ? '>' : ' ';
      out.push(`${prefix} ${h16(l.addr)}  ${bytes.join(' ').padEnd(11)}  ${stripMarkers(l.text)}`);
    }
    return text(out.join('\n'));
  },
);

// ── Memory helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a bank number to a Uint8Array view.
 * Banks are always authoritative — return the bank array directly.
 */
function resolveBankView(bank: number): Uint8Array | null {
  return spec.memory.getRamBank(bank);
}

// -- read_memory --
server.tool(
  'read_memory',
  'Hex dump of memory. Without bank: reads from the 64KB address space. With bank (0-7): reads from that 16KB RAM bank directly, address is offset within the bank.',
  {
    address: z.string().describe('Start address (hex, or offset within bank)'),
    length: z.number().int().positive().default(64).describe('Number of bytes to dump'),
    bank: z.number().int().min(0).max(7).optional().describe('RAM bank 0-7 (omit for flat 64KB address space)'),
  },
  async ({ address, length, bank }) => {
    if (bank !== undefined) {
      const view = resolveBankView(bank);
      if (!view) return text(`Bank ${bank} not available`);
      const offset = parseAddr(address) & 0x3FFF;
      const len = Math.min(length, 0x4000 - offset);
      return text(`Bank ${bank}, offset ${h16(offset)}:\n${formatHexDump(a => view[a] ?? 0xFF, offset, len)}`);
    }
    return text(formatHexDump(addr => spec.memory.readByte(addr), parseAddr(address), length));
  },
);

// -- write_memory --
server.tool(
  'write_memory',
  'Write a hex byte sequence to memory. Without bank: writes to the 64KB address space. With bank (0-7): writes to that 16KB RAM bank directly, address is offset within the bank.',
  {
    address: z.string().describe('Start address (hex, or offset within bank)'),
    hex_bytes: z.string().describe('Hex byte string to write, e.g. "CD0050FF"'),
    bank: z.number().int().min(0).max(7).optional().describe('RAM bank 0-7 (omit for flat 64KB address space)'),
  },
  async ({ address, hex_bytes, bank }) => {
    const hex = hex_bytes.replace(/\s/g, '');
    if (hex.length % 2 !== 0) return text('Hex string must have even length');
    const count = hex.length / 2;
    if (bank !== undefined) {
      const view = resolveBankView(bank);
      if (!view) return text(`Bank ${bank} not available`);
      const offset = parseAddr(address) & 0x3FFF;
      for (let i = 0; i < count; i++) {
        const val = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        if (isNaN(val)) return text(`Invalid hex at position ${i * 2}: "${hex.slice(i * 2, i * 2 + 2)}"`);
        view[(offset + i) & 0x3FFF] = val;
      }
      return text(`Wrote ${count} byte${count !== 1 ? 's' : ''} to bank ${bank} at ${h16(offset)}..${h16((offset + count - 1) & 0x3FFF)}`);
    }
    const addr = parseAddr(address) & 0xFFFF;
    for (let i = 0; i < count; i++) {
      const val = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (isNaN(val)) return text(`Invalid hex at position ${i * 2}: "${hex.slice(i * 2, i * 2 + 2)}"`);
      spec.memory.writeByte((addr + i) & 0xFFFF, val);
    }
    return text(`Wrote ${count} byte${count !== 1 ? 's' : ''} at ${h16(addr)}..${h16((addr + count - 1) & 0xFFFF)}`);
  },
);

// -- find --
server.tool(
  'find',
  'Search all 64KB of memory for a byte sequence. Returns up to 64 matches.',
  { hex_bytes: z.string().describe('Hex byte string to search for, e.g. "CD0050"') },
  async ({ hex_bytes }) => {
    const hex = hex_bytes.replace(/\s/g, '');
    if (hex.length % 2 !== 0) return text('Hex string must have even length');
    const needle = new Uint8Array(hex.length / 2);
    for (let i = 0; i < needle.length; i++) needle[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return text(doFindBytes(addr => spec.memory.readByte(addr), needle));
  },
);

// -- breakpoint --
server.tool(
  'breakpoint',
  'Set breakpoints at one or more addresses, or list all breakpoints if none given. Accepts a single address or comma/space-separated list.',
  { address: z.string().optional().describe('Address(es) to set breakpoints at, e.g. "FE10" or "FE10,FE20,FE30" (omit to list all)') },
  async ({ address }) => {
    if (!address) {
      if (spec.breakpoints.size === 0) return text('No breakpoints');
      return text('Breakpoints: ' + [...spec.breakpoints].map(h16).join(', '));
    }
    const addrs = address.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s));
    for (const a of addrs) spec.breakpoints.add(a);
    return text(`Breakpoint${addrs.length > 1 ? 's' : ''} set at ${addrs.map(h16).join(', ')}`);
  },
);

// -- delete_breakpoint --
server.tool(
  'delete_breakpoint',
  'Delete breakpoints at one or more addresses, or clear all if none given. Accepts a single address or comma/space-separated list.',
  { address: z.string().optional().describe('Address(es) to remove, e.g. "FE10" or "FE10,FE20" (omit to clear all)') },
  async ({ address }) => {
    if (!address) {
      spec.breakpoints.clear();
      return text('All breakpoints cleared');
    }
    const addrs = address.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s));
    for (const a of addrs) spec.breakpoints.delete(a);
    return text(`Breakpoint${addrs.length > 1 ? 's' : ''} at ${addrs.map(h16).join(', ')} removed`);
  },
);

// -- port_watchpoint --
server.tool(
  'port_watchpoint',
  'Set port watchpoints (breaks on IN or OUT). Accepts a single port or comma/space-separated list. Omit to list all.',
  { port: z.string().optional().describe('Port address(es) to watch, e.g. "3FFD" or "3FFD,2FFD" (omit to list all)') },
  async ({ port }) => {
    if (!port) {
      if (spec.portWatchpoints.size === 0) return text('No port watchpoints');
      return text('Port watchpoints: ' + [...spec.portWatchpoints].map(h16).join(', '));
    }
    const ports = port.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s) & 0xFFFF);
    for (const p of ports) spec.portWatchpoints.add(p);
    return text(`Port watchpoint${ports.length > 1 ? 's' : ''} set at ${ports.map(h16).join(', ')}`);
  },
);

// -- delete_port_watchpoint --
server.tool(
  'delete_port_watchpoint',
  'Delete port watchpoints. Accepts a single port or comma/space-separated list. Omit to clear all.',
  { port: z.string().optional().describe('Port address(es) to remove, e.g. "3FFD" or "3FFD,2FFD" (omit to clear all)') },
  async ({ port }) => {
    if (!port) {
      spec.portWatchpoints.clear();
      return text('All port watchpoints cleared');
    }
    const ports = port.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s) & 0xFFFF);
    for (const p of ports) spec.portWatchpoints.delete(p);
    return text(`Port watchpoint${ports.length > 1 ? 's' : ''} at ${ports.map(h16).join(', ')} removed`);
  },
);

// -- memory_watchpoint --
server.tool(
  'memory_watchpoint',
  'Set a memory watchpoint that breaks on read, write, or either. Omit address to list all.',
  {
    address: z.string().optional().describe('Start address (hex, e.g. "4000"). Omit to list all watchpoints.'),
    length:  z.number().int().positive().default(1).describe('Number of bytes to watch (default 1)'),
    mode:    z.enum(['read', 'write', 'rw']).default('rw').describe('Access type to watch: read, write, or rw (default rw)'),
  },
  async ({ address, length, mode }) => {
    if (!address) {
      if (spec.memWatchpoints.length === 0) return text('No memory watchpoints');
      const lines = spec.memWatchpoints.map(wp =>
        wp.start === wp.end ? `${h16(wp.start)} ${wp.mode}` : `${h16(wp.start)}-${h16(wp.end)} ${wp.mode}`
      );
      return text('Memory watchpoints:\n' + lines.join('\n'));
    }
    const start = parseAddr(address) & 0xFFFF;
    const end = (start + length - 1) & 0xFFFF;
    spec.memWatchpoints.push({ start, end, mode });
    const range = start === end ? h16(start) : `${h16(start)}-${h16(end)}`;
    return text(`Memory watchpoint set: ${range} (${mode})`);
  },
);

// -- delete_memory_watchpoint --
server.tool(
  'delete_memory_watchpoint',
  'Delete a memory watchpoint by start address, or omit to clear all.',
  { address: z.string().optional().describe('Start address of watchpoint to remove (omit to clear all)') },
  async ({ address }) => {
    if (!address) {
      spec.memWatchpoints.length = 0;
      return text('All memory watchpoints cleared');
    }
    const start = parseAddr(address) & 0xFFFF;
    const before = spec.memWatchpoints.length;
    spec.memWatchpoints = spec.memWatchpoints.filter(wp => wp.start !== start);
    const removed = before - spec.memWatchpoints.length;
    return removed > 0
      ? text(`Memory watchpoint at ${h16(start)} removed`)
      : text(`No memory watchpoint found at ${h16(start)}`);
  },
);

// ── Trap system ──────────────────────────────────────────────────────────────
//
// Traps are pre-configured hooks that fire when PC hits a specific address.
// Three modes:
//   log     — record the call (registers, decoded info) to a buffer, continue
//   break   — halt execution (like a breakpoint) so the MCP client can inspect
//   respond — stuff registers from a pre-loaded response queue and RET, skip
//             the real code entirely.  Responses are consumed in FIFO order;
//             when the queue is empty the trap reverts to "break".

interface TrapResponse {
  /** Register values to set before RETurning.  Only listed regs are changed. */
  regs: Record<string, number>;
}

interface Trap {
  address: number;
  action: 'log' | 'break' | 'respond';
  /** Optional: only fire when C register equals this value (for BDOS function filtering) */
  condC?: number;
  /** Label shown in log output */
  label: string;
  /** Pre-queued responses for 'respond' mode */
  responses: TrapResponse[];
}

const traps = new Map<number, Trap[]>();   // address → traps at that address
const trapLog: string[] = [];

/** Read a '$'-terminated CP/M string from memory starting at addr. */
function readCpmString(addr: number, maxLen = 256): string {
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const ch = spec.memory.readByte((addr + i) & 0xFFFF);
    if (ch === 0x24) break; // '$'
    s += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : '.';
  }
  return s;
}

/** Format a trap log entry with registers and optional CP/M decoding. */
function formatTrapLog(trap: Trap): string {
  const cpu = spec.cpu;
  let line = `[${h16(cpu.pc)}] ${trap.label}  C=${h8(cpu.c)} DE=${h16(cpu.de)} A=${h8(cpu.a)} T=${cpu.tStates}`;
  // Auto-decode common BDOS calls
  if (trap.address === 0x0005) {
    const fn = cpu.c;
    if (fn === 2) line += `  CON_OUT char='${String.fromCharCode(cpu.e)}'`;
    else if (fn === 9) line += `  PRINT_STR "${readCpmString(cpu.de)}"`;
    else if (fn === 1) line += '  CON_IN';
    else if (fn === 10) line += `  READ_LINE buf=${h16(cpu.de)}`;
    else if (fn === 12) line += '  GET_VERSION';
    else if (fn === 15) line += `  OPEN fcb=${h16(cpu.de)}`;
    else if (fn === 16) line += `  CLOSE fcb=${h16(cpu.de)}`;
    else if (fn === 17) line += `  SEARCH_FIRST fcb=${h16(cpu.de)}`;
    else if (fn === 18) line += '  SEARCH_NEXT';
    else if (fn === 19) line += `  DELETE fcb=${h16(cpu.de)}`;
    else if (fn === 20) line += `  READ_SEQ fcb=${h16(cpu.de)}`;
    else if (fn === 21) line += `  WRITE_SEQ fcb=${h16(cpu.de)}`;
    else if (fn === 22) line += `  CREATE fcb=${h16(cpu.de)}`;
    else if (fn === 26) line += `  SET_DMA addr=${h16(cpu.de)}`;
    else if (fn === 33) line += `  READ_RND fcb=${h16(cpu.de)}`;
    else if (fn === 34) line += `  WRITE_RND fcb=${h16(cpu.de)}`;
    else if (fn === 35) line += `  FILE_SIZE fcb=${h16(cpu.de)}`;
    else if (fn === 36) line += `  SET_RND fcb=${h16(cpu.de)}`;
  }
  return line;
}

/** Execute a RET: pop PC from stack. */
function execRET(): void {
  const cpu = spec.cpu;
  const lo = spec.memory.readByte(cpu.sp & 0xFFFF);
  const hi = spec.memory.readByte((cpu.sp + 1) & 0xFFFF);
  cpu.sp = (cpu.sp + 2) & 0xFFFF;
  cpu.pc = (hi << 8) | lo;
}

/** Install the onTrap callback. Called once at startup and after model switches. */
function installTrapHook(): void {
  spec.onTrap = (pc: number): boolean => {
    const list = traps.get(pc);
    if (!list) return false;
    for (const trap of list) {
      // Check optional condition
      if (trap.condC !== undefined && spec.cpu.c !== trap.condC) continue;

      if (trap.action === 'log') {
        trapLog.push(formatTrapLog(trap));
        return false; // continue execution
      }
      if (trap.action === 'break') {
        trapLog.push(formatTrapLog(trap) + '  [BREAK]');
        return true; // halt execution
      }
      if (trap.action === 'respond') {
        const resp = trap.responses.shift();
        if (!resp) {
          // Queue exhausted — break so the client can decide
          trapLog.push(formatTrapLog(trap) + '  [RESPOND queue empty — BREAK]');
          return true;
        }
        trapLog.push(formatTrapLog(trap) + `  [RESPOND ${JSON.stringify(resp.regs)}]`);
        // Apply register values
        const cpu = spec.cpu;
        for (const [reg, val] of Object.entries(resp.regs)) {
          switch (reg.toUpperCase()) {
            case 'A':  cpu.a  = val & 0xFF; break;
            case 'F':  cpu.f  = val & 0xFF; break;
            case 'B':  cpu.b  = val & 0xFF; break;
            case 'C':  cpu.c  = val & 0xFF; break;
            case 'D':  cpu.d  = val & 0xFF; break;
            case 'E':  cpu.e  = val & 0xFF; break;
            case 'H':  cpu.h  = val & 0xFF; break;
            case 'L':  cpu.l  = val & 0xFF; break;
            case 'BC': cpu.bc = val & 0xFFFF; break;
            case 'DE': cpu.de = val & 0xFFFF; break;
            case 'HL': cpu.hl = val & 0xFFFF; break;
          }
        }
        execRET();
        return false; // continue execution after the synthetic return
      }
    }
    return false;
  };
}

// -- trap --
server.tool(
  'trap',
  'Set a trap at an address. Actions: "log" (record and continue), "break" (halt execution), "respond" (stuff registers and RET). Omit address to list all traps.',
  {
    address: z.string().optional().describe('Address to trap (omit to list all)'),
    action: z.enum(['log', 'break', 'respond']).default('log').describe('What to do when the trap fires'),
    cond_c: z.number().int().min(0).max(255).optional().describe('Only fire when C register equals this value (e.g. BDOS function number)'),
    label: z.string().default('').describe('Label for log output (e.g. "BDOS", "BIOS_CONOUT")'),
    responses: z.array(z.record(z.string(), z.number())).optional().describe('For respond mode: array of {reg: value} objects consumed in FIFO order'),
  },
  async ({ address, action, cond_c, label, responses }) => {
    if (!address) {
      // List all traps
      if (traps.size === 0) return text('No traps set');
      const lines: string[] = [];
      for (const [addr, list] of traps) {
        for (const t of list) {
          let desc = `${h16(addr)}  ${t.action}`;
          if (t.condC !== undefined) desc += `  C==${h8(t.condC)}`;
          if (t.label) desc += `  "${t.label}"`;
          if (t.action === 'respond') desc += `  queue=${t.responses.length}`;
          lines.push(desc);
        }
      }
      return text(lines.join('\n'));
    }
    const addr = parseAddr(address) & 0xFFFF;
    const trap: Trap = {
      address: addr,
      action,
      condC: cond_c,
      label: label || `trap@${h16(addr)}`,
      responses: (responses ?? []).map(r => ({ regs: r })),
    };
    if (!traps.has(addr)) traps.set(addr, []);
    traps.get(addr)!.push(trap);
    let msg = `Trap set at ${h16(addr)}: ${action}`;
    if (cond_c !== undefined) msg += ` when C==${h8(cond_c)}`;
    if (trap.responses.length > 0) msg += `, ${trap.responses.length} response(s) queued`;
    return text(msg);
  },
);

// -- trap_delete --
server.tool(
  'trap_delete',
  'Delete traps. If address given, removes all traps at that address. If cond_c also given, only removes matching traps. Omit address to clear all.',
  {
    address: z.string().optional().describe('Address to remove traps from (omit to clear all)'),
    cond_c: z.number().int().min(0).max(255).optional().describe('Only remove traps with this C condition'),
  },
  async ({ address, cond_c }) => {
    if (!address) {
      const count = [...traps.values()].reduce((s, l) => s + l.length, 0);
      traps.clear();
      return text(`Cleared all ${count} trap(s)`);
    }
    const addr = parseAddr(address) & 0xFFFF;
    const list = traps.get(addr);
    if (!list || list.length === 0) return text(`No traps at ${h16(addr)}`);
    if (cond_c !== undefined) {
      const before = list.length;
      const filtered = list.filter(t => t.condC !== cond_c);
      traps.set(addr, filtered);
      if (filtered.length === 0) traps.delete(addr);
      return text(`Removed ${before - filtered.length} trap(s) at ${h16(addr)} with C==${h8(cond_c)}`);
    }
    traps.delete(addr);
    return text(`Removed ${list.length} trap(s) at ${h16(addr)}`);
  },
);

// -- trap_log --
server.tool(
  'trap_log',
  'Read the trap log buffer. Returns total line count and requested range.',
  {
    from: z.number().int().min(0).default(0).describe('Start line (0-based, inclusive)'),
    to: z.number().int().min(0).optional().describe('End line (exclusive, default: from+100)'),
    clear: z.boolean().default(false).describe('Clear the log after reading'),
  },
  async ({ from, to, clear }) => {
    if (trapLog.length === 0) return text('Trap log is empty');
    const end = Math.min(to ?? from + 100, trapLog.length);
    const start = Math.min(from, trapLog.length);
    const chunk = trapLog.slice(start, end);
    const result = `Trap log: ${trapLog.length} total lines. Showing ${start}..${end - 1}:\n\n${chunk.join('\n')}`;
    if (clear) trapLog.length = 0;
    return text(result);
  },
);

// -- trap_respond --
server.tool(
  'trap_respond',
  'Queue additional responses for an existing respond-mode trap.',
  {
    address: z.string().describe('Trap address'),
    cond_c: z.number().int().min(0).max(255).optional().describe('Match trap with this C condition'),
    responses: z.array(z.record(z.string(), z.number())).describe('Array of {reg: value} response objects to append to the queue'),
  },
  async ({ address, cond_c, responses }) => {
    const addr = parseAddr(address) & 0xFFFF;
    const list = traps.get(addr);
    if (!list) return text(`No traps at ${h16(addr)}`);
    const match = list.find(t => t.action === 'respond' && (cond_c === undefined || t.condC === cond_c));
    if (!match) return text(`No respond-mode trap at ${h16(addr)}${cond_c !== undefined ? ` with C==${h8(cond_c)}` : ''}`);
    for (const r of responses) match.responses.push({ regs: r });
    return text(`Queued ${responses.length} response(s) at ${h16(addr)}. Total queue: ${match.responses.length}`);
  },
);

// -- fdc_log --
server.tool(
  'fdc_log',
  'Read (and optionally clear) the FDC log ring buffer. Returns up to the last 2000 FDC log lines.',
  { clear: z.boolean().default(false).describe('Clear the buffer after reading') },
  async ({ clear }) => {
    const lines = [...fdcLog];
    if (clear) fdcLog.length = 0;
    if (lines.length === 0) return text('FDC log is empty');
    return text(`${lines.length} FDC log line(s):\n\n${lines.join('\n')}`);
  },
);

// -- port_out --
server.tool(
  'port_out',
  'Write a byte to an I/O port (triggers port handler for banking etc.).',
  {
    port: z.string().describe('Port address (hex/decimal)'),
    value: z.string().describe('Byte value'),
  },
  async ({ port, value }) => {
    const p = parseAddr(port) & 0xFFFF;
    const v = parseAddr(value) & 0xFF;
    spec.cpu.portOutHandler!(p, v);
    let result = `OUT ${h16(p)}, ${h8(v)}`;
    if (is128kClass(spec.model)) {
      const mem = spec.memory;
      result += `\nBank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`;
    }
    return text(result);
  },
);

// -- port_in --
server.tool(
  'port_in',
  'Read a byte from an I/O port.',
  { port: z.string().describe('Port address (hex/decimal)') },
  async ({ port }) => {
    const p = parseAddr(port) & 0xFFFF;
    const val = spec.cpu.portInHandler!(p);
    return text(`IN ${h16(p)} = ${h8(val)} (${val})`);
  },
);

// -- load --
server.tool(
  'load',
  'Load a file into the emulator. Supports TAP, TZX, SNA, Z80, DSK formats. For DSK, optional drive unit (0/A or 1/B).',
  {
    file: z.string().describe('Path to file (TAP/TZX/SNA/Z80/DSK)'),
    drive: z.enum(['0', '1', 'A', 'B']).default('0').describe('Drive unit for DSK files'),
  },
  async ({ file, drive }) => {
    const diskUnit = (drive === '1' || drive === 'B') ? 1 : 0;
    return text(await loadFileInto(spec, file, diskUnit));
  },
);

// -- save --
server.tool(
  'save',
  'Save current emulator state to a SZX snapshot file.',
  { file: z.string().describe('Output path for .szx file') },
  async ({ file }) => {
    if (!file.toLowerCase().endsWith('.szx')) file = file + '.szx';
    const ayRegs = spec.ay ? new Uint8Array(16).map((_, i) => spec.ay.readRegister(i)) : undefined;
    const ayCurrentReg = spec.ay?.selectedReg;
    const szxData = await saveSZX(
      spec.cpu,
      spec.memory,
      spec.ula.borderColor,
      model,
      spec.contention.frameStartTStates,
      ayRegs,
      ayCurrentReg,
    );
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, szxData);
    return text(`Saved ${szxData.length} bytes → ${file}\nPC=${h16(spec.cpu.pc)}  Model=${model}  Bank=${spec.memory.currentBank}  ROM=${spec.memory.currentROM}`);
  },
);

// -- disk_boot --
server.tool(
  'disk_boot',
  'Boot from disk in drive A: on a +3. Runs 500 frames to reach the menu, then presses Enter on "Loader". If a file path is given, switches to +3, mounts the DSK, and boots it.',
  { file: z.string().optional().describe('Path to DSK file to load into drive A: (optional — omit if disk already mounted)') },
  async ({ file }) => {
    const lines: string[] = [];
    if (file) {
      // Switch to +3 if needed, mount disk, then boot
      if (model !== '+3') {
        lines.push(await initMachine('+3'));
      } else {
        spec.reset();
        lines.push('Machine reset (+3)');
      }
      const loadResult = await loadFileInto(spec, file, 0);
      lines.push(loadResult);
      if (loadResult.startsWith('File not found') || loadResult.startsWith('Unsupported')) {
        return text(lines.join('\n'));
      }
    } else {
      if (spec.model !== '+3') return text('disk_boot requires +3 model. Use model tool to switch, or pass a file path.');
      if (!spec.fdc.getDiskImage(0)) return text('No disk in drive A:. Use load tool first, or pass a file path.');
    }
    spec.runUntil(500);
    spec.keyboard.handleKeyEvent('Enter', true);
    for (let i = 0; i < 5; i++) spec.tick();
    spec.keyboard.handleKeyEvent('Enter', false);
    spec.tick();
    lines.push('DOS BOOT initiated via Loader menu.');
    lines.push('Bootstrap loads to FE00h, enters at FE10h.');
    lines.push('Suggested: breakpoint FE10 → continue');
    return text(lines.join('\n'));
  },
);

// -- disk_trace --
server.tool(
  'disk_trace',
  'Copy-protection trace helper: switch to +3, mount a DSK, boot to Loader, then arm a FE10h PC breakpoint and a 3FFDh FDC data port watchpoint so every FDC command byte breaks execution.',
  { file: z.string().describe('Path to DSK file to load into drive A:') },
  async ({ file }) => {
    const lines: string[] = [];
    // Ensure we're on a +3
    if (model !== '+3') {
      lines.push(await initMachine('+3'));
    } else {
      spec.reset();
      lines.push('Machine reset (+3)');
    }
    // Load the disk image
    const loadResult = await loadFileInto(spec, file, 0);
    lines.push(loadResult);
    if (loadResult.startsWith('File not found') || loadResult.startsWith('Unsupported')) {
      return text(lines.join('\n'));
    }
    // Boot: run 500 frames to reach the +3 menu, then press Enter on "Loader"
    spec.runUntil(500);
    spec.keyboard.handleKeyEvent('Enter', true);
    for (let i = 0; i < 5; i++) spec.tick();
    spec.keyboard.handleKeyEvent('Enter', false);
    spec.tick();
    lines.push('Booted to Loader. Bootstrap now loading from disk...');
    // Arm PC breakpoint at FE10h (bootstrap entry point)
    spec.breakpoints.clear();
    spec.breakpoints.add(0xFE10);
    lines.push('Breakpoint: FE10h (bootstrap entry)');
    // Arm FDC data port watchpoint — every command/data byte written to 0x3FFD breaks
    spec.portWatchpoints.clear();
    spec.portWatchpoints.add(0x3FFD);
    lines.push('Port watchpoint: 3FFDh (FDC data port — every IN/OUT breaks)');
    lines.push('');
    lines.push('Use "continue" to run until the next FDC access or FE10h.');
    lines.push('At each break: "registers" + "disassemble" to document the command.');
    lines.push('Clear port watchpoint with "delete_port_watchpoint 3FFD" once past the FDC setup.');
    return text(lines.join('\n'));
  },
);

// -- eject --
server.tool(
  'eject',
  'Eject a disk or tape.',
  {
    target: z.enum(['tape', 'disk']).describe('What to eject'),
    drive: z.enum(['0', '1', 'A', 'B']).default('0').describe('Drive unit (for disk only)'),
  },
  async ({ target, drive }) => {
    if (target === 'tape') {
      spec.tape.load(new Uint8Array(0));
      return text('Tape ejected');
    }
    const unit = (drive === '1' || drive === 'B') ? 1 : 0;
    spec.fdc.ejectDisk(unit);
    return text(`Drive ${unit === 0 ? 'A' : 'B'}: ejected`);
  },
);

// -- key --
server.tool(
  'key',
  'Press a key for N frames (default 5). Keys: a-z, 0-9, enter, space, shift, sym, backspace, arrows, capslock, escape.',
  {
    name: z.string().describe('Key name (e.g. "enter", "a", "shift")'),
    frames: z.number().int().positive().default(5).describe('How many frames to hold the key'),
  },
  async ({ name, frames }) => {
    // Support combos like "sym+p", "shift+2"
    const parts = name.toLowerCase().split('+');
    const codes: string[] = [];
    for (const p of parts) {
      const code = KEY_NAME_MAP[p.trim()];
      if (!code) return text(`Unknown key: ${p.trim()}. Available: ${Object.keys(KEY_NAME_MAP).join(', ')}`);
      codes.push(code);
    }
    for (const c of codes) spec.keyboard.handleKeyEvent(c, true);
    for (let i = 0; i < frames; i++) spec.tick();
    for (const c of codes) spec.keyboard.handleKeyEvent(c, false);
    spec.tick();
    return text(`Key '${name}' held for ${frames} frames`);
  },
);

// -- type --
// Spectrum keyboard mapping for printable characters
const CHAR_KEYS: Record<string, string[]> = {
  '"': ['sym', 'p'], ':': ['sym', 'z'], ';': ['sym', 'o'],
  ',': ['sym', 'n'], '.': ['sym', 'm'], '!': ['sym', '1'],
  '@': ['sym', '2'], '#': ['sym', '3'], '$': ['sym', '4'],
  '%': ['sym', '5'], '&': ['sym', '6'], "'": ['sym', '7'],
  '(': ['sym', '8'], ')': ['sym', '9'], '_': ['sym', '0'],
  '<': ['sym', 'r'], '>': ['sym', 't'], '-': ['sym', 'j'],
  '+': ['sym', 'k'], '=': ['sym', 'l'], '*': ['sym', 'b'],
  '/': ['sym', 'v'], '?': ['sym', 'c'], '^': ['sym', 'h'],
  '~': ['sym', 'a'], '|': ['sym', 's'], '\\': ['sym', 'd'],
  '{': ['sym', 'f'], '}': ['sym', 'g'],
  '[': ['shift', 'sym', 'y'], ']': ['shift', 'sym', 'u'],  // extended mode
  '\n': ['enter'],
};
server.tool(
  'type',
  'Type a string of characters, pressing each key for a few frames. Handles letters, digits, symbols. Use backtick-delimited names for control keys: `enter`, `backspace`, `left`, `right`, `up`, `down`, `escape`, `space`, `shift`, `sym`, `capslock`.',
  { text: z.string().describe('Text to type, e.g. "LOAD \\"\\"`enter`" or "10 PRINT `shift`2`enter`"') },
  async ({ text: str }) => {
    // Parse the string, extracting `name` escape sequences for control keys
    const tokens: string[][] = [];
    let i = 0;
    while (i < str.length) {
      if (str[i] === '`') {
        const end = str.indexOf('`', i + 1);
        if (end === -1) { i++; continue; } // unmatched backtick — skip
        const name = str.slice(i + 1, end).toLowerCase();
        if (KEY_NAME_MAP[name]) {
          tokens.push([name]);
        } // else skip unknown name silently
        i = end + 1;
      } else {
        const ch = str[i];
        const lower = ch.toLowerCase();
        if (CHAR_KEYS[ch]) {
          tokens.push(CHAR_KEYS[ch]);
        } else if (KEY_NAME_MAP[lower]) {
          tokens.push(ch >= 'A' && ch <= 'Z' ? ['shift', lower] : [lower]);
        } else if (ch === ' ') {
          tokens.push(['space']);
        }
        // else skip unknown chars
        i++;
      }
    }
    let hit: string | null = null;
    typeLoop: for (const keys of tokens) {
      const codes = keys.map(k => KEY_NAME_MAP[k]);
      for (const c of codes) spec.keyboard.handleKeyEvent(c, true);
      for (let f = 0; f < 5; f++) {
        spec.tick();
        hit = checkWatchHit(spec);
        if (hit) { for (const c of codes) spec.keyboard.handleKeyEvent(c, false); break typeLoop; }
      }
      for (const c of codes) spec.keyboard.handleKeyEvent(c, false);
      spec.tick();
      hit = checkWatchHit(spec);
      if (hit) break;
      // small gap between keypresses
      for (let f = 0; f < 3; f++) {
        spec.tick();
        hit = checkWatchHit(spec);
        if (hit) break typeLoop;
      }
    }
    if (hit) return text(`Typed ${tokens.length} keystrokes, then hit:\n${hit}`);
    return text(`Typed ${tokens.length} keystrokes`);
  },
);

// -- trace --
/** Stored ZXTL trace lines, kept in memory for chunked reading via trace_read. */
let zxtlBuffer: string[] = [];

server.tool(
  'trace',
  'Start a trace. Modes: "full" (all instructions), "portio" (port I/O), "zxtl" (ZXTL V0001 standardised format with full register dumps, stored in-memory — use stop_trace then trace_read to retrieve chunks).',
  { mode: z.enum(['full', 'portio', 'zxtl']).default('full') },
  async ({ mode }) => {
    if (mode === 'zxtl') zxtlBuffer = [];
    spec.startTrace(mode);
    return text(`Trace started (${mode} mode)`);
  },
);

// -- stop_trace --
server.tool(
  'stop_trace',
  'Stop the current trace and return the results. Full/portio: large traces written to file. ZXTL: stored in-memory — returns line count, use trace_read to fetch chunks.',
  {},
  async () => {
    if (!spec.tracing) return text('Not tracing');
    const mode = spec.traceMode;
    if (mode === 'zxtl') {
      // Snapshot the buffer before stopTrace clears internal state
      zxtlBuffer = [...spec.traceBuffer];
      spec.stopTrace();
      return text(`ZXTL trace stopped: ${zxtlBuffer.length} lines stored in memory.\nUse trace_read to retrieve chunks by line range.`);
    }
    const traceText = spec.stopTrace();
    const lines = traceText.split('\n');
    if (lines.length <= 200) return text(traceText);
    const outPath = path.join(import.meta.dirname!, `trace-${Date.now()}.txt`);
    fs.writeFileSync(outPath, traceText);
    return text(`Trace: ${lines.length} lines written to ${outPath}`);
  },
);

// -- trace_read --
server.tool(
  'trace_read',
  'Read lines from the stored ZXTL trace buffer. Returns total line count plus the requested range.',
  {
    from: z.number().int().min(0).default(0).describe('Start line (0-based, inclusive)'),
    to: z.number().int().min(0).optional().describe('End line (exclusive, default: from+100)'),
  },
  async ({ from, to }) => {
    if (zxtlBuffer.length === 0) return text('No ZXTL trace in memory. Run a trace with mode "zxtl", then stop_trace.');
    const end = Math.min(to ?? from + 100, zxtlBuffer.length);
    const start = Math.min(from, zxtlBuffer.length);
    const chunk = zxtlBuffer.slice(start, end);
    return text(`ZXTL trace: ${zxtlBuffer.length} total lines. Showing ${start}..${end - 1}:\n\n${chunk.join('\n')}`);
  },
);

// -- frame_trace --
server.tool(
  'frame_trace',
  'Run one frame, logging per-instruction: T-state, beam line/col, contention delays, border changes, and VRAM writes. Writes to file.',
  {},
  async () => {
    const timing = spec.contention.timing;
    const tpl = timing.tStatesPerLine;
    const frameStart = spec.contention.frameStartTStates;
    const contentionStart = timing.contentionStart;

    const lines: string[] = [];
    let instrCount = 0;
    const maxInstrs = 200_000;

    // Save original hooks
    const origRead8 = spec.cpu.read8.bind(spec.cpu);
    const origWrite8 = spec.cpu.write8.bind(spec.cpu);
    const origContend = spec.cpu.contend.bind(spec.cpu);
    const origPortIn = spec.cpu.portIn.bind(spec.cpu);
    const origPortOut = spec.cpu.portOut.bind(spec.cpu);

    // Per-instruction accumulator
    let instrContentionTotal = 0;
    let instrVramWrites: string[] = [];
    let instrPortOps: string[] = [];

    // Wrap contend to track delays
    const realContend = spec.cpu.contend;
    spec.cpu.contend = (addr: number) => {
      const before = spec.cpu.tStates;
      realContend(addr);
      const delay = spec.cpu.tStates - before;
      if (delay > 0) instrContentionTotal += delay;
    };

    // Wrap read8 to track contention on reads
    const realRead8 = spec.cpu.read8;
    spec.cpu.read8 = (addr: number) => {
      const before = spec.cpu.tStates;
      const val = realRead8(addr);
      const delay = spec.cpu.tStates - before;
      if (delay > 0) instrContentionTotal += delay;
      return val;
    };

    // Wrap write8 to track contention + VRAM writes
    const realWrite8 = spec.cpu.write8;
    spec.cpu.write8 = (addr: number, val: number) => {
      const before = spec.cpu.tStates;
      realWrite8(addr, val);
      const delay = spec.cpu.tStates - before;
      if (delay > 0) instrContentionTotal += delay;
      if (addr >= 0x4000 && addr < 0x5B00) {
        instrVramWrites.push(`${h16(addr)}=${h8(val)}`);
      }
    };

    // Wrap portIn/portOut
    const realPortIn = spec.cpu.portIn;
    spec.cpu.portIn = (port: number) => {
      const before = spec.cpu.tStates;
      const val = realPortIn(port);
      const delay = spec.cpu.tStates - before;
      if (delay > 0) instrContentionTotal += delay;
      instrPortOps.push(`IN(${h16(port)})=${h8(val)}`);
      return val;
    };

    const realPortOut = spec.cpu.portOut;
    spec.cpu.portOut = (port: number, val: number) => {
      const before = spec.cpu.tStates;
      realPortOut(port, val);
      const delay = spec.cpu.tStates - before;
      if (delay > 0) instrContentionTotal += delay;
      instrPortOps.push(`OUT(${h16(port)},${h8(val)})`);
    };

    // Hook into step to capture per-instruction data
    const origPostStep = spec.cpu.postStepHook;
    spec.cpu.postStepHook = null; // we'll call it ourselves

    // Header
    lines.push('fT      line col  PC   instr                    Ts  cont  notes');
    lines.push('------  ---- ---  ----  ----------------------  --  ----  -----');

    // Run one frame
    // Sync frame boundary to current CPU time
    const tpf = timing.tStatesPerFrame;
    spec.contention.frameStartTStates = spec.cpu.tStates;
    const fStart = spec.contention.frameStartTStates;
    const frameEnd = fStart + tpf;

    spec.cpu.interrupt();

    while (spec.cpu.tStates < frameEnd && instrCount < maxInstrs) {
      const pc = spec.cpu.pc;
      const tBefore = spec.cpu.tStates;
      const fT = tBefore - fStart;
      const offset = fT - contentionStart;
      let beamLine = -1, beamCol = -1;
      if (offset >= 0) {
        beamLine = (offset / tpl) | 0;
        beamCol = offset - beamLine * tpl;
      }

      // Disassemble current instruction
      const buf = new Uint8Array(8);
      for (let i = 0; i < 8; i++) buf[i] = spec.memory.readByte((pc + i) & 0xFFFF);
      const { text: mnem } = disasmOne(buf, 0);

      // Reset accumulators
      instrContentionTotal = 0;
      instrVramWrites = [];
      instrPortOps = [];

      // Execute
      if (spec.cpu.halted) {
        spec.cpu.read8(spec.cpu.pc);
        spec.cpu.tStates += 3;
        spec.cpu.contend(spec.cpu.ir);
        spec.cpu.tStates += 1;
        spec.cpu.r = (spec.cpu.r & 0x80) | ((spec.cpu.r + 1) & 0x7F);
      } else {
        spec.cpu.step();
      }

      const elapsed = spec.cpu.tStates - tBefore;

      // Format line
      const notes: string[] = [];
      if (instrVramWrites.length > 0) notes.push('VRAM:' + instrVramWrites.join(','));
      if (instrPortOps.length > 0) notes.push(instrPortOps.join(' '));

      const fTStr = String(fT).padStart(6);
      const lineStr = beamLine >= 0 ? String(beamLine).padStart(4) : '   -';
      const colStr = beamCol >= 0 ? String(beamCol).padStart(3) : '  -';
      const pcStr = h16(pc);
      const mnStr = stripMarkers(mnem).padEnd(24);
      const tsStr = String(elapsed).padStart(2);
      const contStr = instrContentionTotal > 0 ? String(instrContentionTotal).padStart(4) : '   -';
      const noteStr = notes.length > 0 ? notes.join(' ') : '';

      lines.push(`${fTStr}  ${lineStr} ${colStr}  ${pcStr}  ${mnStr}${tsStr}  ${contStr}  ${noteStr}`);
      instrCount++;
    }

    // Restore hooks
    spec.cpu.read8 = origRead8;
    spec.cpu.write8 = origWrite8;
    spec.cpu.contend = origContend;
    spec.cpu.portIn = origPortIn;
    spec.cpu.portOut = origPortOut;
    spec.cpu.postStepHook = origPostStep;

    lines.push(`\n--- ${instrCount} instructions, frame ${fStart}-${frameEnd} ---`);

    const outPath = path.join(import.meta.dirname!, `frame-trace-${Date.now()}.txt`);
    fs.writeFileSync(outPath, lines.join('\n'));
    return text(`Frame trace: ${instrCount} instructions written to ${outPath}`);
  },
);

// -- ocr --
server.tool(
  'ocr',
  'OCR the screen bitmap. mode: auto (default) | 32x24 | 51x24 (CP/M Plus) | 64x24 (Tasword).',
  { mode: z.enum(['auto', '32x24', '51x24', '64x24']).optional().describe('Cell grid (default: auto-detect).') },
  async ({ mode }) => text(spec.ocrScreenForMcp(mode ?? 'auto')),
);

// -- model --
server.tool(
  'model',
  'Show or switch the Spectrum model. Creates a fresh machine when switching.',
  { target: z.enum(['48k', '128k', '+2', '+2a', '+3']).optional().describe('Model to switch to (omit to show current)') },
  async ({ target }) => {
    if (!target) return text(`Current model: ${model}`);
    const msg = await initMachine(target);
    return text(`Switched to ${target.toUpperCase()}. ${msg}`);
  },
);

// -- weak --
server.tool(
  'weak',
  'Mark disk sector(s) as weak (randomised on each read). If sector omitted, marks all sectors on the track.',
  {
    track: z.number().int().min(0).describe('Track number'),
    sector: z.number().int().min(0).optional().describe('Sector R value (omit for all sectors on track)'),
  },
  async ({ track: wTrack, sector: wSector }) => {
    const dsk = spec.fdc.getDiskImage(0);
    if (!dsk) return text('No disk in drive A:');
    const track = dsk.tracks[wTrack]?.[0];
    if (!track) return text(`Track ${wTrack} not found`);
    if (wSector !== undefined) {
      const idx = track.sectorMap.get(wSector);
      if (idx === undefined) return text(`Sector R=${wSector} not found on track ${wTrack}`);
      track.sectors[idx].st2 |= 0x20;
      return text(`Marked track ${wTrack} sector R=${wSector} as weak (st2=0x${h8(track.sectors[idx].st2)})`);
    }
    for (const s of track.sectors) s.st2 |= 0x20;
    return text(`Marked all ${track.sectors.length} sectors on track ${wTrack} as weak`);
  },
);

// -- disk_geometry --
server.tool(
  'disk_geometry',
  'Show geometry of the mounted disk image: format, tracks, sides, protection, and a per-track sector summary.',
  { drive: z.number().int().min(0).max(1).default(0).describe('Drive number (0=A, 1=B)') },
  async ({ drive }) => {
    const dsk = spec.fdc.getDiskImage(drive);
    if (!dsk) return text(`No disk in drive ${drive === 0 ? 'A' : 'B'}:`);
    const lines: string[] = [];
    lines.push(`Format: ${dsk.format}  Tracks: ${dsk.numTracks}  Sides: ${dsk.numSides}`);
    if (dsk.diskFormat) lines.push(`Disk format: ${dsk.diskFormat}`);
    if (dsk.protection) lines.push(`Protection: ${dsk.protection}`);
    lines.push('');
    lines.push('Trk Side  Sectors  IDs');
    for (let t = 0; t < dsk.tracks.length; t++) {
      for (let s = 0; s < dsk.numSides; s++) {
        const track = dsk.tracks[t]?.[s];
        if (!track) continue;
        const ids = track.sectors.map(sec => `R${sec.r}(N${sec.n}${sec.st1 || sec.st2 ? ' st1=' + h8(sec.st1) + ' st2=' + h8(sec.st2) : ''})`).join(' ');
        lines.push(`${String(t).padStart(3)}    ${s}     ${String(track.sectors.length).padStart(2)}     ${ids}`);
      }
    }
    return text(lines.join('\n'));
  },
);

// -- track_geometry --
server.tool(
  'track_geometry',
  'Show detailed geometry of a single track: gap3, filler, and full CHRN + status + size for each sector.',
  {
    track: z.number().int().min(0).describe('Track (cylinder) number'),
    side: z.number().int().min(0).max(1).default(0).describe('Side/head (0 or 1)'),
    drive: z.number().int().min(0).max(1).default(0).describe('Drive number (0=A, 1=B)'),
  },
  async ({ track: tNum, side, drive }) => {
    const dsk = spec.fdc.getDiskImage(drive);
    if (!dsk) return text(`No disk in drive ${drive === 0 ? 'A' : 'B'}:`);
    const track = dsk.tracks[tNum]?.[side];
    if (!track) return text(`Track ${tNum} side ${side} not found`);
    const lines: string[] = [];
    lines.push(`Track ${tNum}  Side ${side}  Sectors: ${track.sectors.length}  Gap3: ${h8(track.gap3)}  Filler: ${h8(track.filler)}`);
    lines.push('');
    lines.push('  #  C  H   R   N   ST1  ST2  DataSize');
    for (let i = 0; i < track.sectors.length; i++) {
      const s = track.sectors[i];
      lines.push(`${String(i).padStart(3)}  ${h8(s.c)}  ${h8(s.h)}  ${h8(s.r)}  ${h8(s.n)}   ${h8(s.st1)}   ${h8(s.st2)}   ${s.data.length}`);
    }
    return text(lines.join('\n'));
  },
);

// -- sector_read --
server.tool(
  'sector_read',
  'Read raw sector data from a mounted disk image. Returns a hex dump of the sector contents.',
  {
    track: z.number().int().min(0).describe('Track (cylinder) number'),
    sector: z.number().int().min(0).describe('Sector R value'),
    side: z.number().int().min(0).max(1).default(0).describe('Side/head (0 or 1)'),
    drive: z.number().int().min(0).max(1).default(0).describe('Drive number (0=A, 1=B)'),
    offset: z.number().int().min(0).default(0).describe('Byte offset within sector to start from'),
    length: z.number().int().positive().optional().describe('Number of bytes to dump (default: entire sector)'),
  },
  async ({ track: tNum, sector: sR, side, drive, offset, length }) => {
    const dsk = spec.fdc.getDiskImage(drive);
    if (!dsk) return text(`No disk in drive ${drive === 0 ? 'A' : 'B'}:`);
    const track = dsk.tracks[tNum]?.[side];
    if (!track) return text(`Track ${tNum} side ${side} not found`);
    const idx = track.sectorMap.get(sR);
    if (idx === undefined) return text(`Sector R=${sR} not found on track ${tNum} side ${side}`);
    const sec = track.sectors[idx];
    const start = Math.min(offset, sec.data.length);
    const len = length !== undefined ? Math.min(length, sec.data.length - start) : sec.data.length - start;
    if (len === 0) return text(`Sector R=${sR} has no data from offset ${offset}`);
    // Build hex dump using the sector's data array
    const lines: string[] = [];
    lines.push(`Track ${tNum}  Side ${side}  Sector R=${h8(sR)}  C=${h8(sec.c)} H=${h8(sec.h)} N=${h8(sec.n)}  ST1=${h8(sec.st1)} ST2=${h8(sec.st2)}  Size=${sec.data.length}`);
    lines.push('');
    for (let i = 0; i < len; i += 16) {
      const addr = start + i;
      let hex = '';
      let ascii = '';
      for (let j = 0; j < 16 && i + j < len; j++) {
        const b = sec.data[addr + j];
        hex += h8(b) + ' ';
        ascii += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
      }
      lines.push(`${h16(addr)}  ${hex.padEnd(48)} ${ascii}`);
    }
    return text(lines.join('\n'));
  },
);

// -- subframe -- (removed: inline scanline rendering is now always active)

// -- multiface --
const MF_ROM_CDN = 'https://zx84files.bitsparse.com/roms/';

async function fetchMFRom(variant: string): Promise<Uint8Array> {
  const filename = variant === 'MF1' ? 'MF1.rom' : variant === 'MF128' ? 'MF128.rom' : 'MF3.rom';
  const cachePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(cachePath)) return new Uint8Array(fs.readFileSync(cachePath));
  const resp = await fetch(MF_ROM_CDN + filename);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${filename}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, data);
  return data;
}

server.tool(
  'multiface',
  'Enable/disable Multiface peripheral, load its ROM, or press the NMI button. Actions: "on", "off", "nmi", "status".',
  { action: z.enum(['on', 'off', 'nmi', 'status']).describe('Action to perform') },
  async ({ action }) => {
    const mf = spec.multiface;

    if (action === 'status') {
      return text(
        `Multiface: ${mf.enabled ? 'ON' : 'OFF'}  variant=${mf.variant}  ` +
        `romLoaded=${mf.romLoaded}  pagedIn=${mf.pagedIn}\n` +
        `Model: ${spec.model}  → ${variantLabel(variantForModel(spec.model))}`
      );
    }

    if (action === 'off') {
      if (mf.pagedIn) {
        mf.pageOut(spec.memory);
        spec.memory.applyBanking();
      }
      mf.enabled = false;
      return text('Multiface disabled');
    }

    if (action === 'on') {
      const variant = variantForModel(spec.model);
      mf.variant = variant;
      mf.enabled = true;
      if (!mf.romLoaded) {
        try {
          const data = await fetchMFRom(variant);
          mf.loadROM(data);
          return text(`Multiface enabled: ${variantLabel(variant)} ROM loaded (${data.length} bytes, byte@66=${h8(data[0x66])})`);
        } catch (err) {
          mf.enabled = false;
          return text(`Failed to load ${variantLabel(variant)} ROM: ${err}`);
        }
      }
      return text(`Multiface enabled: ${variantLabel(variant)} (ROM already loaded)`);
    }

    // action === 'nmi'
    if (!mf.enabled) return text('Multiface not enabled. Use action=on first.');
    if (!mf.romLoaded) return text('Multiface ROM not loaded. Use action=on first.');

    const prevPC = spec.cpu.pc;
    mf.pressButton(spec.memory, spec.cpu, spec.memory.slot0Bank);
    return text(
      `NMI triggered. PC: ${h16(prevPC)} → ${h16(spec.cpu.pc)}\n` +
      `pagedIn=${mf.pagedIn}  [0x66]=${h8(spec.memory.readByte(0x66))}  [0x67]=${h8(spec.memory.readByte(0x67))}  [0x68..6A]=${h8(spec.memory.readByte(0x68))}${h8(spec.memory.readByte(0x69))}${h8(spec.memory.readByte(0x6A))}\n` +
      `SP=${h16(spec.cpu.sp)}  IFF1=${spec.cpu.iff1}  IFF2=${spec.cpu.iff2}`
    );
  },
);

// -- vtx5000 --
const VTX_ROM_CDN = 'https://zx84files.bitsparse.com/roms/vtx5000-3-1.rom';
const VTX_ROM_CACHE = path.join(CACHE_DIR, 'vtx5000-3-1.rom');

async function fetchVTXRom(): Promise<Uint8Array> {
  if (fs.existsSync(VTX_ROM_CACHE)) return new Uint8Array(fs.readFileSync(VTX_ROM_CACHE));
  const resp = await fetch(VTX_ROM_CDN);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching VTX-5000 ROM`);
  const data = new Uint8Array(await resp.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(VTX_ROM_CACHE, data);
  return data;
}

server.tool(
  'vtx5000',
  'Enable/disable the VTX-5000 Viewdata/Prestel modem (48K only). Loads the ROM overlay and resets the machine.',
  { action: z.enum(['on', 'off', 'status']).describe('Action to perform') },
  async ({ action }) => {
    const vtx = spec.vtx5000;

    if (action === 'status') {
      return text(
        `VTX-5000: ${vtx.enabled ? 'ON' : 'OFF'}  romLoaded=${vtx.romLoaded}  romSize=${vtx.romSize}\n` +
        `8251: vtxRomPaged=${vtx.vtxRomPaged}  status=${h8(vtx.readStatus())}  dsr=${vtx.dsr}\n` +
        `Model: ${spec.model}  (only supported on 48K)\n` +
        `[0x0000]=${h8(spec.memory.readByte(0x0000))}  [0x1FFF]=${h8(spec.memory.readByte(0x1FFF))}  [0x2000]=${h8(spec.memory.readByte(0x2000))}`
      );
    }

    if (action === 'off') {
      vtx.enabled = false;
      spec.memory.applyBanking();
      spec.cpu.pc = 0;
      return text('VTX-5000 disabled. Memory restored to Spectrum ROM. PC=0000');
    }

    // action === 'on'
    if (spec.model !== '48k') return text('VTX-5000 only supported on 48K model. Use model tool to switch.');
    vtx.enabled = true;
    if (!vtx.romLoaded) {
      try {
        const data = await fetchVTXRom();
        vtx.loadROM(data);
      } catch (err) {
        vtx.enabled = false;
        return text(`Failed to load VTX-5000 ROM: ${err}`);
      }
    }
    // reset() will call vtx.applyROM() internally since enabled+romLoaded are both true
    spec.reset();
    return text(
      `VTX-5000 enabled (ROM: ${vtx.romSize} bytes). Machine reset.\n` +
      `[0x0000]=${h8(spec.memory.readByte(0x0000))}  [0x1FFF]=${h8(spec.memory.readByte(0x1FFF))}  [0x2000]=${h8(spec.memory.readByte(0x2000))}\n` +
      `PC=${h16(spec.cpu.pc)}`
    );
  },
);

// ── Startup ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse CLI args for initial model
  const args = process.argv.slice(2);
  let startModel: SpectrumModel = '48k';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && i + 1 < args.length) {
      const m = args[++i];
      if (['48k', '128k', '+2', '+2a', '+3'].includes(m)) {
        startModel = m as SpectrumModel;
      }
    }
  }

  await initMachine(startModel);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`MCP server error: ${e}\n`);
  process.exit(1);
});
