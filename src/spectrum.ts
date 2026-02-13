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
import { ULA, SCREEN_WIDTH, SCREEN_HEIGHT } from './ula.ts';
import { SpectrumKeyboard } from './keyboard.ts';
import { Display } from './display.ts';
import { Audio } from './audio.ts';
import { TapeDeck } from './formats/tap.ts';

const Z80_CLOCK = 3500000;       // 3.5 MHz
const AY_CLOCK = 1773400;        // ~1.77 MHz
const TSTATES_PER_FRAME = 69888; // 50.08 Hz

/** Samples produced per Spectrum frame at a given sample rate */
function samplesPerFrame(sampleRate: number): number {
  return Math.round(sampleRate / 50);
}

/** Target buffer fill: ~3 frames of audio (~60ms). Below this we run a frame. */
const TARGET_BUFFER_FRAMES = 3;

export type SpectrumModel = '48k' | '128k' | '+2';

/** Returns true for any 128K-class model (128K, +2, future +2A/+3). */
export function is128kClass(m: SpectrumModel): boolean { return m !== '48k'; }

export interface IOActivity {
  /** Number of ULA port reads this frame (keyboard / tape) */
  ulaReads: number;
  /** Number of Kempston joystick port reads this frame */
  kempstonReads: number;
  /** Whether the beeper bit toggled this frame */
  beeperToggled: boolean;
  /** Number of AY register writes this frame */
  ayWrites: number;
}

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

  /** Per-frame I/O activity counters */
  activity: IOActivity = { ulaReads: 0, kempstonReads: 0, beeperToggled: false, ayWrites: 0 };

  /** Kempston joystick state (bits: 0=right,1=left,2=down,3=up,4=fire) */
  kempstonState = 0;

  private running = false;
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

  /** Status callback */
  onStatus: ((msg: string) => void) | null = null;

  /** Frame callback (fires each rAF after rendering) */
  onFrame: (() => void) | null = null;

  constructor(model: SpectrumModel, canvas: HTMLCanvasElement) {
    this.model = model;

    this.memory = new SpectrumMemory(is128kClass(model));
    this.cpu = new Z80(this.memory.flat);
    this.ay = new AY3891x(AY_CLOCK, 44100, 'ABC');
    this.keyboard = new SpectrumKeyboard();
    this.ula = new ULA(this.keyboard);
    this.display = new Display(canvas, SCREEN_WIDTH, SCREEN_HEIGHT);
    this.audio = new Audio();
    this.tape = new TapeDeck();

    this.tStatesPerSample = Z80_CLOCK / 44100;

    this.installROMProtection();
    this.wirePortIO();
  }

  /**
   * Override Z80 write8 to silently discard writes to the ROM region (0x0000-0x3FFF).
   * On real hardware, ROM is read-only — writes are ignored, not buffered.
   */
  private installROMProtection(): void {
    const mem = this.cpu.memory;
    this.cpu.write8 = (addr: number, val: number): void => {
      addr &= 0xFFFF;
      if (addr < 0x4000) return; // ROM — silently discard
      mem[addr] = val & 0xFF;
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

      // 128K bank switching: port 0x7FFD (A15=0, A1=0)
      if ((port & 0x8002) === 0 && is128kClass(this.model)) {
        this.memory.bankSwitch(val);
        this.cpu.memory = this.memory.flat;
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
        return this.ula.readPort((port >> 8) & 0xFF);
      }

      // AY register read: port 0xFFFD — 128K only
      if (is128kClass(this.model) && (port & 0xC002) === 0xC000) {
        return this.ay.readRegister(this.ay.selectedReg);
      }

      // Kempston joystick (port 0x1F)
      if ((port & 0xFF) === 0x1F) {
        this.activity.kempstonReads++;
        return this.kempstonState;
      }

      return 0xFF;
    };
  }

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.memory.applyBanking();
    this.cpu.memory = this.memory.flat;
    this.setStatus('ROM loaded');
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.ay.reset();
    this.ula.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.memory.reset();
    this.cpu.memory = this.memory.flat;
    this.kempstonState = 0;
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
    this.beeperDCPrev = 0;
    this.beeperDCOut = 0;
    this.prevBeeperBit = 0;
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  start(): void {
    if (this.running) return;

    this.audio.init();
    this.tStatesPerSample = Z80_CLOCK / this.audio.sampleRate;
    // DC-blocking filter: ~20Hz cutoff, same as AY core
    this.beeperDCAlpha = 1 - (2 * Math.PI * 20 / this.audio.sampleRate);

    this.running = true;
    this.rafId = requestAnimationFrame(this.frameLoop);
    this.setStatus('Running');
  }

  stop(): void {
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

    const targetSamples = samplesPerFrame(this.audio.sampleRate) * TARGET_BUFFER_FRAMES;
    const buffered = this.audio.bufferedSamples();

    // Run frames until audio buffer reaches target, max 2 per rAF to avoid stutters
    let framesRun = 0;
    while (buffered + framesRun * samplesPerFrame(this.audio.sampleRate) < targetSamples && framesRun < 2) {
      this.runFrame();
      framesRun++;
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

  private runFrame(): void {
    // Reset activity counters for this frame
    this.activity.ulaReads = 0;
    this.activity.kempstonReads = 0;
    this.activity.beeperToggled = false;
    this.activity.ayWrites = 0;

    // Fire interrupt at frame start
    this.cpu.interrupt();

    // Run CPU for one frame's worth of T-states
    const frameEnd = this.cpu.tStates + TSTATES_PER_FRAME;

    while (this.cpu.tStates < frameEnd) {
      const tBefore = this.cpu.tStates;

      // ROM trap: intercept LD-BYTES for instant tape loading
      if (this.tape.loaded && !this.tape.paused && this.cpu.pc === 0x0556 && this.cpu.memory[0x0556] === 0x14) {
        this.trapTapeLoad();
        this.cpu.tStates += 2168; // nominal T-states for trapped load
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
        this.cpu.step();
      }

      const elapsed = this.cpu.tStates - tBefore;

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

  private setStatus(msg: string): void {
    if (this.onStatus) this.onStatus(msg);
  }
}
