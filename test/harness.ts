/**
 * Headless test harness for ZX84.
 *
 * Runs a Spectrum machine without a browser — no canvas, no audio, no DOM.
 * Provides an interactive REPL for stepping, breakpoints, tracing, etc.
 *
 * Usage:
 *   npm run harness -- [--model 48k|128k|+2|+2a|+3] [file.tap|file.sna|file.dsk]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Spectrum, type SpectrumModel, is128kClass } from '../src/spectrum.ts';
import { disasmOne, disassemble, stripMarkers } from '../src/debug/z80-disasm.ts';
import { loadSNA } from '../src/snapshot/sna.ts';
import { loadZ80 } from '../src/snapshot/z80format.ts';
import { parseDSK } from '../src/plus3/dsk.ts';
import { parseTZX } from '../src/tape/tzx.ts';

// ── ROM URLs (same as src/store/emulator.ts) ─────────────────────────────

const ROM_URLS: Record<SpectrumModel, string> = {
  '48k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '128k': 'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/128/spec128uk.rom',
  '+2':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/plus2/plus2uk.rom',
  '+2a':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus2a/plus2a.rom',
  '+3':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus3/plus3.rom',
};

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

// ── Key name → DOM code mapping ──────────────────────────────────────────

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
  'backspace': 'Backspace',
  'left': 'ArrowLeft', 'right': 'ArrowRight',
  'up': 'ArrowUp', 'down': 'ArrowDown',
  'capslock': 'CapsLock', 'escape': 'Escape', 'esc': 'Escape',
};

// ── ROM cache ────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(import.meta.dirname!, '.cache');

async function fetchROM(model: SpectrumModel): Promise<Uint8Array> {
  const url = ROM_URLS[model];
  const filename = url.split('/').pop()!;
  const cachePath = path.join(CACHE_DIR, filename);

  // Try cache first
  if (fs.existsSync(cachePath)) {
    console.log(`ROM: ${filename} (cached)`);
    return new Uint8Array(fs.readFileSync(cachePath));
  }

  // Download
  console.log(`Downloading ${model.toUpperCase()} ROM from GitHub...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ROM`);
  const data = new Uint8Array(await resp.arrayBuffer());

  // Cache
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, data);
  console.log(`ROM: ${filename} (${data.length} bytes, cached to ${cachePath})`);
  return data;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse CLI args
  const args = process.argv.slice(2);
  let model: SpectrumModel = '48k';
  let fileArg: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && i + 1 < args.length) {
      const m = args[++i];
      if (['48k', '128k', '+2', '+2a', '+3'].includes(m)) {
        model = m as SpectrumModel;
      } else {
        console.error(`Unknown model: ${m}`);
        process.exit(1);
      }
    } else if (!args[i].startsWith('-')) {
      fileArg = args[i];
    }
  }

  // Auto-detect model from filename
  if (fileArg && !args.includes('--model')) {
    const ext = path.extname(fileArg).toLowerCase();
    if (ext === '.sna') {
      const stat = fs.statSync(fileArg);
      if (stat.size > 49179) model = '128k';
    }
  }

  console.log(`ZX84 Headless Harness — model: ${model}`);

  // Fetch ROM
  let romData = await fetchROM(model);

  // Create headless machine (no canvas)
  let spec = new Spectrum(model);
  spec.loadROM(romData);
  spec.reset();
  console.log(`Machine ready. CPU at PC=${h16(spec.cpu.pc)}`);

  // Load file if provided
  if (fileArg) {
    loadFileInto(spec, fileArg);
  }

  /** Switch to a new model, creating a fresh machine. */
  async function switchModel(newModel: SpectrumModel): Promise<void> {
    romData = await fetchROM(newModel);
    spec = new Spectrum(newModel);
    spec.loadROM(romData);
    spec.reset();
    model = newModel;
    console.log(`Switched to ${newModel.toUpperCase()}. PC=${h16(spec.cpu.pc)}`);
  }

  // ── REPL ─────────────────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    try {
      switch (cmd) {
        case 'run': {
          const n = parseInt(parts[1]) || 1;
          const ran = spec.runUntil(n);
          if (spec.breakpointHit >= 0) {
            console.log(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran}/${n} frame(s). T=${spec.cpu.tStates}`);
            printStep(spec);
          } else {
            console.log(`Ran ${n} frame(s). T=${spec.cpu.tStates}`);
          }
          break;
        }

        case 'step':
        case 's': {
          const n = parseInt(parts[1]) || 1;
          for (let i = 0; i < n; i++) {
            printStep(spec);
            spec.cpu.step();
          }
          break;
        }

        case 'cont':
        case 'c': {
          if (spec.breakpoints.size === 0) {
            console.log('No breakpoints set. Use "bp <addr>" first.');
            break;
          }
          const maxFrames = parseInt(parts[1]) || 5000;
          const ran = spec.runUntil(maxFrames);
          if (spec.breakpointHit >= 0) {
            console.log(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran} frame(s). T=${spec.cpu.tStates}`);
            printStep(spec);
          } else {
            console.log(`No breakpoint hit after ${maxFrames} frames (T=${spec.cpu.tStates})`);
          }
          break;
        }

        case 'regs':
        case 'r': {
          printRegs(spec);
          break;
        }

        case 'dis':
        case 'd': {
          const addr = parts[1] ? parseAddr(parts[1]) : spec.cpu.pc;
          const n = parseInt(parts[2]) || 16;
          const lines = disassemble(spec.cpu.memory, addr, n);
          for (const l of lines) {
            const bytes: string[] = [];
            for (let i = 0; i < l.length; i++) bytes.push(h8(spec.cpu.memory[(l.addr + i) & 0xFFFF]));
            const prefix = l.addr === spec.cpu.pc ? '>' : ' ';
            console.log(`${prefix} ${h16(l.addr)}  ${bytes.join(' ').padEnd(11)}  ${stripMarkers(l.text)}`);
          }
          break;
        }

        case 'mem':
        case 'm': {
          if (!parts[1]) { console.log('Usage: mem <addr> [len]'); break; }
          const addr = parseAddr(parts[1]);
          const len = parseInt(parts[2]) || 64;
          hexDump(spec.cpu.memory, addr, len);
          break;
        }

        case 'bp': {
          if (!parts[1]) {
            if (spec.breakpoints.size === 0) {
              console.log('No breakpoints');
            } else {
              console.log('Breakpoints: ' + [...spec.breakpoints].map(h16).join(', '));
            }
            break;
          }
          const addr = parseAddr(parts[1]);
          spec.breakpoints.add(addr);
          console.log(`Breakpoint set at ${h16(addr)}`);
          break;
        }

        case 'del': {
          if (!parts[1]) {
            spec.breakpoints.clear();
            console.log('All breakpoints cleared');
          } else {
            const addr = parseAddr(parts[1]);
            spec.breakpoints.delete(addr);
            console.log(`Breakpoint at ${h16(addr)} removed`);
          }
          break;
        }

        case 'key': {
          if (!parts[1]) { console.log('Usage: key <name> [frames]'); break; }
          const name = parts[1].toLowerCase();
          const frames = parseInt(parts[2]) || 5;
          const code = KEY_NAME_MAP[name];
          if (!code) {
            console.log(`Unknown key: ${name}. Available: ${Object.keys(KEY_NAME_MAP).join(', ')}`);
            break;
          }
          spec.keyboard.handleKeyEvent(code, true);
          for (let i = 0; i < frames; i++) spec.tick();
          spec.keyboard.handleKeyEvent(code, false);
          spec.tick(); // one more frame with key released
          console.log(`Key '${name}' held for ${frames} frames`);
          break;
        }

        case 'trace': {
          const mode = (parts[1] || 'full') as 'full' | 'contention' | 'portio';
          if (!['full', 'contention', 'portio'].includes(mode)) {
            console.log('Usage: trace <full|contention|portio>');
            break;
          }
          spec.startTrace(mode);
          console.log(`Trace started (${mode} mode)`);
          break;
        }

        case 'stop': {
          if (!spec.tracing) {
            console.log('Not tracing');
            break;
          }
          const text = spec.stopTrace();
          const lines = text.split('\n');
          if (lines.length <= 100) {
            console.log(text);
          } else {
            // Write to file if large
            const outPath = path.join(import.meta.dirname!, `trace-${Date.now()}.txt`);
            fs.writeFileSync(outPath, text);
            console.log(`Trace: ${lines.length} lines written to ${outPath}`);
          }
          break;
        }

        case 'load': {
          if (!parts[1]) { console.log('Usage: load <file> [unit]'); break; }
          // Optional trailing unit specifier for DSK: 0/1/A/B/A:/B:
          let fileParts = parts.slice(1);
          let diskUnit = 0;
          const last = fileParts[fileParts.length - 1].toLowerCase();
          if (['0','1','a','b','a:','b:'].includes(last)) {
            diskUnit = (last === '1' || last === 'b' || last === 'b:') ? 1 : 0;
            fileParts = fileParts.slice(0, -1);
          }
          // Strip surrounding quotes (single or double) the user may have typed
          const filepath = fileParts.join(' ').replace(/^["']|["']$/g, '');
          loadFileInto(spec, filepath, diskUnit);
          break;
        }

        case 'diskboot': {
          // Boot from disk in drive A:. Lets the +3 start up normally (500
          // frames for the menu to appear), then simulates pressing Enter on
          // the "Loader" option. This exercises the real DOS BOOT path with
          // all +3DOS internal state properly initialised.
          if (spec.model !== '+3') {
            console.log('diskboot requires +3 model. Use: model +3');
            break;
          }
          if (!spec.fdc.getDiskImage(0)) {
            console.log('No disk in drive A:. Use: load <file.dsk>');
            break;
          }

          // Let the +3 boot to its startup menu
          console.log('Booting +3 to startup menu...');
          spec.runUntil(500);

          // Press Enter to select "Loader" (default highlighted option)
          spec.keyboard.handleKeyEvent('Enter', true);
          for (let i = 0; i < 5; i++) spec.tick();
          spec.keyboard.handleKeyEvent('Enter', false);
          spec.tick();

          console.log(`DOS BOOT initiated via Loader menu.`);
          console.log(`  Bootstrap loads to FE00h, enters at FE10h.`);
          console.log(`  Suggested: bp FE10  →  cont`);
          break;
        }

        case 'eject': {
          const tgt = parts[1]?.toLowerCase();
          if (tgt === 'tape') {
            spec.tape.load(new Uint8Array(0));
            console.log('Tape ejected');
          } else if (tgt === 'disk' || tgt === 'a' || tgt === 'a:' || tgt === '0' ||
                     tgt === 'b' || tgt === 'b:' || tgt === '1') {
            const unit = (tgt === 'b' || tgt === 'b:' || tgt === '1') ? 1 : 0;
            spec.fdc.ejectDisk(unit);
            console.log(`Drive ${unit === 0 ? 'A' : 'B'}: ejected`);
          } else {
            console.log('Usage: eject disk [0|1|A|B]  or  eject tape');
          }
          break;
        }

        case 'out': {
          if (parts.length < 3) { console.log('Usage: out <port> <val>'); break; }
          const port = parseAddr(parts[1]) & 0xFFFF;
          const val  = parseAddr(parts[2]) & 0xFF;
          spec.cpu.portOutHandler!(port, val);
          console.log(`OUT ${h16(port)}, ${h8(val)}`);
          if (is128kClass(spec.model)) {
            const mem = spec.memory;
            console.log(`  Bank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`);
          }
          break;
        }

        case 'in': {
          if (!parts[1]) { console.log('Usage: in <port>'); break; }
          const port = parseAddr(parts[1]) & 0xFFFF;
          const val  = spec.cpu.portInHandler!(port);
          console.log(`IN ${h16(port)} = ${h8(val)} (${val})`);
          break;
        }

        case 'pc': {
          if (!parts[1]) { console.log(`PC = ${h16(spec.cpu.pc)}`); break; }
          spec.cpu.pc = parseAddr(parts[1]) & 0xFFFF;
          console.log(`PC = ${h16(spec.cpu.pc)}`);
          printStep(spec);
          break;
        }

        case 'poke': {
          if (parts.length < 3) { console.log('Usage: poke <addr> <val>'); break; }
          const addr = parseAddr(parts[1]) & 0xFFFF;
          const val  = parseAddr(parts[2]) & 0xFF;
          spec.cpu.memory[addr] = val;
          console.log(`[${h16(addr)}] = ${h8(val)}`);
          break;
        }

        case 'peek': {
          if (!parts[1]) { console.log('Usage: peek <addr>'); break; }
          const addr = parseAddr(parts[1]) & 0xFFFF;
          const val  = spec.cpu.memory[addr];
          console.log(`[${h16(addr)}] = ${h8(val)} (${val})`);
          break;
        }

        case 'set': {
          if (parts.length < 3) {
            console.log('Usage: set <reg> <val>   (regs: A F AF BC DE HL SP PC IX IY)');
            break;
          }
          const reg = parts[1].toUpperCase();
          const val = parseAddr(parts[2]);
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
            default: console.log(`Unknown register: ${reg}`); break;
          }
          console.log(`${reg} = ${val <= 0xFF ? h8(val) : h16(val)}`);
          break;
        }

        case 'find': {
          if (!parts[1]) { console.log('Usage: find <hex bytes>'); break; }
          const hex = parts.slice(1).join('').replace(/\s/g, '');
          if (hex.length % 2 !== 0) { console.log('Hex string must have even length'); break; }
          const needle = new Uint8Array(hex.length / 2);
          for (let i = 0; i < needle.length; i++) needle[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          findBytes(spec.cpu.memory, needle);
          break;
        }

        case 'screen':
        case 'scr': {
          console.log(spec.getScreenText());
          break;
        }

        case 'ocr': {
          console.log(spec.ocrScreen());
          break;
        }

        case 'model': {
          const m = parts[1]?.toLowerCase();
          if (!m || !['48k', '128k', '+2', '+2a', '+3'].includes(m)) {
            console.log(`Current model: ${model}. Usage: model <48k|128k|+2|+2a|+3>`);
            break;
          }
          await switchModel(m as SpectrumModel);
          break;
        }

        case 'subframe':
        case 'sf': {
          spec.subFrameRendering = !spec.subFrameRendering;
          console.log(`Sub-frame rendering: ${spec.subFrameRendering ? 'ON' : 'OFF'}`);
          break;
        }

        case 'weak': {
          // Mark sector(s) as weak (st2 |= 0x20) so FDC randomises data on each read.
          // Usage: weak <track> [sector]    — if sector omitted, marks ALL sectors on the track
          const dsk = spec.fdc.getDiskImage(0);
          if (!dsk) { console.log('No disk in drive A:'); break; }
          if (parts.length < 2) { console.log('Usage: weak <track> [sector]'); break; }
          const wTrack = parseAddr(parts[1]);
          const track = dsk.tracks[wTrack]?.[0];
          if (!track) { console.log(`Track ${wTrack} not found`); break; }
          if (parts.length >= 3) {
            const wR = parseAddr(parts[2]);
            const idx = track.sectorMap.get(wR);
            if (idx === undefined) { console.log(`Sector R=${wR} not found on track ${wTrack}`); break; }
            track.sectors[idx].st2 |= 0x20;
            console.log(`Marked track ${wTrack} sector R=${wR} as weak (st2=0x${h8(track.sectors[idx].st2)})`);
          } else {
            for (const s of track.sectors) s.st2 |= 0x20;
            console.log(`Marked all ${track.sectors.length} sectors on track ${wTrack} as weak`);
          }
          break;
        }

        case 'quit':
        case 'q':
          rl.close();
          process.exit(0);

        case 'help':
        case '?':
          printHelp();
          break;

        default:
          console.log(`Unknown command: ${cmd}. Type "help" for commands.`);
      }
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

// ── Command implementations ──────────────────────────────────────────────

function printStep(spec: Spectrum): void {
  const cpu = spec.cpu;
  const line = disasmOne(cpu.memory, cpu.pc);
  const mnem = stripMarkers(line.text).padEnd(20);
  console.log(
    `${h16(cpu.pc)}  ${mnem}` +
    `A=${h8(cpu.a)} F=${h8(cpu.f)} ` +
    `BC=${h16(cpu.bc)} DE=${h16(cpu.de)} HL=${h16(cpu.hl)} ` +
    `SP=${h16(cpu.sp)}  T=${cpu.tStates}`
  );
}

function printRegs(spec: Spectrum): void {
  const cpu = spec.cpu;
  const f = cpu.f;
  const flags = [
    (f & 0x80) ? 'S' : '-',
    (f & 0x40) ? 'Z' : '-',
    (f & 0x10) ? 'H' : '-',
    (f & 0x04) ? 'P' : '-',
    (f & 0x02) ? 'N' : '-',
    (f & 0x01) ? 'C' : '-',
  ].join('');
  const iff = cpu.iff1 ? 'EI' : 'DI';
  const halt = cpu.halted ? ' HALT' : '';

  console.log(`AF  ${h16(cpu.af)}  AF' ${h16((cpu.a_ << 8) | cpu.f_)}   Flags: ${flags}`);
  console.log(`BC  ${h16(cpu.bc)}  BC' ${h16((cpu.b_ << 8) | cpu.c_)}`);
  console.log(`DE  ${h16(cpu.de)}  DE' ${h16((cpu.d_ << 8) | cpu.e_)}`);
  console.log(`HL  ${h16(cpu.hl)}  HL' ${h16((cpu.h_ << 8) | cpu.l_)}`);
  console.log(`IX  ${h16(cpu.ix)}  IY  ${h16(cpu.iy)}   ${iff}  IM${cpu.im}${halt}`);
  console.log(`SP  ${h16(cpu.sp)}  PC  ${h16(cpu.pc)}   IR  ${h8(cpu.i)}${h8(cpu.r)}`);
  console.log(`T-states: ${cpu.tStates}`);

  // Memory banking
  if (is128kClass(spec.model)) {
    const mem = spec.memory;
    console.log(`Bank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`);
  }
}

function hexDump(mem: Uint8Array, start: number, len: number): void {
  for (let i = 0; i < len; i += 16) {
    const addr = (start + i) & 0xFFFF;
    let hex = '';
    let ascii = '';
    for (let j = 0; j < 16 && i + j < len; j++) {
      const b = mem[(addr + j) & 0xFFFF];
      hex += h8(b) + ' ';
      ascii += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
    }
    console.log(`${h16(addr)}  ${hex.padEnd(48)} ${ascii}`);
  }
}

function findBytes(mem: Uint8Array, needle: Uint8Array): void {
  const results: number[] = [];
  for (let i = 0; i <= 0xFFFF - needle.length + 1; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (mem[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) results.push(i);
    if (results.length >= 64) break;
  }
  if (results.length === 0) {
    console.log('Not found');
  } else {
    console.log(`Found ${results.length} match(es): ${results.map(h16).join(', ')}`);
  }
}

function loadFileInto(spec: Spectrum, filepath: string, diskUnit: number = 0): void {
  if (!fs.existsSync(filepath)) {
    console.log(`File not found: ${filepath}`);
    return;
  }
  const data = new Uint8Array(fs.readFileSync(filepath));
  const ext = path.extname(filepath).toLowerCase();
  const filename = path.basename(filepath);

  if (ext === '.tap') {
    spec.loadTAP(data);
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    console.log(`TAP loaded: ${filename} (${spec.tape.blocks.length} blocks)`);
  } else if (ext === '.tzx') {
    const blocks = parseTZX(data);
    spec.tape.blocks = blocks;
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    console.log(`TZX loaded: ${filename} (${blocks.length} blocks)`);
  } else if (ext === '.dsk') {
    const image = parseDSK(data);
    spec.loadDisk(image, diskUnit);
    const driveLetter = diskUnit === 0 ? 'A' : 'B';
    console.log(`DSK loaded: ${filename} → Drive ${driveLetter}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`);
  } else if (ext === '.sna') {
    spec.reset();
    const result = loadSNA(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    spec.cpu.memory = spec.memory.flat;
    console.log(`SNA loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`);
  } else if (ext === '.z80') {
    spec.reset();
    const result = loadZ80(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    spec.cpu.memory = spec.memory.flat;
    console.log(`Z80 loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`);
  } else {
    console.log(`Unsupported file type: ${ext}`);
  }
}

function printHelp(): void {
  console.log(`
Commands:
  run [n]              Run n frames (default 1)
  step [n]  | s [n]    Step n instructions, showing each
  cont      | c        Continue until breakpoint
  regs      | r        Show CPU registers
  dis [addr] [n] | d   Disassemble at addr (default PC, 16 lines)
  mem <addr> [len] | m Hex dump (default 64 bytes)
  bp [addr]            Set breakpoint (hex), or list all
  del [addr]           Delete breakpoint (or all)
  key <name> [frames]  Press key for N frames (default 5)
  trace <mode>         Start trace: full, contention, portio
  stop                 Stop trace, print/save result
  load <file> [unit]   Load TAP/TZX/SNA/Z80/DSK (DSK: optional 0|1|A|B for drive)
  diskboot             Page in +3DOS ROM, call BOOT routine at 012Ah (no keypress needed)
  eject disk [0|1|A|B] Eject disk from drive A or B
  eject tape           Unload tape
  out <port> <val>     Write byte to I/O port (triggers port handler; use to bank-switch)
  in <port>            Read byte from I/O port
  pc [addr]            Get/set PC register
  poke <addr> <val>    Write byte to memory address
  peek <addr>          Read byte from memory address
  set <reg> <val>      Set register: A F AF BC DE HL SP PC IX IY (and B C D E H L)
  find <hex>           Search memory for byte sequence
  screen | scr         Show screen text (RST 16 grid)
  ocr                  OCR screen (bitmap matching)
  model [m]            Show/switch model (48k|128k|+2|+2a|+3)
  weak <track> [sector] Mark sector(s) as weak (randomised on each read)
  subframe | sf        Toggle sub-frame rendering
  quit | q             Exit
  help | ?             This message

Key names: a-z, 0-9, enter, space, shift, sym, backspace,
           left, right, up, down, capslock, escape
`.trim());
}

// ── Entry point ──────────────────────────────────────────────────────────

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
