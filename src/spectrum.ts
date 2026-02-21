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

import { Z80 } from '@/cores/Z80.ts';
import { disasmOne, stripMarkers } from '@/debug/z80-disasm.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { SpectrumMemory } from '@/memory.ts';
import { ULA, SCREEN_WIDTH, SCREEN_HEIGHT, type BorderMode } from '@/cores/ula.ts';
import { SpectrumKeyboard } from '@/keyboard.ts';
import { WebGLRenderer } from '@/display/webgl-renderer.ts';
import { CanvasRenderer } from '@/display/canvas-renderer.ts';
import type { IScreenRenderer } from '@/display/display.ts';
import { Audio } from '@/audio.ts';
import { TapeDeck } from '@/tape/tap.ts';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage } from '@/plus3/dsk.ts';
import { Contention } from '@/contention.ts';
import { ScreenText } from '@/debug/screen-text.ts';
import type { FontSource, OcrResult } from '@/debug/screen-text.ts';
import { trapTapeLoad } from '@/tape/tape-loader.ts';
import { LoaderDetector } from '@/tape/loader-detect.ts';
import { installMemoryHooks, wirePortIO } from '@/io-ports.ts';
import { KempstonJoystick } from '@/peripherals/joysticks.ts';
import { KempstonMouse } from '@/peripherals/kempston-mouse.ts';
import { AmxMouse } from '@/peripherals/amx-mouse.ts';
import { AudioMixer } from '@/peripherals/audio-mixer.ts';
import { Multiface } from '@/peripherals/multiface.ts';

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
  /** Number of FDC data port accesses this frame */
  fdcAccesses: number;
  /** Number of ULA reads while tape is active (EAR sampling) */
  earReads: number;
  /** Number of attribute-area (5800-5AFF) writes this frame */
  attrWrites: number;
  /** Number of Kempston mouse port reads this frame */
  mouseReads: number;
}

export class Spectrum {
  model: SpectrumModel;
  memory: SpectrumMemory;
  cpu: Z80;
  ay: AY3891x;
  ula: ULA;
  keyboard: SpectrumKeyboard;
  display: IScreenRenderer | null;
  audio: Audio;
  tape: TapeDeck;
  fdc: UPD765A;
  contention: Contention;
  screenText = new ScreenText();

  /** Per-frame I/O activity counters */
  activity: IOActivity = { ulaReads: 0, kempstonReads: 0, beeperToggled: false, ayWrites: 0, tapeLoads: 0, fdcAccesses: 0, earReads: 0, attrWrites: 0, mouseReads: 0 };

  /** Kempston joystick peripheral */
  joystick = new KempstonJoystick();

  /** Kempston mouse peripheral */
  kempstonMouse = new KempstonMouse();

  /** AMX mouse peripheral */
  amxMouse = new AmxMouse();

  /** Audio mixer peripheral (beeper + AY mixing, DC filter) */
  mixer!: AudioMixer;

  /** Multiface peripheral (MF1/MF128/MF3) */
  multiface = new Multiface();

  private running = false;
  private starting = false;
  private startGen = 0;
  private rafId = 0;

  /** Whether at least one frame has rendered (for display) */
  private needsDisplay = true;

  /** Wall-clock frame pacing (governs speed regardless of rAF rate) */
  private lastFrameTime = 0;
  private frameTimeAccum = 0;

  get tStatesPerFrame(): number { return this.contention.timing.tStatesPerFrame; }

  /** Turbo mode: run ~14x frames per rAF for ~50MHz effective speed */
  turbo = false;

  /** Scanline rendering state */
  private nextRenderLine = 0;
  private nextRenderT = 0;
  private nextPixelX = 0;
  private nextDisplayCol = 0;  // next unrendered display cell (0..32) on current line
  private totalRenderLines = 0;
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

  /** Loader detection: auto-start tape based on edge-detection loop patterns */
  loaderDetector = new LoaderDetector();

  /** T-state at which the tape was last advanced (for sub-instruction accuracy) */
  tapeLastAdvanceT = 0;

  /** ROM trap instant load: intercept LD-BYTES at 0x0556 and copy block
   *  data directly into memory.  Works for standard TAP/TZX data blocks. */
  tapeInstantLoad = true;

