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
import { disasmOne, stripMarkers } from './z80-disasm.ts';
import { AY3891x } from './cores/ay-3-8910.ts';
import { SpectrumMemory } from './memory.ts';
import { ULA, SCREEN_WIDTH, SCREEN_HEIGHT, type BorderMode } from './ula.ts';
import { SpectrumKeyboard } from './keyboard.ts';
import { Display } from './display.ts';
import { Audio } from './audio.ts';
import { TapeDeck } from './formats/tap.ts';
import { UPD765A } from './cores/upd765a.ts';
import { Plus3DosTrap } from './plus3/plus3dos-trap.ts';
import type { DskImage } from './formats/dsk.ts';
import { Contention } from './contention.ts';
import { ScreenText } from './screen-text.ts';
import { trapTapeLoad } from './tape-loader.ts';
import { installMemoryHooks, wirePortIO } from './io-ports.ts';

const Z80_CLOCK = 3500000;       // 3.5 MHz
const AY_CLOCK = 1773400;        // ~1.77 MHz

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
  /** Number of VRAM writes logged for sub-frame rendering this frame */
  subFrameVramWrites: number;
  /** Number of border color changes logged for sub-frame rendering this frame */
  subFrameBorderChanges: number;
}

export class Spectrum {
  model: SpectrumModel;
  memory: SpectrumMemory;
  cpu: Z80;
  ay: AY3891x;
  ula: ULA;
  keyboard: SpectrumKeyboard;
  display: Display | null;
  audio: Audio;
  tape: TapeDeck;
  fdc: UPD765A;
  contention: Contention;
  screenText: ScreenText;

  /** Disk access mode: 'fdc' = full FDC emulation, 'bios' = +3DOS BIOS traps */
  diskMode: 'fdc' | 'bios' = 'fdc';
  biosTrap: Plus3DosTrap | null = null;

  /** Per-frame I/O activity counters */
  activity: IOActivity = { ulaReads: 0, kempstonReads: 0, beeperToggled: false, ayWrites: 0, tapeLoads: 0, rst16Calls: 0, fdcAccesses: 0, earReads: 0, subFrameVramWrites: 0, subFrameBorderChanges: 0 };

  /** Kempston joystick state (bits: 0=right,1=left,2=down,3=up,4=fire) */
  kempstonState = 0;

  /** 32x24 character grid mirroring what RST 16 prints to the display */
  get screenGrid(): string[] { return this.screenText.screenGrid; }

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

  /** Previous beeper state for toggle detection (accessed by io-ports.ts) */
  prevBeeperBit = 0;

  /** Whether at least one frame has rendered (for display) */
  private needsDisplay = true;

  /** Wall-clock frame pacing (governs speed regardless of rAF rate) */
  private lastFrameTime = 0;
  private frameTimeAccum = 0;

  get tStatesPerFrame(): number { return this.contention.timing.tStatesPerFrame; }

  /** Turbo mode: run ~14x frames per rAF for ~50MHz effective speed */
  turbo = false;

  /** Sub-frame precision rendering: per-scanline rendering for rainbow effects */
  subFrameRendering = false;

