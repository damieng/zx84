/**
 * ZX Spectrum machine orchestrator.
 *
 * Wires together Z80 CPU, AY sound chip, ULA, memory, display, audio, and keyboard.
 * Runs the frame loop at 50.08 Hz (69,888 T-states/frame, Z80 at 3.5 MHz).
 *
 * Timing: audio buffer fill level governs speed. Each rAF tick runs 0-2 frames
 * depending on how many audio samples the callback has consumed. This keeps the
 * emulator locked to real-time without drift.
 */

import { Z80 } from './cores/z80.ts';
import { AY3891x } from './cores/ay-3-8910.ts';
import { SpectrumMemory } from './memory.ts';
import { ULA, SCREEN_WIDTH, SCREEN_HEIGHT, type BorderMode } from './ula.ts';
import { SpectrumKeyboard } from './keyboard.ts';
import { Display } from './display.ts';
import { Audio } from './audio.ts';
import { TapeDeck } from './formats/tap.ts';
import { UPD765A } from './cores/upd765a.ts';
import { Plus3DosTrap } from './plus3dos-trap.ts';
import type { DskImage } from './formats/dsk.ts';

const Z80_CLOCK = 3500000;       // 3.5 MHz
const AY_CLOCK = 1773400;        // ~1.77 MHz

/** Model-dependent ULA timing parameters. */
interface MachineTiming {
  tStatesPerFrame: number;
  tStatesPerLine: number;
  /** Frame-relative T-state at which contention begins (first pixel line). */
  contentionStart: number;
}

const TIMING_48K: MachineTiming = {
  tStatesPerFrame: 69888,   // 224 × 312
  tStatesPerLine: 224,
  contentionStart: 14335,
};

const TIMING_128K: MachineTiming = {
  tStatesPerFrame: 70908,   // 228 × 311
  tStatesPerLine: 228,
  contentionStart: 14361,
};

/** ULA contention delay pattern — indexed by (T-state mod 8). */
const CONTENTION_PATTERN = new Uint8Array([6, 5, 4, 3, 2, 1, 0, 0]);

/** Samples produced per Spectrum frame at a given sample rate */
function samplesPerFrame(sampleRate: number): number {
  return Math.round(sampleRate / 50);
}

/** Target buffer fill: ~3 frames of audio (~60ms). Below this we run a frame. */
const TARGET_BUFFER_FRAMES = 3;

/** Wall-clock frame period: 50 Hz = 20ms */
const FRAME_PERIOD = 1000 / 50;

export type SpectrumModel = '48k' | '128k' | '+2' | '+2a' | '+3';

/** Returns true for any 128K-class model (128K, +2, +2A, +3). */
export function is128kClass(m: SpectrumModel): boolean { return m !== '48k'; }

/** Returns true for +2A/+3 class (Amstrad gate array with 0x1FFD port, 4 ROM pages). */
export function isPlus2AClass(m: SpectrumModel): boolean { return m === '+2a' || m === '+3'; }

/** Returns true for +3 (has uPD765A FDC). */
export function isPlus3(m: SpectrumModel): boolean { return m === '+3'; }

export interface IOActivity {
  /** Number of ULA port reads this frame (keyboard / tape) */
  ulaReads: number;
  /** Number of Kempston joystick port reads this frame */
  kempstonReads: number;
  /** Whether the beeper bit toggled this frame */
  beeperToggled: boolean;
  /** Number of AY register writes this frame */
  ayWrites: number;
  /** Number of LD-BYTES (0x0556) calls this frame */
  tapeLoads: number;
  /** Number of RST 16 (0x0010) calls this frame */
  rst16Calls: number;
  /** Number of FDC data port accesses this frame */
  fdcAccesses: number;
  /** Number of ULA reads while tape is active (EAR sampling) */
  earReads: number;
}

/**
 * ZX Spectrum character set → Unicode mapping for codes 0x80-0xFF.
 * 0x80-0x8F: 2×2 block graphics (Unicode Block Elements)
 * 0x90-0xA4: UDGs A-U (rendered as circled letters)
 * 0xA5-0xFF: BASIC keyword tokens
 */