  /** Tape turbo: auto-engage maximum emulation speed while a custom
   *  loader is actively reading the EAR port.  Disengages after a cooldown
   *  when EAR reads stop (loading finished). */
  tapeTurbo = true;

  /** Whether tape loading sounds are mixed into audio output */
  tapeSoundEnabled = true;

  /** Internal: whether tape turbo is currently engaged */
  private _tapeTurboActive = false;
  /** Frames remaining before tape turbo disengages (cooldown) */
  private _tapeTurboCooldown = 0;

  /** Persistent interrupt-pending flag (see timings.md § intPending Mechanism).
   *  Set when INT fires but IFF1 is false (DI active). Cleared when the
   *  pending interrupt is accepted or a new frame fires normally. */
  private _intPending = false;

  /** Breakpoints (checked every instruction in runFrame) */
  breakpoints = new Set<number>();
  /** Set to the hit address when a breakpoint fires mid-frame */
  breakpointHit = -1;

  /** Status callback */
  onStatus: ((msg: string) => void) | null = null;

  /** Frame callback (fires each rAF after rendering) */
  onFrame: (() => void) | null = null;

  constructor(model: SpectrumModel, canvas?: HTMLCanvasElement | null, renderer?: 'webgl' | 'canvas') {
    this.model = model;

    this.memory = new SpectrumMemory(model);
    this.cpu = new Z80(this.memory.flat);
    this.ay = new AY3891x(AY_CLOCK, 44100, 'ABC');
    this.keyboard = new SpectrumKeyboard();
    this.ula = new ULA(this.keyboard);
    this.display = canvas
      ? (renderer === 'canvas'
        ? new CanvasRenderer(canvas, SCREEN_WIDTH, SCREEN_HEIGHT)
        : new WebGLRenderer(canvas, SCREEN_WIDTH, SCREEN_HEIGHT))
      : null;
    this.audio = new Audio();
    this.contention = new Contention(model, this.memory);
    this.mixer = new AudioMixer(this.contention.timing.cpuClock);
    this.tape = new TapeDeck();
    this.tape.is48K = model === '48k';
    this.tape.cpuClock = this.contention.timing.cpuClock;
    this.fdc = new UPD765A();
    installMemoryHooks(this);
    wirePortIO(this);
  }

  /** Trace state accessors for io-ports.ts */
  get tracing(): boolean { return this._tracing; }
  get traceMode(): 'full' | 'contention' | 'portio' { return this._traceMode; }

  /** Flush pending pixels up to the current beam position.
   *  Called from the port handler BEFORE updating borderColor so that
   *  pixels between the last render and the port write keep the old color,
   *  and from the write8 hook before VRAM writes so completed scanlines
   *  see the old data. */
  flushBeam(): void {
    this.renderPendingScanlines();
  }