  /** Sub-frame state: border color changes logged this frame as [frameTState, color] */
  borderChanges: [number, number][] = [];
  /** Sub-frame state: border color at frame start */
  private frameStartBorderColor = 0;
  /** Sub-frame state: VRAM snapshot taken at frame start (6912 bytes: 0x4000-0x5AFF) */
  private vramShadow = new Uint8Array(6912);
  /** Sub-frame state: logged VRAM writes — T-states, offsets within shadow, values */
  private vramWriteTs = new Int32Array(8192);
  private vramWriteOff = new Uint16Array(8192);
  private vramWriteVal = new Uint8Array(8192);
  private vramWriteCount = 0;
  /** Execution trace */
  private _tracing = false;
  private _traceMode: 'full' | 'contention' | 'portio' = 'full';
  private _traceBuffer: string[] = [];
  /** Loop detection (full mode): direct-mapped cache of PC → register hash */
  private _traceLoopPC = new Int32Array(1024).fill(-1);
  private _traceLoopHash = new Int32Array(1024);
  private _traceLoopAddr = -1;
  private _traceLoopCount = 0;
  /** Port IO tally (portio mode) */
  private _portTallyIn: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }> | null = null;
  private _portTallyOut: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }> | null = null;

  /** Breakpoints (checked every instruction in runFrame) */
  breakpoints = new Set<number>();
  /** Set to the hit address when a breakpoint fires mid-frame */
  breakpointHit = -1;

  /** Status callback */
  onStatus: ((msg: string) => void) | null = null;

  /** Frame callback (fires each rAF after rendering) */
  onFrame: (() => void) | null = null;

  constructor(model: SpectrumModel, canvas?: HTMLCanvasElement | null) {
    this.model = model;

    this.memory = new SpectrumMemory(model);
    this.cpu = new Z80(this.memory.flat);
    this.ay = new AY3891x(AY_CLOCK, 44100, 'ABC');
    this.keyboard = new SpectrumKeyboard();
    this.ula = new ULA(this.keyboard);
    this.display = canvas ? new Display(canvas, SCREEN_WIDTH, SCREEN_HEIGHT) : null;
    this.audio = new Audio();
    this.tape = new TapeDeck();
    this.fdc = new UPD765A();
    this.contention = new Contention(model, this.memory);
    this.screenText = new ScreenText();

    this.tStatesPerSample = Z80_CLOCK / 44100;

    if (isPlus3(model)) {
      this.biosTrap = new Plus3DosTrap(this.cpu, this.memory, this.fdc);
    }

    installMemoryHooks(this);
    wirePortIO(this);
  }

  /** Trace state accessors for io-ports.ts */
  get tracing(): boolean { return this._tracing; }
  get traceMode(): 'full' | 'contention' | 'portio' { return this._traceMode; }

  /** Log a VRAM write for sub-frame rendering replay (called from io-ports.ts write8 hook). */
  logVRAMWrite(addr: number, val: number): void {
    const i = this.vramWriteCount;
    if (i < 8192) {
      this.vramWriteTs[i] = this.cpu.tStates - this.contention.frameStartTStates;
      this.vramWriteOff[i] = addr - 0x4000;
      this.vramWriteVal[i] = val & 0xFF;
      this.vramWriteCount++;
    }
  }

  /** Log a port access for trace modes (called from io-ports.ts). */
  logPortAccess(dir: string, port: number, val: number): void {
    const h8 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    const h16 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
    const pc = this.cpu.pc;

    if (this._traceMode === 'portio') {
      const tally = dir === 'IN' ? this._portTallyIn! : this._portTallyOut!;
      let entry = tally.get(port);
      if (!entry) {
        entry = { count: 0, pcs: new Set(), vals: new Set() };
        tally.set(port, entry);
      }
      entry.count++;
      if (entry.pcs.size < 32) entry.pcs.add(pc);
      if (entry.vals.size < 64) entry.vals.add(val);
      return;
    } else if (this._traceMode === 'contention' && pc >= 0x4000) {
      const frameTStates = this.cpu.tStates - this.contention.frameStartTStates;
      const line = ((frameTStates - this.contention.timing.contentionStart) / this.contention.timing.tStatesPerLine) | 0;
      const contended = this.contention.isContended(pc);
      const isULA = (port & 1) === 0;
      const label = this.portLabel(port);
      // Log ULA reads from contended memory (contention probes) and
      // reads from unrecognised ports (potential floating bus reads)
      if (dir === 'IN' && (contended || !label)) {
        const tag = isULA && contended ? ' (contention probe)' :
                    !label ? ` (floating bus? ${val === 0xFF ? 'idle' : 'VRAM'})` : '';
        this._traceBuffer.push(
          `${h16(pc)}  IN port=${h16(port)} val=${h8(val)} fT=${frameTStates} line=${line}${tag}`
        );
      }
    }
    if (this._traceBuffer.length >= 500_000) this._tracing = false;
  }

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.memory.applyBanking();
    this.cpu.memory = this.memory.flat;
    this.setStatus('ROM loaded');
  }

  setBorderSize(mode: BorderMode): void {
    this.ula.setBorderMode(mode);
    if (this.display) this.display.resize(this.ula.screenWidth, this.ula.screenHeight);
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
    this.screenText.clear();
    this.kempstonState = 0;
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
    this.beeperDCPrev = 0;
    this.beeperDCOut = 0;
    this.prevBeeperBit = 0;
    this.contention.frameStartTStates = 0;
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

  /** Run one frame (for headless / test harness use). */
  tick(): void { this.breakpointHit = -1; this.runFrame(); }

  /**
   * Run up to `maxFrames` frames, stopping early if a breakpoint is hit.
   * Returns the number of frames actually executed.
   */
  runUntil(maxFrames: number): number {
    this.breakpointHit = -1;
    for (let i = 0; i < maxFrames; i++) {
      this.runFrame();
      if (this.breakpointHit >= 0) return i + 1;
    }
    return maxFrames;
  }

  private frameLoop = (): void => {
    if (!this.running) return;

    // Wall-clock pacing: accumulate elapsed time, run frames at 50Hz
    this.breakpointHit = -1;
    const now = performance.now();
    if (this.turbo) {
      // Turbo: run as many frames as possible (target ~50MHz ≈ 14x)
      this.frameTimeAccum = FRAME_PERIOD * 14;
      let framesRun = 0;
      while (framesRun < 14) {
        this.runFrame();
        framesRun++;
        if (this.breakpointHit >= 0) break;
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
        if (this.breakpointHit >= 0) break;
      }
    }

    // Always render display (even if we skipped emulation) so the screen stays up to date
    if (this.needsDisplay) {
      if (!this.subFrameRendering) {
        this.ula.renderFrame(this.memory.flat);
      }
      if (this.display) this.display.updateTexture(this.ula.pixels);
      this.needsDisplay = false;
    }

    if (this.onFrame) this.onFrame();

    this.rafId = requestAnimationFrame(this.frameLoop);
  };

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

    // Frame starts when INT fires — mark the reference point BEFORE the CPU
    // responds, so interrupt-response T-states count as part of the frame.
    // This keeps contention phase, sub-frame scanline boundaries, and floating
    // bus reads aligned with real ULA timing.
    this.contention.frameStartTStates = this.cpu.tStates;
    const frameEnd = this.cpu.tStates + this.contention.timing.tStatesPerFrame;

    // Fire interrupt (IM 1 = 13T, IM 2 = 19T — consumed from the frame budget)
    this.cpu.interrupt();

    // Sub-frame rendering: snapshot VRAM and prepare write log
    const subFrame = this.subFrameRendering;
    if (subFrame) {
      this.vramShadow.set(this.memory.flat.subarray(0x4000, 0x5B00));
      this.vramWriteCount = 0;
      this.borderChanges.length = 0;
      this.frameStartBorderColor = this.ula.borderColor;
      this.ula.advanceFlash();
    }

    while (this.cpu.tStates < frameEnd) {
      const tBefore = this.cpu.tStates;

      // ROM routine activity detection
      if (this.cpu.pc === 0x0556) this.activity.tapeLoads++;
      if (this.cpu.pc === 0x0010) {
        this.activity.rst16Calls++;
        this.screenText.captureChar(this.cpu.a, this.cpu.memory);
      }
      // Screen grid maintenance — keep shadow copy in sync with ROM routines.
      const pc = this.cpu.pc;
      this.screenText.checkROMRoutines(pc, this.cpu.memory, this.cpu.bc);
      this.screenText.checkLDIRClear(pc, this.cpu.memory, this.cpu.de, this.cpu.bc);

      // ROM trap: intercept LD-BYTES for instant tape loading
      if (this.tape.loaded && !this.tape.paused && this.cpu.pc === 0x0556 && this.cpu.memory[0x0556] === 0x14) {
        trapTapeLoad(this.cpu, this.tape);
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
        // Breakpoint check (skipped when set is empty for zero overhead)
        if (this.breakpoints.size > 0 && this.breakpoints.has(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          break;
        }
        if (this._tracing && this._traceMode === 'full' && this.cpu.pc >= 0x4000) this.captureTraceLine();
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

    // Sub-frame rendering: replay VRAM writes per-scanline and render full frame
    if (subFrame) this.renderSubFrame();

    // Mark that we have a new frame to display
    this.needsDisplay = true;
  }

  /**
   * Sub-frame: render the full frame at frame end by replaying logged VRAM
   * writes in T-state order.  Each display scanline sees the VRAM state that
   * the real ULA would have read when the beam reached that line.
   */
  private renderSubFrame(): void {
    const shadow = this.vramShadow;
    const borderTop = this.ula['borderTop'] as number;
    const tpl = this.contention.timing.tStatesPerLine;
    const cStart = this.contention.timing.contentionStart;
    const screenHeight = this.ula.screenHeight;

    let writeIdx = 0;
    const writeCount = this.vramWriteCount;
    let borderIdx = 0;
    let currentBorder = this.frameStartBorderColor;

    // Expose stats in activity counters
    this.activity.subFrameVramWrites = writeCount;
    this.activity.subFrameBorderChanges = this.borderChanges.length;

    // Top border — each row gets its own border color
    for (let r = 0; r < borderTop; r++) {
      const rowTState = Math.max(0, cStart - (borderTop - r) * tpl);
      while (borderIdx < this.borderChanges.length && this.borderChanges[borderIdx][0] <= rowTState) {
        currentBorder = this.borderChanges[borderIdx][1];
        borderIdx++;
      }
      this.ula.renderBorderLine(r, currentBorder);
    }

    // Display lines 0..191 — replay VRAM writes up to each line's scan time
    for (let y = 0; y < 192; y++) {
      const lineTState = cStart + y * tpl;
      // Apply all VRAM writes that happened before this line was scanned
      while (writeIdx < writeCount && this.vramWriteTs[writeIdx] < lineTState) {
        shadow[this.vramWriteOff[writeIdx]] = this.vramWriteVal[writeIdx];
        writeIdx++;
      }
      // Advance border color
      while (borderIdx < this.borderChanges.length && this.borderChanges[borderIdx][0] <= lineTState) {
        currentBorder = this.borderChanges[borderIdx][1];
        borderIdx++;
      }
      this.ula.renderScanline(y, shadow, currentBorder, 0x4000);
    }

    // Bottom border
    const bottomStart = borderTop + 192;
    for (let r = bottomStart; r < screenHeight; r++) {
      const rowTState = cStart + (192 + r - bottomStart) * tpl;
      while (borderIdx < this.borderChanges.length && this.borderChanges[borderIdx][0] <= rowTState) {
        currentBorder = this.borderChanges[borderIdx][1];
        borderIdx++;
      }
      this.ula.renderBorderLine(r, currentBorder);
    }
  }

  loadTAP(data: Uint8Array): void {
    this.tape.load(data);
  }

  loadDisk(image: DskImage): void {
    this.fdc.insertDisk(image);
  }

  getScreenText(): string {
    return this.screenText.getText();
  }

  clearScreenGrid(): void {
    this.screenText.clear();
  }

  ocrScreen(): string {
    return this.screenText.ocr(this.cpu.memory);
  }

  startTrace(mode: 'full' | 'contention' | 'portio' = 'full'): void {
    this._traceBuffer = [];
    this._traceMode = mode;
    this._traceLoopPC.fill(-1);
    this._traceLoopHash.fill(0);
    this._traceLoopAddr = -1;
    this._traceLoopCount = 0;
    if (mode === 'portio') {
      this._portTallyIn = new Map();
      this._portTallyOut = new Map();
    }
    this._tracing = true;
  }

  stopTrace(): string {
    this._tracing = false;
    if (this._traceMode === 'portio') return this.formatPortTally();
    if (this._traceLoopCount > 0) {
      const h = this._traceLoopAddr.toString(16).toUpperCase().padStart(4, '0');
      this._traceBuffer.push(`      ... loops back to ${h} x${this._traceLoopCount}`);
    }
    return this._traceBuffer.join('\n');
  }

  private captureTraceLine(): void {
    const cpu = this.cpu;
    const pc = cpu.pc;

    // Loop detection: hash key registers and compare against cache
    const slot = pc & 0x3FF;
    const hash = ((cpu.a << 24) | (cpu.f << 16) | cpu.bc) ^ ((cpu.de << 16) | cpu.hl);

    if (this._traceLoopPC[slot] === pc && this._traceLoopHash[slot] === hash) {
      // Same PC, same register state — suppress duplicate iteration
      if (this._traceLoopCount === 0) this._traceLoopAddr = pc;
      this._traceLoopCount++;
      return;
    }

    // Flush any accumulated loop marker
    if (this._traceLoopCount > 0) {
      const h = this._traceLoopAddr.toString(16).toUpperCase().padStart(4, '0');
      this._traceBuffer.push(`      ... loops back to ${h} x${this._traceLoopCount}`);
      this._traceLoopCount = 0;
    }

    // Update cache
    this._traceLoopPC[slot] = pc;
    this._traceLoopHash[slot] = hash;

    // Record trace line
    const mem = cpu.memory;
    const line = disasmOne(mem, pc);
    const mnem = stripMarkers(line.text);
    const ctx = this.traceCtx(pc);
    const addr = pc.toString(16).toUpperCase().padStart(4, '0');
    this._traceBuffer.push(ctx
      ? `${addr}  ${mnem.padEnd(24)} ${ctx}`
      : `${addr}  ${mnem}`);
    if (this._traceBuffer.length >= 500_000) this._tracing = false;
  }

  private traceCtx(pc: number): string {
    const cpu = this.cpu;
    const mem = cpu.memory;
    const h8 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    const h16 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

    let op = mem[pc];

    // DD/FD prefix → IX/IY memory access
    if (op === 0xDD || op === 0xFD) {
      const ixr = op === 0xDD ? cpu.ix : cpu.iy;
      const op2 = mem[(pc + 1) & 0xFFFF];
      if (op2 === 0xCB) {
        const d = mem[(pc + 2) & 0xFFFF];
        const addr = (ixr + (d < 128 ? d : d - 256)) & 0xFFFF;
        return `(${h16(addr)})=${h8(mem[addr])}`;
      }
      if (op2 === 0xED || op2 === 0xDD || op2 === 0xFD) return '';
      const x = (op2 >> 6) & 3, y = (op2 >> 3) & 7, z = op2 & 7;
      if ((x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) ||
          (x === 2 && z === 6) ||
          (x === 0 && (z === 4 || z === 5) && y === 6) ||
          op2 === 0x36) {
        const d = mem[(pc + 2) & 0xFFFF];
        const addr = (ixr + (d < 128 ? d : d - 256)) & 0xFFFF;
        if (x === 2) return `A=${h8(cpu.a)} (${h16(addr)})=${h8(mem[addr])}`;
        return `(${h16(addr)})=${h8(mem[addr])}`;
      }
      return '';
    }

    // CB: bit ops on (HL)
    if (op === 0xCB) {
      if ((mem[(pc + 1) & 0xFFFF] & 7) === 6) return `(${h16(cpu.hl)})=${h8(mem[cpu.hl])}`;
      return '';
    }

    // ED prefix
    if (op === 0xED) {
      const ed = mem[(pc + 1) & 0xFFFF];
      const x = (ed >> 6) & 3, y = (ed >> 3) & 7, z = ed & 7;
      if (x === 1 && (z === 0 || z === 1)) return `port=${h16(cpu.bc)}`;
      if (x === 2 && y >= 4 && z < 4) return `HL=${h16(cpu.hl)} DE=${h16(cpu.de)} BC=${h16(cpu.bc)}`;
      return '';
    }

    // Main table
    const x = (op >> 6) & 3, y = (op >> 3) & 7, z = op & 7;
    const p = (y >> 1) & 3, q = y & 1;

    if (x === 0) {
      if (z === 0 && y === 2) return `B=${h8((cpu.bc >> 8) & 0xFF)}`; // DJNZ
      if (z === 0 && y >= 4) return cpu.checkCondition(y - 4) ? 'taken' : '--'; // JR cc
      if (z === 2) {
        if (q === 0 && p <= 1) return `A=${h8(cpu.a)}→(${h16(p === 0 ? cpu.bc : cpu.de)})`;
        if (q === 1 && p === 0) return `(${h16(cpu.bc)})=${h8(mem[cpu.bc & 0xFFFF])}`;
        if (q === 1 && p === 1) return `(${h16(cpu.de)})=${h8(mem[cpu.de & 0xFFFF])}`;
      }
      if ((z === 4 || z === 5) && y === 6) return `(${h16(cpu.hl)})=${h8(mem[cpu.hl & 0xFFFF])}`;
    }

    if (x === 1) {
      if (y === 6 && z !== 6) return `${h8(cpu.getReg8(z))}→(${h16(cpu.hl)})`;
      if (z === 6 && y !== 6) return `(${h16(cpu.hl)})=${h8(mem[cpu.hl & 0xFFFF])}`;
    }

    if (x === 2) {
      if (z === 6) return `A=${h8(cpu.a)} (${h16(cpu.hl)})=${h8(mem[cpu.hl & 0xFFFF])}`;
      return `A=${h8(cpu.a)}`;
    }

    if (x === 3) {
      if (z === 0) return cpu.checkCondition(y) ? 'taken' : '--'; // RET cc
      if (z === 2) return cpu.checkCondition(y) ? 'taken' : '--'; // JP cc
      if (z === 4) return cpu.checkCondition(y) ? 'taken' : '--'; // CALL cc
      if (z === 6) return `A=${h8(cpu.a)}`; // ALU A,n
      if (z === 3 && y === 2) return `A=${h8(cpu.a)}`; // OUT (n),A
    }

    return '';
  }

  private portLabel(port: number): string {
    if ((port & 1) === 0) return 'ULA';
    if ((port & 0x00E0) === 0) return 'Kemp';
    if (is128kClass(this.model)) {
      if ((port & 0xC002) === 0xC000) return 'AY';
      if ((port & 0xC002) === 0x8000) return 'AY';
      if (isPlus2AClass(this.model)) {
        if ((port & 0xC002) === 0x4000) return '7FFD';
        if ((port & 0xF002) === 0x1000) return '1FFD';
        if ((port & 0xF002) === 0x2000) return 'FDC';
        if ((port & 0xF002) === 0x3000) return 'FDC';
      } else {
        if ((port & 0x8002) === 0) return '7FFD';
      }
    }
    return '';
  }

  private formatPortTally(): string {
    const h8 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    const h16 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

    const formatSection = (title: string, tally: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }>) => {
      if (!tally.size) return '';
      const entries = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
      const lines = [`${title}:`];
      for (const [port, info] of entries) {
        const label = (this.portLabel(port) || '').padEnd(6);
        const pcs = [...info.pcs].map(h16).join(',');
        const vals = [...info.vals].map(h8).join(',');
        lines.push(`  ${h16(port)}  ${String(info.count).padStart(8)}x  ${label} from ${pcs}  vals ${vals}`);
      }
      return lines.join('\n');
    };

    const parts = ['=== Port IO Summary ===', ''];
    const inSection = formatSection('IN', this._portTallyIn!);
    const outSection = formatSection('OUT', this._portTallyOut!);
    if (inSection) parts.push(inSection, '');
    if (outSection) parts.push(outSection, '');
    this._portTallyIn = null;
    this._portTallyOut = null;
    return parts.join('\n');
  }

  private setStatus(msg: string): void {
    if (this.onStatus) this.onStatus(msg);
  }
}