const SPECTRUM_CHARS: string[] = [
  // 0x80-0x8F: block graphics (bit pattern: b0=TL, b1=TR, b2=BL, b3=BR)
  ' ',  '\u2598', '\u259D', '\u2580', '\u2596', '\u258C', '\u259E', '\u259B',
  '\u2597', '\u259A', '\u2590', '\u259C', '\u2584', '\u2599', '\u259F', '\u2588',
  // 0x90-0xA4: UDGs A-U
  '\u24B6', '\u24B7', '\u24B8', '\u24B9', '\u24BA', '\u24BB', '\u24BC', '\u24BD',
  '\u24BE', '\u24BF', '\u24C0', '\u24C1', '\u24C2', '\u24C3', '\u24C4', '\u24C5',
  '\u24C6', '\u24C7', '\u24C8', '\u24C9', '\u24CA',
  // 0xA5-0xFF: BASIC keyword tokens
  'RND', 'INKEY$', 'PI', 'FN ', 'POINT ', 'SCREEN$ ', 'ATTR ', 'AT ', 'TAB ',
  'VAL$ ', 'CODE ', 'VAL ', 'LEN ', 'SIN ', 'COS ', 'TAN ', 'ASN ', 'ACS ',
  'ATN ', 'LN ', 'EXP ', 'INT ', 'SQR ', 'SGN ', 'ABS ', 'PEEK ', 'IN ',
  'USR ', 'STR$ ', 'CHR$ ', 'NOT ', 'BIN ',
  'OR ', 'AND ', '<=', '>=', '<>', 'LINE ', 'THEN ', 'TO ', 'STEP ',
  'DEF FN ', 'CAT ', 'FORMAT ', 'MOVE ', 'ERASE ', 'OPEN #', 'CLOSE #',
  'MERGE ', 'VERIFY ', 'BEEP ', 'CIRCLE ', 'INK ', 'PAPER ', 'FLASH ',
  'BRIGHT ', 'INVERSE ', 'OVER ', 'OUT ',
  'LPRINT ', 'LLIST ', 'STOP ', 'READ ', 'DATA ', 'RESTORE ', 'NEW ',
  'BORDER ', 'CONTINUE ', 'DIM ', 'REM ', 'FOR ', 'GO TO ', 'GO SUB ',
  'INPUT ', 'LOAD ', 'LIST ', 'LET ', 'PAUSE ', 'NEXT ', 'POKE ', 'PRINT ',
  'PLOT ', 'RUN ', 'SAVE ', 'RANDOMIZE ', 'IF ', 'CLS ', 'DRAW ', 'CLEAR ',
  'RETURN ', 'COPY ',
];

export class Spectrum {
  model: SpectrumModel;
  memory: SpectrumMemory;
  cpu: Z80;
  ay: AY3891x;
  ula: ULA;
  keyboard: SpectrumKeyboard;
  display: Display;
  audio: Audio;
  tape: TapeDeck;
  fdc: UPD765A;

  /** Disk access mode: 'fdc' = full FDC emulation, 'bios' = +3DOS BIOS traps */
  diskMode: 'fdc' | 'bios' = 'fdc';
  biosTrap: Plus3DosTrap | null = null;

  /** Per-frame I/O activity counters */
  activity: IOActivity = { ulaReads: 0, kempstonReads: 0, beeperToggled: false, ayWrites: 0, tapeLoads: 0, rst16Calls: 0, fdcAccesses: 0, earReads: 0 };

  /** Kempston joystick state (bits: 0=right,1=left,2=down,3=up,4=fire) */
  kempstonState = 0;

  /** 32x24 character grid mirroring what RST 16 prints to the display */
  screenGrid: string[] = new Array(768).fill(' ');
  private screenSkipCount = 0;

  private running = false;
  private starting = false;
  private rafId = 0;
  private tStatesPerSample: number;

  /** Beeper duty cycle accumulator for current audio sample */
  private beeperAccum = 0;
  private beeperTStatesAccum = 0;

  /** DC-blocking filter for beeper (removes DC bias and low-freq clicks from ROM port writes) */
  private beeperDCAlpha = 0;
  private beeperDCPrev = 0;
  private beeperDCOut = 0;

  /** Previous beeper state for toggle detection */
  private prevBeeperBit = 0;