  /**
   * Advance the tape to the current cpu.tStates and update the ULA EAR bit.
   * Called from the port-in handler (for sub-instruction accuracy) and from
   * the main loop (to catch up after each instruction).
   */
  advanceTapeTo(): void {
    if (!this.tape.playing || this.tape.paused) {
      this.ula.tapeActive = false;
      return;
    }
    const delta = this.cpu.tStates - this.tapeLastAdvanceT;
    if (delta > 0) {
      this.tape.advance(delta);
      this.tapeLastAdvanceT = this.cpu.tStates;
    }
    this.ula.tapeActive = true;
    this.ula.tapeEarBit = this.tape.earBit;
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
    this.memory.reset();
    this.cpu.memory = this.memory.flat;
    this.joystick.reset();
    this.kempstonMouse.reset();
    this.amxMouse.reset();
    this.mixer.reset();
    this.multiface.reset();
    this.loaderDetector.reset();
    this.contention.frameStartTStates = 0;
    this._intPending = false;
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    const gen = ++this.startGen;

    await this.audio.init();

    // Check if stop() was called or a newer start() was issued while we were awaiting
    if (!this.starting || gen !== this.startGen) return;
    this.starting = false;

    this.mixer.init(this.audio.sampleRate);

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

  /** Whether tape turbo is currently engaged (read by UI for status) */
  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  private frameLoop = (): void => {
    if (!this.running) return;

    // Wall-clock pacing: accumulate elapsed time, run frames at 50Hz
    this.breakpointHit = -1;
    const now = performance.now();
    if (this.turbo || this._tapeTurboActive) {
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

    // Push rendered pixels to the display
    if (this.needsDisplay) {
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
    this.activity.fdcAccesses = 0;
    this.activity.earReads = 0;
    this.activity.attrWrites = 0;
    this.activity.mouseReads = 0;
    // The ULA's frame boundary occurs at exact tStatesPerFrame intervals,
    // regardless of CPU instruction overshoot from the previous frame.
    // On real hardware the beam resets at fixed intervals; the CPU may still
    // be finishing an instruction from the previous frame, but the ULA doesn't
    // wait.  Using the ideal boundary (not cpu.tStates) keeps scanline timing
    // stable and prevents the overshoot from shifting border effects.
    const tpf = this.contention.timing.tStatesPerFrame;
    const idealStart = this.contention.frameStartTStates + tpf;
    // Use ideal boundary if the CPU has reached it (normal case).
    // Otherwise re-sync to current tStates (first frame, snapshot load, reset).
    this.contention.frameStartTStates =
      idealStart <= this.cpu.tStates ? idealStart : this.cpu.tStates;
    const frameStart = this.contention.frameStartTStates;
    this.tapeLastAdvanceT = this.cpu.tStates;
    const frameEnd = frameStart + tpf;
    // Fire interrupt (IM 1 = 13T, IM 2 = 19T — consumed from the frame budget).
    // See timings.md § intPending Mechanism for the three-case logic:
    //   - Fires (IFF1=true, no eiDelay) → clear _intPending
    //   - Blocked by DI (!IFF1)         → set _intPending
    //   - Blocked by eiDelay            → leave _intPending unchanged
    let intT = this.cpu.interrupt();
    if (intT > 0) {
      this._intPending = false;
    } else if (!this.cpu.iff1) {
      this._intPending = true;
    }
    // eiDelay case: leave _intPending as-is (see timings.md for rationale)

    // AMX mouse: drain queued movement steps as PIO interrupts spread across frame
    if (this.amxMouse.enabled && (this.amxMouse.pendingX !== 0 || this.amxMouse.pendingY !== 0)) {
      this.amxMouse.drainMovement(this.cpu, frameEnd, this.activity);
    }

    // Init scanline rendering state for this frame
    this.ula.advanceFlash();
    const borderTop = this.ula['borderTop'] as number;
    const borderLeft = this.ula['borderLeft'] as number;
    this.totalRenderLines = borderTop * 2 + 192;
    this.nextRenderLine = 0;
    this.nextPixelX = 0;
    this.nextDisplayCol = 0;
    // displayOrigin = T-state of the first display pixel (varies by model).
    // Left border starts borderLeft/2 T-states before that on each line.
    this.nextRenderT = this.contention.frameStartTStates
                      + this.contention.timing.displayOrigin
                      - borderTop * this.contention.timing.tStatesPerLine
                      - (borderLeft >> 1);

    while (this.cpu.tStates < frameEnd) {
      const tBefore = this.cpu.tStates;

      // ROM routine activity detection
      if (this.cpu.pc === 0x0556) this.activity.tapeLoads++;
      // ROM trap: intercept LD-BYTES for instant tape loading.
      // Only trap when a ROM-loadable block is ahead; if only custom loader
      // blocks remain (tone/pulses/pure-data), let the ROM execute its real
      // LD-BYTES code so custom loaders can read EAR naturally.
      // Auto-unpause: the tape starts paused on mount so the playback engine
      // doesn't race ahead; we unpause here when the ROM actually tries to LOAD.
      if (this.tapeInstantLoad && this.tape.loaded && this.cpu.pc === 0x0556 &&
          this.cpu.memory[0x0556] === 0x14 && this.tape.hasRomBlock()) {
        if (this.tape.paused) {
          this.tape.paused = false;
          this.tape.startPlayback();
        }
        trapTapeLoad(this.cpu, this.tape);
        this.tape.skipBlock(); // advance player past the consumed block
        this.cpu.tStates += 2168; // nominal T-states for trapped load
      } else if (this.cpu.halted) {
        // HALT repeats NOP-like M1 fetches from PC.  If PC or IR is in
        // contended memory each cycle gets a ULA delay; otherwise we can
        // fast-skip.  IR contention applies during the M1 refresh cycle
        // (T3-T4 put IR on the address bus).
        const irContended = this.contention.isContended(this.cpu.ir);
        if (this.contention.isContended(this.cpu.pc) || irContended) {
          // Step one NOP at a time so contention is applied correctly
          this.cpu.read8(this.cpu.pc);
          this.cpu.tStates += 3;  // M1 fetch cycle
          this.cpu.contend(this.cpu.ir);  // IR contention during refresh
          this.cpu.tStates += 1;  // M1 refresh cycle
          this.cpu.r = (this.cpu.r & 0x80) | ((this.cpu.r + 1) & 0x7F);
        } else {
          const toFrameEnd = frameEnd - this.cpu.tStates;
          const toNextSample = this.mixer.tStatesPerSample - this.mixer.beeperTStatesAccum;
          const skip = Math.min(toFrameEnd, toNextSample);
          const nops = Math.max(1, Math.ceil(skip / 4));
          this.cpu.tStates += nops * 4;
          this.cpu.r = (this.cpu.r & 0x80) | ((this.cpu.r + nops) & 0x7F);
        }

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

      // Clear EI delay after each instruction (see timings.md § EI Delay).
      // The delay suppresses interrupts for exactly one instruction after EI.
      // We clear it here (not in interrupt()) so the suppression is tied to
      // one *instruction*, not one *frame boundary check*.
      if (this.cpu.eiDelay) {
        this.cpu.eiDelay = false;
      }

      // Pending interrupt: if INT was blocked by DI at frame start,
      // fire it as soon as EI re-enables interrupts.  No time limit —
      // the pending flag persists until accepted or a new frame fires.
      // (eiDelay was already cleared above, so interrupt() can fire.)
      if (this._intPending && this.cpu.iff1) {
        intT = this.cpu.interrupt();
        if (intT > 0) {
          this._intPending = false;
        }
      }

      const elapsed = this.cpu.tStates - tBefore;

      // Advance tape playback and update ULA EAR bit (catches up any
      // T-states not already advanced by the port-in handler mid-instruction)
      this.advanceTapeTo();

      // Accumulate beeper duty and generate audio samples.
      // During tape turbo, skip audio generation entirely — the loading
      // noise is unwanted and audio pacing would throttle our speed.
      this.mixer.accumulate(this.ula.getAudioEarBit(this.tapeSoundEnabled), elapsed);
      if (!this._tapeTurboActive) {
        this.mixer.generateSamples(this.audio, this.ay, is128kClass(this.model));
      } else {
        // Drain the accumulator without producing samples so it stays in sync
        this.mixer.beeperTStatesAccum = 0;
      }
    }

    // Tape turbo + auto-pause.
    // earReads only counts ULA reads with high byte 0xFF (no keyboard row
    // selected), so it genuinely reflects tape loading, not keyboard polling.
    const tapeLoading = this.activity.earReads > 0 || this.activity.tapeLoads > 0;

    if (this.tape.loaded && !this.tape.finished) {
      if (tapeLoading) {
        if (this.tapeTurbo && !this._tapeTurboActive) {
          this._tapeTurboActive = true;
        }
        this._tapeTurboCooldown = 25; // ~0.5s at 50Hz
      } else if (this._tapeTurboCooldown > 0) {
        if (--this._tapeTurboCooldown <= 0) {
          this._tapeTurboActive = false;
          this.tape.paused = true;
          this.mixer.reset();
        }
      }
    } else if (this._tapeTurboActive) {
      this._tapeTurboActive = false;
      this.mixer.reset();
    }

    // Adjust loader detector T-state tracking across frame boundary
    this.loaderDetector.onFrameEnd(this.tStatesPerFrame);

    // Flush any remaining scanlines (bottom border / frame-end edge)
    {
      const borderLeft2 = this.ula['borderLeft'] as number;
      const dispEnd = borderLeft2 + 256;
      const w = this.ula.screenWidth;
      while (this.nextRenderLine < this.totalRenderLines) {
        const i = this.nextRenderLine;
        const isDisplay = i >= borderTop && i < borderTop + 192;
        if (isDisplay) {
          if (this.nextPixelX < borderLeft2) {
            this.ula.fillBorder(i, this.nextPixelX, borderLeft2, this.ula.borderColor);
          }
          // Render any remaining display cells not yet drawn
          if (this.nextDisplayCol < 32) {
            const dy = i - borderTop;
            for (let col = this.nextDisplayCol; col < 32; col++) {
              this.ula.renderDisplayCell(dy, col, this.memory.screenBank, 0x4000);
            }
          }
          if (this.nextPixelX < w) {
            this.ula.fillBorder(i, Math.max(this.nextPixelX, dispEnd), w, this.ula.borderColor);
          }
        } else {
          this.ula.fillBorder(i, this.nextPixelX, w, this.ula.borderColor);
        }
        this.nextRenderLine++;
        this.nextPixelX = 0;
        this.nextDisplayCol = 0;
      }
    }

    // Mark that we have a new frame to display
    this.needsDisplay = true;
  }

  /**
   * Render pixels up to the current beam position.
   * All lines (border and display) are rendered at sub-scanline granularity
   * for border regions.  Display data (256 pixels) is rendered once when the
   * beam first enters the display area on each line.
   */
  private renderPendingScanlines(): void {
    const ula = this.ula;
    const borderTop = ula['borderTop'] as number;
    const borderLeft = ula['borderLeft'] as number;
    const dispEnd = borderLeft + 256;
    const w = ula.screenWidth;
    const tpl = this.contention.timing.tStatesPerLine;
    const t = this.cpu.tStates;

    while (this.nextRenderLine < this.totalRenderLines) {
      const lineRelT = t - this.nextRenderT;
      if (lineRelT < 0) break;

      const i = this.nextRenderLine;
      const beamX = Math.min(w, lineRelT << 1); // 2 pixels per T-state
      if (beamX <= this.nextPixelX) break;

      const isDisplay = i >= borderTop && i < borderTop + 192;

      if (isDisplay) {
        // Left border portion
        if (this.nextPixelX < borderLeft) {
          ula.fillBorder(i, this.nextPixelX, Math.min(beamX, borderLeft), ula.borderColor);
        }
        // Display data — render individual cells as the beam enters each cell.
        // The ULA reads bitmap+attr at the START of each cell's 4T display period,
        // so we must render as soon as the beam reaches a cell's first pixel.
        // Using nextDisplayCol prevents re-rendering (which would pick up later writes).
        if (beamX > borderLeft && this.nextDisplayCol < 32) {
          const endCol = Math.min(32, ((Math.min(beamX, dispEnd) - borderLeft) >> 3) + 1);
          const dy = i - borderTop;
          for (let col = this.nextDisplayCol; col < endCol; col++) {
            ula.renderDisplayCell(dy, col, this.memory.screenBank, 0x4000);
          }
          this.nextDisplayCol = endCol;
        }
        // Right border portion
        if (beamX > dispEnd && this.nextPixelX < w) {
          ula.fillBorder(i, Math.max(this.nextPixelX, dispEnd), beamX, ula.borderColor);
        }
      } else {
        // Pure border line
        ula.fillBorder(i, this.nextPixelX, beamX, ula.borderColor);
      }

      this.nextPixelX = beamX;
      if (this.nextPixelX >= w) {
        this.nextRenderLine++;
        this.nextPixelX = 0;
        this.nextDisplayCol = 0;
        this.nextRenderT += tpl;
      } else {
        break; // beam is mid-line, wait for more T-states
      }
    }
  }

  loadTAP(data: Uint8Array): void {
    this.tape.load(data);
  }

  loadDisk(image: DskImage, unit: number = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  /** Get the 48K ROM font (768 bytes) regardless of current paging. */
  private get romFont(): Uint8Array {
    const pages = this.memory.romPages;
    const basicRom = pages.length === 4 ? pages[3] : pages[1];
    return basicRom.subarray(0x3D00, 0x3D00 + 768);
  }

  ocrScreen(extraFonts?: FontSource[]): string {
    return this.screenText.ocr(this.cpu.memory, this.romFont, extraFonts);
  }

  ocrScreenStyled(extraFonts?: FontSource[]): OcrResult {
    return this.screenText.ocrStyled(
      this.cpu.memory, this.romFont,
      this.ula.palette, this.ula.flashState,
      extraFonts,
    );
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
