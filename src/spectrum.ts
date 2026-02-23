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
import { ULA, type BorderMode } from '@/cores/ula.ts';
import { SpectrumKeyboard } from '@/keyboard.ts';
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
import { hex8, hex16 } from '@/utils/hex.ts';
import { createVariant, type MachineVariant } from '@/variants/index.ts';

// Re-export model type and helpers from their canonical home (models.ts)
// so existing imports from '@/spectrum.ts' continue to work.
export { type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from '@/models.ts';
export type { MachineVariant } from '@/variants/index.ts';

const AY_CLOCK = 1773400;        // ~1.77 MHz

/** Samples produced per Spectrum frame at a given sample rate */
function samplesPerFrame(sampleRate: number): number {
  return Math.round(sampleRate / 50);
}

/** Target buffer fill: ~3 frames of audio (~60ms). Below this we run a frame. */
const TARGET_BUFFER_FRAMES = 3;

/** Wall-clock frame period: 50 Hz = 20ms */
const FRAME_PERIOD = 1000 / 50;

import type { SpectrumModel } from '@/models.ts';

export class IOActivity {
  /** Number of ULA port reads this frame (keyboard / tape) */
  ulaReads = 0;
  /** Number of Kempston joystick port reads this frame */
  kempstonReads = 0;
  /** Whether the beeper bit toggled this frame */
  beeperToggled = false;
  /** Number of AY register writes this frame */
  ayWrites = 0;
  /** Number of LD-BYTES (0x0556) calls this frame */
  tapeLoads = 0;
  /** Number of FDC data port accesses this frame */
  fdcAccesses = 0;
  /** Number of ULA reads while tape is active (EAR sampling) */
  earReads = 0;
  /** Number of attribute-area (5800-5AFF) writes this frame */
  attrWrites = 0;
  /** Number of Kempston mouse port reads this frame */
  mouseReads = 0;

  reset(): void {
    this.ulaReads = 0;
    this.kempstonReads = 0;
    this.beeperToggled = false;
    this.ayWrites = 0;
    this.tapeLoads = 0;
    this.fdcAccesses = 0;
    this.earReads = 0;
    this.attrWrites = 0;
    this.mouseReads = 0;
  }
}

export class Spectrum {
  model: SpectrumModel;
  variant: MachineVariant;
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
  activity = new IOActivity();

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

  /** Scanline accuracy:
   *  'high' = per-instruction partial-scanline render (multicolor/rainbow)
   *  'mid'  = per-instruction but only completed lines (per-scanline border, no mid-line)
   *  'low'  = single bulk render at frame end (one border color, fastest) */
  scanlineAccuracy: 'high' | 'mid' | 'low' = 'high';

  /** Numeric cache of scanlineAccuracy for zero-cost hot-path checks.
   *  2 = high, 1 = mid, 0 = low.  Updated at frame start. */
  private _scanAcc = 2;

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


  /** Per-cell render threshold: +1 on Ferranti ULA models (48K/128K/+2) to
   *  render when the beam enters each cell for tightest accuracy.  +0 on
   *  Amstrad gate array models (+2A/+3) where deterministic timing makes the
   *  slightly later capture safe.  Set once in constructor from the variant. */
  private _cellRenderOffset: 0 | 1 = 1;

  /** Breakpoints (checked every instruction in runFrame) */
  breakpoints = new Set<number>();
  /** Set to the hit address when a breakpoint fires mid-frame */
  breakpointHit = -1;

  /** Port watchpoints: break when any watched port is accessed by IN or OUT */
  portWatchpoints = new Set<number>();
  /** Set when a port watchpoint fires; null means no hit this frame */
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null = null;

  /** Status callback */
  onStatus: ((msg: string) => void) | null = null;

  /** Frame callback (fires each rAF after rendering) */
  onFrame: (() => void) | null = null;

  constructor(model: SpectrumModel, display?: IScreenRenderer | null) {
    this.model = model;
    this.variant = createVariant(model);

    this.memory = new SpectrumMemory(model, {
      hasBanking: this.variant.hasBanking,
      romPageCount: this.variant.romPageCount,
    });
    this.cpu = new Z80(this.memory.flat);
    this.ay = new AY3891x(AY_CLOCK, 44100, 'ABC');
    this.keyboard = new SpectrumKeyboard();
    this.ula = new ULA(this.keyboard);
    this.display = display ?? null;
    this.audio = new Audio();
    this.contention = new Contention(this.variant, this.memory);
    this.mixer = new AudioMixer(this.contention.timing.cpuClock);
    this.tape = new TapeDeck();
    this.tape.is48K = this.variant.is48K;
    this.tape.cpuClock = this.variant.timing.cpuClock;
    this.fdc = new UPD765A();
    // Ferranti ULA (48K/128K/+2): render as the beam enters each cell (+1)
    // for tightest accuracy.  The beam flush (vramFlushEnd=0x5B00) ensures
    // cells are captured with the correct attribute before multicolor engines
    // overwrite them for the next scanline.
    // Amstrad gate array (+2A/+3): render after the beam fully passes (+0).
    // No beam flush on attr writes — deterministic timing (no IO contention)
    // keeps the renderer in sync without it.
    this._cellRenderOffset = this.variant.cellRenderOffset;
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
    const sa = this._scanAcc;
    if (sa === 0) return;
    if (sa === 1) { this.renderCompletedScanlines(); return; }
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
          `${hex16(pc)}  IN port=${hex16(port)} val=${hex8(val)} fT=${frameTStates} line=${line}${tag}`
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
    // Re-render VRAM into the new pixel buffer so the display stays correct
    // even when paused (the old buffer was discarded by setBorderMode).
    this.ula.renderFrame(this.cpu.memory);
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
    // Only start rAF if not already looping (it stays alive across pause/resume)
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(this.frameLoop);
    }
    this.setStatus('Running');
  }

  stop(): void {
    this.starting = false; // cancel pending async start
    this.running = false;
    // rAF loop keeps running so the display stays alive (noise, settings changes).
    // Only destroy() cancels the rAF loop entirely.
  }

  destroy(): void {
    this.stop();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.audio.destroy();
  }

  /** Run one frame (for headless / test harness use). */
  tick(): void { this.breakpointHit = -1; this.portWatchHit = null; this.runFrame(); }

  /**
   * Run up to `maxFrames` frames, stopping early if a breakpoint or port
   * watchpoint is hit.  Returns the number of frames actually executed.
   */
  runUntil(maxFrames: number): number {
    this.breakpointHit = -1;
    this.portWatchHit = null;
    for (let i = 0; i < maxFrames; i++) {
      this.runFrame();
      if (this.breakpointHit >= 0 || this.portWatchHit !== null) return i + 1;
    }
    return maxFrames;
  }

  /** Whether tape turbo is currently engaged (read by UI for status) */
  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  private frameLoop = (): void => {
    if (this.running) {
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
    } else {
      // Paused: keep rendering so display stays alive (noise animates,
      // settings changes take effect immediately).
      if (this.display) this.display.updateTexture(this.ula.pixels);
    }

    this.rafId = requestAnimationFrame(this.frameLoop);
  };

  private runFrame(): void {
    // Reset activity counters for this frame
    this.activity.reset();
    this.portWatchHit = null;
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
    const intWindowEnd = frameStart + this.contention.timing.intLength;

    // Fire interrupt (IM 1 = 13T, IM 2 = 19T — consumed from the frame budget).
    // On real hardware, INT is held LOW for a model-dependent window:
    //   48K: 32T, 128K/+2: 36T, +2A/+3: 32T
    // If IFF1 is false (DI), the interrupt stays pending until EI re-enables it,
    // but only within the INT window — after that, it's lost until the next frame.
    let intT = this.cpu.interrupt();
    let intPending = intT === 0 && !this.cpu.iff1;  // blocked by DI

    // AMX mouse: drain queued movement steps as PIO interrupts spread across frame
    if (this.amxMouse.enabled && (this.amxMouse.pendingX !== 0 || this.amxMouse.pendingY !== 0)) {
      this.amxMouse.drainMovement(this.cpu, frameEnd, this.activity);
    }

    // Cache accuracy level as integer for zero-cost hot-path checks
    const sa = this.scanlineAccuracy;
    this._scanAcc = sa === 'high' ? 2 : sa === 'mid' ? 1 : 0;

    // Init scanline rendering state for this frame
    // High and mid modes advance flash here (they render scanlines individually).
    // Low mode skips this — renderFrame() handles flash internally.
    if (this._scanAcc > 0) this.ula.advanceFlash();
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

        // if (!this.cpu.iff1) {
        //   this.cpu.iff1 = true;
        //   this.cpu.iff2 = true;
        // }
      } else {
        // Breakpoint check (skipped when set is empty for zero overhead)
        if (this.breakpoints.size > 0 && this.breakpoints.has(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          break;
        }
        if (this._tracing && this._traceMode === 'full' && this.cpu.pc >= 0x4000) this.captureTraceLine();
        this.cpu.step();
        // Break mid-frame if a port watchpoint fired during this instruction
        if (this.portWatchHit !== null) break;
      }

      // Clear EI delay after each instruction (see timings.md § EI Delay).
      // The delay suppresses interrupts for exactly one instruction after EI.
      // We clear it here (not in interrupt()) so the suppression is tied to
      // one *instruction*, not one *frame boundary check*.
      if (this.cpu.eiDelay) {
        this.cpu.eiDelay = false;
      }

      // Pending interrupt: INT is only held LOW for a limited window.
      // If EI re-enables interrupts within the window, fire the interrupt.
      // After the window closes, the interrupt is lost until the next frame.
      // (eiDelay was already cleared above, so interrupt() can fire.)
      if (intPending) {
        if (this.cpu.tStates >= intWindowEnd) {
          intPending = false;
        } else if (this.cpu.iff1) {
          intT = this.cpu.interrupt();
          if (intT > 0) {
            intPending = false;
          }
        }
      }

      // Render display cells up to the current beam position.
      // High (2): partial-scanline render every instruction (multicolor/rainbow).
      // Mid  (1): whole-scanline render — cheap subtract+compare, ~312 renders/frame.
      // Low  (0): skipped entirely — single renderFrame() at frame end.
      if (this._scanAcc === 2) this.renderPendingScanlines();
      else if (this._scanAcc === 1) this.renderCompletedScanlines();

      const elapsed = this.cpu.tStates - tBefore;

      // Advance tape playback and update ULA EAR bit (catches up any
      // T-states not already advanced by the port-in handler mid-instruction)
      this.advanceTapeTo();

      // Accumulate beeper duty and generate audio samples.
      // During tape turbo, skip audio generation entirely — the loading
      // noise is unwanted and audio pacing would throttle our speed.
      this.mixer.accumulate(this.ula.getAudioEarBit(this.tapeSoundEnabled), elapsed);
      if (!this._tapeTurboActive) {
        this.mixer.generateSamples(this.audio, this.ay, this.variant.hasAY);
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

    // Flush any remaining scanlines (bottom border / frame-end edge).
    // Low (0): bulk renderFrame() — one border color, fastest.
    // Mid (1): flush remaining complete lines (no partial-line state to worry about).
    // High (2): flush with partial-line awareness (nextPixelX, nextDisplayCol).
    if (this._scanAcc === 0) {
      this.ula.renderFrame(this.memory.screenBank, 0x4000);
    } else if (this._scanAcc === 1) {
      this.flushRemainingLines(borderTop);
    } else {
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
        // Display data — render individual cells as the beam passes them.
        // Ferranti ULA (48K/128K/+2): +1 renders as beam enters cell; the
        // write8 attr flush ensures correct per-scanline multicolor.
        // Amstrad gate array (+2A/+3): +0 renders after beam fully passes;
        // deterministic timing makes this safe without attr flushes.
        if (beamX > borderLeft && this.nextDisplayCol < 32) {
          const endCol = Math.min(32, ((Math.min(beamX, dispEnd) - borderLeft) >> 3) + this._cellRenderOffset);
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

  /**
   * Mid-accuracy renderer: render only fully completed scanlines.
   * Called every instruction but extremely cheap — a single subtract+compare
   * returns immediately most of the time.  Only does real work ~312 times
   * per frame (once per visible line).  Each line gets the current border
   * color, giving per-scanline border effects without mid-line tracking.
   */
  private renderCompletedScanlines(): void {
    const ula = this.ula;
    const borderTop = ula['borderTop'] as number;
    const borderLeft = ula['borderLeft'] as number;
    const w = ula.screenWidth;
    const tpl = this.contention.timing.tStatesPerLine;
    const t = this.cpu.tStates;

    while (this.nextRenderLine < this.totalRenderLines) {
      // Only render once the beam has fully passed this line
      if (t - this.nextRenderT < tpl) break;

      const i = this.nextRenderLine;
      const isDisplay = i >= borderTop && i < borderTop + 192;

      if (isDisplay) {
        ula.fillBorder(i, 0, borderLeft, ula.borderColor);
        const dy = i - borderTop;
        for (let col = 0; col < 32; col++) {
          ula.renderDisplayCell(dy, col, this.memory.screenBank, 0x4000);
        }
        ula.fillBorder(i, borderLeft + 256, w, ula.borderColor);
      } else {
        ula.fillBorder(i, 0, w, ula.borderColor);
      }

      this.nextRenderLine++;
      this.nextRenderT += tpl;
    }
  }

  /**
   * Flush all remaining unrendered lines at frame end (mid-accuracy mode).
   * No partial-line state to worry about — lines are always complete or untouched.
   */
  private flushRemainingLines(borderTop: number): void {
    const ula = this.ula;
    const borderLeft = ula['borderLeft'] as number;
    const w = ula.screenWidth;

    while (this.nextRenderLine < this.totalRenderLines) {
      const i = this.nextRenderLine;
      const isDisplay = i >= borderTop && i < borderTop + 192;

      if (isDisplay) {
        ula.fillBorder(i, 0, borderLeft, ula.borderColor);
        const dy = i - borderTop;
        for (let col = 0; col < 32; col++) {
          ula.renderDisplayCell(dy, col, this.memory.screenBank, 0x4000);
        }
        ula.fillBorder(i, borderLeft + 256, w, ula.borderColor);
      } else {
        ula.fillBorder(i, 0, w, ula.borderColor);
      }

      this.nextRenderLine++;
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
      this._traceBuffer.push(`      ... loops back to ${hex16(this._traceLoopAddr)} x${this._traceLoopCount}`);
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
      this._traceBuffer.push(`      ... loops back to ${hex16(this._traceLoopAddr)} x${this._traceLoopCount}`);
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
    const addr = hex16(pc);
    this._traceBuffer.push(ctx
      ? `${addr}  ${mnem.padEnd(24)} ${ctx}`
      : `${addr}  ${mnem}`);
    if (this._traceBuffer.length >= 500_000) this._tracing = false;
  }

  private traceCtx(pc: number): string {
    const cpu = this.cpu;
    const mem = cpu.memory;
    let op = mem[pc];

    // DD/FD prefix → IX/IY memory access
    if (op === 0xDD || op === 0xFD) {
      const ixr = op === 0xDD ? cpu.ix : cpu.iy;
      const op2 = mem[(pc + 1) & 0xFFFF];
      if (op2 === 0xCB) {
        const d = mem[(pc + 2) & 0xFFFF];
        const addr = (ixr + (d < 128 ? d : d - 256)) & 0xFFFF;
        return `(${hex16(addr)})=${hex8(mem[addr])}`;
      }
      if (op2 === 0xED || op2 === 0xDD || op2 === 0xFD) return '';
      const x = (op2 >> 6) & 3, y = (op2 >> 3) & 7, z = op2 & 7;
      if ((x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) ||
          (x === 2 && z === 6) ||
          (x === 0 && (z === 4 || z === 5) && y === 6) ||
          op2 === 0x36) {
        const d = mem[(pc + 2) & 0xFFFF];
        const addr = (ixr + (d < 128 ? d : d - 256)) & 0xFFFF;
        if (x === 2) return `A=${hex8(cpu.a)} (${hex16(addr)})=${hex8(mem[addr])}`;
        return `(${hex16(addr)})=${hex8(mem[addr])}`;
      }
      return '';
    }

    // CB: bit ops on (HL)
    if (op === 0xCB) {
      if ((mem[(pc + 1) & 0xFFFF] & 7) === 6) return `(${hex16(cpu.hl)})=${hex8(mem[cpu.hl])}`;
      return '';
    }

    // ED prefix
    if (op === 0xED) {
      const ed = mem[(pc + 1) & 0xFFFF];
      const x = (ed >> 6) & 3, y = (ed >> 3) & 7, z = ed & 7;
      if (x === 1 && (z === 0 || z === 1)) return `port=${hex16(cpu.bc)}`;
      if (x === 2 && y >= 4 && z < 4) return `HL=${hex16(cpu.hl)} DE=${hex16(cpu.de)} BC=${hex16(cpu.bc)}`;
      return '';
    }

    // Main table
    const x = (op >> 6) & 3, y = (op >> 3) & 7, z = op & 7;
    const p = (y >> 1) & 3, q = y & 1;

    if (x === 0) {
      if (z === 0 && y === 2) return `B=${hex8((cpu.bc >> 8) & 0xFF)}`; // DJNZ
      if (z === 0 && y >= 4) return cpu.checkCondition(y - 4) ? 'taken' : '--'; // JR cc
      if (z === 2) {
        if (q === 0 && p <= 1) return `A=${hex8(cpu.a)}→(${hex16(p === 0 ? cpu.bc : cpu.de)})`;
        if (q === 1 && p === 0) return `(${hex16(cpu.bc)})=${hex8(mem[cpu.bc & 0xFFFF])}`;
        if (q === 1 && p === 1) return `(${hex16(cpu.de)})=${hex8(mem[cpu.de & 0xFFFF])}`;
      }
      if ((z === 4 || z === 5) && y === 6) return `(${hex16(cpu.hl)})=${hex8(mem[cpu.hl & 0xFFFF])}`;
    }

    if (x === 1) {
      if (y === 6 && z !== 6) return `${hex8(cpu.getReg8(z))}→(${hex16(cpu.hl)})`;
      if (z === 6 && y !== 6) return `(${hex16(cpu.hl)})=${hex8(mem[cpu.hl & 0xFFFF])}`;
    }

    if (x === 2) {
      if (z === 6) return `A=${hex8(cpu.a)} (${hex16(cpu.hl)})=${hex8(mem[cpu.hl & 0xFFFF])}`;
      return `A=${hex8(cpu.a)}`;
    }

    if (x === 3) {
      if (z === 0) return cpu.checkCondition(y) ? 'taken' : '--'; // RET cc
      if (z === 2) return cpu.checkCondition(y) ? 'taken' : '--'; // JP cc
      if (z === 4) return cpu.checkCondition(y) ? 'taken' : '--'; // CALL cc
      if (z === 6) return `A=${hex8(cpu.a)}`; // ALU A,n
      if (z === 3 && y === 2) return `A=${hex8(cpu.a)}`; // OUT (n),A
    }

    return '';
  }

  private portLabel(port: number): string {
    const v = this.variant;
    if ((port & 1) === 0) return 'ULA';
    if ((port & 0x00E0) === 0) return 'Kemp';
    if (v.hasAY) {
      if ((port & 0xC002) === 0xC000) return 'AY';
      if ((port & 0xC002) === 0x8000) return 'AY';
    }
    if (v.decodes7FFD(port)) return '7FFD';
    if (v.decodes1FFD(port)) return '1FFD';
    if (v.decodesFDCStatus(port)) return 'FDC';
    if (v.decodesFDCData(port)) return 'FDC';
    return '';
  }

  private formatPortTally(): string {
    const formatSection = (title: string, tally: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }>) => {
      if (!tally.size) return '';
      const entries = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
      const lines = [`${title}:`];
      for (const [port, info] of entries) {
        const label = (this.portLabel(port) || '').padEnd(6);
        const pcs = [...info.pcs].map(hex16).join(',');
        const vals = [...info.vals].map(hex8).join(',');
        lines.push(`  ${hex16(port)}  ${String(info.count).padStart(8)}x  ${label} from ${pcs}  vals ${vals}`);
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