  /** Whether at least one frame has rendered (for display) */
  private needsDisplay = true;

  /** Wall-clock frame pacing (governs speed regardless of rAF rate) */
  private lastFrameTime = 0;
  private frameTimeAccum = 0;

  /** Model-dependent timing */
  private timing: MachineTiming;

  /** T-state counter at start of current frame (for contention/floating bus). */
  private frameStartTStates = 0;

  /** Turbo mode: run ~14x frames per rAF for ~50MHz effective speed */
  turbo = false;

  /** Status callback */
  onStatus: ((msg: string) => void) | null = null;

  /** Frame callback (fires each rAF after rendering) */
  onFrame: (() => void) | null = null;

  constructor(model: SpectrumModel, canvas: HTMLCanvasElement) {
    this.model = model;

    this.memory = new SpectrumMemory(model);
    this.cpu = new Z80(this.memory.flat);
    this.ay = new AY3891x(AY_CLOCK, 44100, 'ABC');
    this.keyboard = new SpectrumKeyboard();
    this.ula = new ULA(this.keyboard);
    this.display = new Display(canvas, SCREEN_WIDTH, SCREEN_HEIGHT);
    this.audio = new Audio();
    this.tape = new TapeDeck();
    this.fdc = new UPD765A();
    this.timing = is128kClass(model) ? TIMING_128K : TIMING_48K;

    this.tStatesPerSample = Z80_CLOCK / 44100;

    if (isPlus3(model)) {
      this.biosTrap = new Plus3DosTrap(this.cpu, this.memory, this.fdc);
    }

    this.installROMProtection();
    this.wirePortIO();
  }

  /**
   * Override Z80 write8 to silently discard writes to the ROM region (0x0000-0x3FFF).
   * On real hardware, ROM is read-only — writes are ignored, not buffered.
   */
  private installROMProtection(): void {
    const memory = this.memory;
    this.cpu.write8 = (addr: number, val: number): void => {
      addr &= 0xFFFF;
      if (addr < 0x4000 && !memory.specialPaging) return; // ROM — silently discard
      this.cpu.memory[addr] = val & 0xFF;
    };
  }

  private wirePortIO(): void {
    this.cpu.portOutHandler = (port: number, val: number) => {
      // ULA port: any port with bit 0 = 0
      if ((port & 0x01) === 0) {
        const newBeeperBit = (val >> 4) & 1;
        if (newBeeperBit !== this.prevBeeperBit) {
          this.activity.beeperToggled = true;
          this.prevBeeperBit = newBeeperBit;
        }
        this.ula.writePort(val);
      }

      // 128K bank switching: port 0x7FFD
      if (is128kClass(this.model)) {
        // +2A: strict decode (port & 0xC002) === 0x4000 to avoid 0x1FFD collision
        // 128K/+2: loose decode (port & 0x8002) === 0
        const match7FFD = isPlus2AClass(this.model)
          ? (port & 0xC002) === 0x4000
          : (port & 0x8002) === 0;
        if (match7FFD) {
          this.memory.bankSwitch(val);
          this.cpu.memory = this.memory.flat;
        }

        // +2A: port 0x1FFD (port & 0xF002) === 0x1000
        if (isPlus2AClass(this.model) && (port & 0xF002) === 0x1000) {
          this.memory.bankSwitch1FFD(val);
          if (isPlus3(this.model)) this.fdc.motorOn = (val & 0x08) !== 0;
          this.cpu.memory = this.memory.flat;
        }

        // +3 FDC data write: port 0x3FFD (A13=1, A12=1, A1=0)
        if (isPlus3(this.model) && (port & 0xF002) === 0x3000) {
          this.fdc.writeData(val);
          this.activity.fdcAccesses++;
        }
      }

      // AY ports — 128K only (48K has no AY chip)
      if (is128kClass(this.model)) {
        // AY register select: port 0xFFFD (A15=1, A14=1, A1=0)
        if ((port & 0xC002) === 0xC000) {
          this.ay.selectedReg = val & 0x0F;
        }

        // AY data write: port 0xBFFD (A15=1, A14=0, A1=0)
        if ((port & 0xC002) === 0x8000) {
          this.ay.writeRegister(this.ay.selectedReg, val);
          this.activity.ayWrites++;
        }
      }
    };

    this.cpu.portInHandler = (port: number): number => {
      // ULA port: any port with bit 0 = 0
      if ((port & 0x01) === 0) {
        this.activity.ulaReads++;
        if (this.ula.tapeActive) this.activity.earReads++;
        return this.ula.readPort((port >> 8) & 0xFF);
      }

      // AY register read: port 0xFFFD — 128K only
      if (is128kClass(this.model) && (port & 0xC002) === 0xC000) {
        return this.ay.readRegister(this.ay.selectedReg);
      }

      // FDC ports (A13=1, A12=0/1, A1=0): 0x2FFD status, 0x3FFD data
      // +3: routed to uPD765A. +2A: chip absent, bus returns 0xFF.
      // FDC operates normally in both FDC and BIOS modes — un-trapped ROM
      // code (DD_LOGIN, DD_INIT, etc.) needs valid FDC responses. The BIOS
      // traps intercept DD_ routines before they reach the FDC hardware.
      if (isPlus2AClass(this.model)) {
        if ((port & 0xF002) === 0x2000) {
          if (!isPlus3(this.model)) return 0xFF;
          return this.fdc.readStatus();
        }
        if ((port & 0xF002) === 0x3000) {
          if (!isPlus3(this.model)) return 0xFF;
          this.activity.fdcAccesses++;
          return this.fdc.readData();
        }
      }

      // Kempston joystick: bits 5-7 of low byte all zero
      if ((port & 0x00E0) === 0) {
        this.activity.kempstonReads++;
        return this.kempstonState;
      }

      // Unattached port — return floating bus value (ULA VRAM data or 0xFF)
      return this.floatingBusRead();
    };
  }

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.memory.applyBanking();
    this.cpu.memory = this.memory.flat;
    this.setStatus('ROM loaded');
  }

  setBorderSize(mode: BorderMode): void {
    this.ula.setBorderMode(mode);
    this.display.resize(this.ula.screenWidth, this.ula.screenHeight);
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.ay.reset();
    this.ula.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.fdc.reset();
    this.biosTrap?.reset();
    this.memory.reset();
    this.cpu.memory = this.memory.flat;
    this.clearScreenGrid();
    this.kempstonState = 0;
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
    this.beeperDCPrev = 0;
    this.beeperDCOut = 0;
    this.prevBeeperBit = 0;
    this.frameStartTStates = 0;
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;

    await this.audio.init();

    // Check if stop() was called while we were awaiting
    if (!this.starting) return;
    this.starting = false;

    this.tStatesPerSample = Z80_CLOCK / this.audio.sampleRate;
    // DC-blocking filter: ~20Hz cutoff, same as AY core
    this.beeperDCAlpha = 1 - (2 * Math.PI * 20 / this.audio.sampleRate);

    this.running = true;
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
    this.rafId = requestAnimationFrame(this.frameLoop);
    this.setStatus('Running');
  }

  stop(): void {
    this.starting = false; // cancel pending async start
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  destroy(): void {
    this.stop();
    this.audio.destroy();
  }

  private frameLoop = (): void => {
    if (!this.running) return;

    // Wall-clock pacing: accumulate elapsed time, run frames at 50Hz
    const now = performance.now();
    if (this.turbo) {
      // Turbo: run as many frames as possible (target ~50MHz ≈ 14x)
      this.frameTimeAccum = FRAME_PERIOD * 14;
      let framesRun = 0;
      while (framesRun < 14) {
        this.runFrame();
        framesRun++;
      }
      this.lastFrameTime = now;
    } else {
      this.frameTimeAccum = Math.min(
        this.frameTimeAccum + (now - this.lastFrameTime),
        FRAME_PERIOD * 3 // cap catch-up to 3 frames (e.g. after tab hidden)
      );
      this.lastFrameTime = now;

      const audioPacing = this.audio.ctx !== null && this.audio.ctx.state === 'running';
      const targetSamples = samplesPerFrame(this.audio.sampleRate) * TARGET_BUFFER_FRAMES;

      let framesRun = 0;
      while (this.frameTimeAccum >= FRAME_PERIOD && framesRun < 2) {
        if (audioPacing && this.audio.bufferedSamples() >= targetSamples) break;
        this.runFrame();
        this.frameTimeAccum -= FRAME_PERIOD;
        framesRun++;
      }
    }

    // Always render display (even if we skipped emulation) so the screen stays up to date
    if (this.needsDisplay) {
      this.ula.renderFrame(this.memory.flat);
      this.display.updateTexture(this.ula.pixels);
      this.needsDisplay = false;
    }

    if (this.onFrame) this.onFrame();

    this.rafId = requestAnimationFrame(this.frameLoop);
  };

  /** True if the given address is in ULA-contended memory. */
  private isContended(addr: number): boolean {
    // 0x4000-0x7FFF is always contended (bank 5, the screen RAM)
    if (addr >= 0x4000 && addr < 0x8000) return true;
    // 128K: odd-numbered banks (1,3,5,7) paged at 0xC000 are contended
    if (is128kClass(this.model) && addr >= 0xC000) {
      return (this.memory.currentBank & 1) === 1;
    }
    return false;
  }

  /** Returns the contention delay (extra T-states) for the current beam position. */
  private contentionDelay(): number {
    const t = this.timing;
    const frameTStates = this.cpu.tStates - this.frameStartTStates;
    const offset = frameTStates - t.contentionStart;
    if (offset < 0) return 0;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= 192) return 0;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0;
    return CONTENTION_PATTERN[col & 7];
  }

  /**
   * Floating bus read: returns whatever the ULA is currently fetching from VRAM.
   * During active display, this is a pixel byte or attribute byte.
   * Outside active display, returns 0xFF.
   */
  private floatingBusRead(): number {
    const t = this.timing;
    const frameTStates = this.cpu.tStates - this.frameStartTStates;
    const offset = frameTStates - t.contentionStart;
    if (offset < 0) return 0xFF;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= 192) return 0xFF;
    const col = offset - line * t.tStatesPerLine;
    if (col >= 128) return 0xFF;

    // Each character cell takes 4 T-states: pixel fetch, attr fetch
    const charCol = (col >> 2) & 0x1F;
    const phase = col & 3;
    const mem = this.memory.flat;

    if (phase < 2) {
      // Pixel byte — use the Spectrum's peculiar bitmap addressing
      const y = line;
      const bitmapAddr = 0x4000 |
        ((y & 0xC0) << 5) |
        ((y & 0x07) << 8) |
        ((y & 0x38) << 2);
      return mem[bitmapAddr + charCol];
    } else {
      // Attribute byte
      const attrAddr = 0x5800 + ((line >> 3) << 5) + charCol;
      return mem[attrAddr];
    }
  }

  private runFrame(): void {
    // Reset activity counters for this frame
    this.activity.ulaReads = 0;
    this.activity.kempstonReads = 0;
    this.activity.beeperToggled = false;
    this.activity.ayWrites = 0;
    this.activity.tapeLoads = 0;
    this.activity.rst16Calls = 0;
    this.activity.fdcAccesses = 0;
    this.activity.earReads = 0;

    // Fire interrupt at frame start
    this.cpu.interrupt();

    // Run CPU for one frame's worth of T-states
    this.frameStartTStates = this.cpu.tStates;
    const frameEnd = this.cpu.tStates + this.timing.tStatesPerFrame;

    while (this.cpu.tStates < frameEnd) {
      const tBefore = this.cpu.tStates;

      // ROM routine activity detection
      if (this.cpu.pc === 0x0556) this.activity.tapeLoads++;
      if (this.cpu.pc === 0x0010) {
        this.activity.rst16Calls++;
        this.captureScreenChar(this.cpu.a);
      }
      // Screen grid maintenance — keep shadow copy in sync with ROM routines.
      // DF_SZ (0x5C6B) = number of lower-screen lines (usually 2).
      const pc = this.cpu.pc;
      if (pc === 0x0DAF) {
        // CL_ALL — clear entire display
        this.screenGrid.fill(' ');
      } else if (pc === 0x0D6E) {
        // CLS_LOWER — clear bottom DF_SZ lines only
        const dfSz = this.cpu.memory[0x5C6B] || 2;
        this.screenGrid.fill(' ', (24 - dfSz) * 32, 24 * 32);
      } else if (pc === 0x0DFE) {
        // CL_SC_ALL — scroll upper screen up one line
        const dfSz = this.cpu.memory[0x5C6B] || 2;
        const upperRows = 24 - dfSz;
        for (let i = 0; i < (upperRows - 1) * 32; i++) {
          this.screenGrid[i] = this.screenGrid[i + 32];
        }
        this.screenGrid.fill(' ', (upperRows - 1) * 32, upperRows * 32);
      } else if (pc === 0x0E00) {
        // CL_SCROLL — general scroll. Skip B=0x17 (handled by 0x0DFE above).
        const b = (this.cpu.bc >> 8) & 0xFF;
        if (b !== 0x17 && b > 0 && b <= 24) {
          const startRow = 24 - b;
          for (let i = startRow * 32; i < 23 * 32; i++) {
            this.screenGrid[i] = this.screenGrid[i + 32];
          }
          this.screenGrid.fill(' ', 23 * 32, 24 * 32);
        }
      }

      // Detect LDIR clearing screen memory (common non-ROM CLS pattern):
      //   LD HL,0x4000 / LD (HL),0 / LD DE,0x4001 / LD BC,0x17FF / LDIR
      // or LD DE,0x4000 / LD BC,0x1800 / LDIR
      if (this.cpu.memory[pc] === 0xED && this.cpu.memory[(pc + 1) & 0xFFFF] === 0xB0) {
        const de = this.cpu.de;
        if (de >= 0x4000 && de <= 0x4001 && this.cpu.bc >= 0x1700) {
          this.screenGrid.fill(' ');
        }
      }

      // ROM trap: intercept LD-BYTES for instant tape loading
      if (this.tape.loaded && !this.tape.paused && this.cpu.pc === 0x0556 && this.cpu.memory[0x0556] === 0x14) {
        this.trapTapeLoad();
        this.tape.skipBlock(); // advance player past the instant-loaded block
        this.cpu.tStates += 2168; // nominal T-states for trapped load
      } else if (this.diskMode === 'bios' && this.biosTrap &&
                 this.memory.currentROM === 2 && !this.memory.specialPaging &&
                 this.cpu.pc < 0x4000 &&
                 this.biosTrap.check(this.cpu.pc)) {
        this.activity.fdcAccesses++;
      } else if (this.cpu.halted) {
        // Advance to next sample boundary or frame end
        const toFrameEnd = frameEnd - this.cpu.tStates;
        const toNextSample = this.tStatesPerSample - this.beeperTStatesAccum;
        const skip = Math.min(toFrameEnd, toNextSample);
        const nops = Math.max(1, Math.ceil(skip / 4));
        this.cpu.tStates += nops * 4;
        this.cpu.r = (this.cpu.r & 0x80) | ((this.cpu.r + nops) & 0x7F);

        if (!this.cpu.iff1) {
          this.cpu.iff1 = true;
          this.cpu.iff2 = true;
        }
      } else {
        // Apply ULA contention delay if fetching from contended memory
        if (this.isContended(this.cpu.pc)) {
          this.cpu.tStates += this.contentionDelay();
        }
        this.cpu.step();
      }

      const elapsed = this.cpu.tStates - tBefore;

      // Advance tape playback and update ULA EAR bit
      if (this.tape.playing && !this.tape.paused) {
        this.tape.advance(elapsed);
        this.ula.tapeActive = true;
        this.ula.tapeEarBit = this.tape.earBit;
      } else {
        this.ula.tapeActive = false;
      }

      // Accumulate beeper duty for audio sample
      this.beeperAccum += this.ula.beeperBit * elapsed;
      this.beeperTStatesAccum += elapsed;

      // Generate audio samples when enough T-states have accumulated
      while (this.beeperTStatesAccum >= this.tStatesPerSample) {
        this.beeperTStatesAccum -= this.tStatesPerSample;

        const beeperDuty = this.beeperAccum / this.tStatesPerSample;
        // DC-blocking high-pass filter: y[n] = α(y[n-1] + x[n] - x[n-1])
        // Removes DC bias and 50Hz clicks from ROM port writes
        const beeperRaw = beeperDuty * 0.8;
        this.beeperDCOut = this.beeperDCAlpha * (this.beeperDCOut + beeperRaw - this.beeperDCPrev);
        this.beeperDCPrev = beeperRaw;
        const beeperOut = this.beeperDCOut;

        let left: number, right: number;
        if (is128kClass(this.model)) {
          const aySample = this.ay.generateSampleStereo();
          left = aySample.left + beeperOut;
          right = aySample.right + beeperOut;
        } else {
          left = beeperOut;
          right = beeperOut;
        }

        this.audio.pushSample(
          Math.max(-1, Math.min(1, left)),
          Math.max(-1, Math.min(1, right))
        );

        this.beeperAccum = 0;
      }
    }

    // Mark that we have a new frame to display
    this.needsDisplay = true;
  }

  loadTAP(data: Uint8Array): void {
    this.tape.load(data);
  }

  loadDisk(image: DskImage): void {
    this.fdc.insertDisk(image);
  }

  /**
   * ROM trap for LD-BYTES at 0x0556.
   * Intercepts the standard tape loading routine and transfers block data
   * directly into memory, giving instant loading.
   */
  private trapTapeLoad(): void {
    const cpu = this.cpu;

    // Expected flag byte is in A register
    const expectedFlag = cpu.a;
    // Carry flag: 1 = LOAD, 0 = VERIFY
    const isLoad = cpu.getFlag(Z80.FLAG_C);
    // IX = destination address, DE = byte count
    let dest = cpu.ix;
    let count = cpu.de;

    const block = this.tape.nextBlock();

    if (!block || block.flag !== expectedFlag) {
      // No block or flag mismatch — signal failure
      cpu.setFlag(Z80.FLAG_C, false);
    } else if (!isLoad) {
      // VERIFY mode — just set success without copying
      cpu.setFlag(Z80.FLAG_C, true);
    } else {
      // LOAD mode — copy block data into memory
      const len = Math.min(count, block.data.length);
      for (let i = 0; i < len; i++) {
        cpu.write8(dest, block.data[i]);
        dest = (dest + 1) & 0xFFFF;
      }
      count = 0;
      cpu.ix = dest;
      cpu.de = count;
      cpu.setFlag(Z80.FLAG_C, true);
    }

    // Pop return address (simulating RET from LD-BYTES)
    cpu.pc = cpu.pop16();
    // Re-enable interrupts (LD-BYTES runs with DI)
    cpu.iff1 = true;
    cpu.iff2 = true;
  }

  /** Capture a character from RST 16 (A register value) into the 32x24 screen grid. */
  private captureScreenChar(a: number): void {
    // Skip parameter bytes for control codes
    if (this.screenSkipCount > 0) {
      this.screenSkipCount--;
      return;
    }

    if (a === 0x0D) {
      // Carriage return — position change handled by ROM, no grid update needed
    } else if ((a >= 0x20 && a <= 0x7F) || a >= 0x80) {
      // Printable character — read print position from the active screen channel.
      // Upper screen (channel 'S') uses S_POSN at 0x5C88-89.
      // Lower screen (channel 'K') uses DFCCL at 0x5C86-87 — the display file
      // address directly encodes row/col via the Spectrum's interleaved layout.
      const mem = this.cpu.memory;
      const curchl = mem[0x5C51] | (mem[0x5C52] << 8);
      const isLower = curchl >= 0x5C00 && curchl < 0xFFFC && mem[curchl + 4] === 0x4B; // 'K'

      let actualCol: number, actualRow: number;
      if (isLower) {
        // Decode position from DFCCL display file address
        const dfccl = mem[0x5C86] | (mem[0x5C87] << 8);
        const rel = dfccl - 0x4000;
        const third = (rel >> 11) & 3;       // screen third (0-2)
        const rowInThird = (rel >> 5) & 7;   // character row within third
        actualRow = third * 8 + rowInThird;
        actualCol = rel & 0x1F;
      } else {
        const col = mem[0x5C88];   // S_POSN column (33 = leftmost, 2 = rightmost)
        const line = mem[0x5C89]; // S_POSN line (24 = top, 1 = bottom)
        actualCol = 33 - col;
        actualRow = 24 - line;
      }

      // When the K channel writes at column 0, the ROM has cleared and reset the
      // editing area — clear the grid rows from here downward so stale text is removed.
      if (isLower && actualCol === 0) {
        const dfSz = this.cpu.memory[0x5C6B] || 2;
        if (actualRow >= 24 - dfSz) {
          this.screenGrid.fill(' ', actualRow * 32, 24 * 32);
        }
      }

      if (actualCol >= 0 && actualCol <= 31 && actualRow >= 0 && actualRow <= 23) {
        let ch: string;
        if (a >= 0x80) {
          ch = SPECTRUM_CHARS[a - 0x80];
          // Tokens expand to multiple chars — only store first char in grid cell
          if (ch.length > 1) ch = ch[0];
        } else if (a === 0x5E) {
          ch = '\u2191'; // ↑ instead of ^
        } else if (a === 0x60) {
          ch = '\u00A3'; // £ instead of `
        } else if (a === 0x7F) {
          ch = '\u00A9'; // © instead of DEL
        } else {
          ch = String.fromCharCode(a);
        }
        this.screenGrid[actualRow * 32 + actualCol] = ch;
      }
    } else if (a <= 0x1F) {
      // Control codes — set skip count for parameter bytes
      // AT (0x16) and TAB (0x17) take 2 parameter bytes
      // INK (0x10), PAPER (0x11), FLASH (0x12), BRIGHT (0x13),
      // INVERSE (0x14), OVER (0x15) take 1 parameter byte
      if (a === 0x16 || a === 0x17) {
        this.screenSkipCount = 2;
      } else if (a >= 0x10 && a <= 0x15) {
        this.screenSkipCount = 1;
      }
    }
  }

  getScreenText(): string {
    const lines: string[] = [];
    for (let row = 0; row < 24; row++) {
      const offset = row * 32;
      let line = '';
      for (let col = 0; col < 32; col++) {
        line += this.screenGrid[offset + col];
      }
      lines.push(line.trimEnd());
    }
    return lines.join('\n');
  }

  clearScreenGrid(): void {
    this.screenGrid.fill(' ');
    this.screenSkipCount = 0;
  }

  /**
   * OCR fallback: compare each 8×8 screen cell against the CHARS character set.
   * Returns a 32×24 text string (with newlines) of recognised characters.
   */
  ocrScreen(): string {
    const mem = this.cpu.memory;
    const chars = mem[0x5C36] | (mem[0x5C37] << 8);
    let text = '';

    for (let charRow = 0; charRow < 24; charRow++) {
      const third = charRow >> 3;
      const rowInThird = charRow & 7;

      for (let charCol = 0; charCol < 32; charCol++) {
        const base = 0x4000 + (third << 11) + (rowInThird << 5) + charCol;

        // Fast path: all-zero cell → space
        const b0 = mem[base];
        if (b0 === 0) {
          let allZero = true;
          for (let p = 1; p < 8; p++) {
            if (mem[base + (p << 8)] !== 0) { allZero = false; break; }
          }
          if (allZero) { text += ' '; continue; }
        }

        // Compare against CHARS (codes 33-127, space already handled)
        let ch = '';
        for (let c = 33; c < 128; c++) {
          const cb = chars + (c << 3);
          let match = true;
          for (let p = 0; p < 8; p++) {
            if (mem[base + (p << 8)] !== mem[cb + p]) { match = false; break; }
          }
          if (match) {
            ch = c === 0x5E ? '\u2191' : c === 0x60 ? '\u00A3' : c === 0x7F ? '\u00A9'
               : String.fromCharCode(c);
            break;
          }
        }

        // Try inverted match (INVERSE video)
        if (!ch) {
          for (let c = 33; c < 128; c++) {
            const cb = chars + (c << 3);
            let match = true;
            for (let p = 0; p < 8; p++) {
              if (mem[base + (p << 8)] !== (mem[cb + p] ^ 0xFF)) { match = false; break; }
            }
            if (match) {
              ch = c === 0x5E ? '\u2191' : c === 0x60 ? '\u00A3' : c === 0x7F ? '\u00A9'
                 : String.fromCharCode(c);
              break;
            }
          }
        }

        text += ch || ' ';
      }

      if (charRow < 23) text += '\n';
    }

    return text;
  }

  private setStatus(msg: string): void {
    if (this.onStatus) this.onStatus(msg);
  }
}
