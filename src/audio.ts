/**
 * Web Audio output for ZX Spectrum beeper + AY chip.
 *
 * Primary path: AudioWorklet with a SharedArrayBuffer ring buffer —
 * the emulation thread writes samples, the audio thread reads them
 * with zero copying. Requires Cross-Origin-Isolation headers.
 *
 * Fallback: ScriptProcessorNode (deprecated but universally supported).
 */

const RING_SIZE = 8192;
const RING_MASK = RING_SIZE - 1;

/** Inlined AudioWorklet processor (avoids a separate JS file). */
const WORKLET_SOURCE = `
class SpectrumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.ringL = new Float32Array(o.buf, 0, o.size);
    this.ringR = new Float32Array(o.buf, o.size * 4, o.size);
    this.pos = new Int32Array(o.buf, o.size * 8, 2);
    this.mask = o.size - 1;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const outL = out[0];
    const outR = out[1] || outL;
    let rp = Atomics.load(this.pos, 1);
    const wp = Atomics.load(this.pos, 0);
    for (let i = 0; i < outL.length; i++) {
      if (rp !== wp) {
        outL[i] = this.ringL[rp];
        outR[i] = this.ringR[rp];
        rp = (rp + 1) & this.mask;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
    Atomics.store(this.pos, 1, rp);
    return true;
  }
}
registerProcessor('spectrum-audio', SpectrumProcessor);
`;

export class Audio {
  ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;

  // ── AudioWorklet path ──────────────────────────────────────────────
  private workletNode: AudioWorkletNode | null = null;
  private sharedBuf: SharedArrayBuffer | null = null;
  private sharedL: Float32Array | null = null;
  private sharedR: Float32Array | null = null;
  private sharedPos: Int32Array | null = null;
  private useWorklet = false;

  // ── ScriptProcessorNode fallback ───────────────────────────────────
  private processor: ScriptProcessorNode | null = null;
  private ringL = new Float32Array(RING_SIZE);
  private ringR = new Float32Array(RING_SIZE);
  private writePos = 0;
  private readPos = 0;

  sampleRate = 44100;
  running = false;

  /**
   * Initialize audio context and output node.
   * Tries AudioWorklet + SharedArrayBuffer first; falls back to
   * ScriptProcessorNode if unavailable.
   */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }

    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.sampleRate = this.ctx.sampleRate;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0.7;

    if (typeof SharedArrayBuffer !== 'undefined' && this.ctx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        // Layout: [ringL float32][ringR float32][writePos int32, readPos int32]
        this.sharedBuf = new SharedArrayBuffer(RING_SIZE * 8 + 8);
        this.sharedL = new Float32Array(this.sharedBuf, 0, RING_SIZE);
        this.sharedR = new Float32Array(this.sharedBuf, RING_SIZE * 4, RING_SIZE);
        this.sharedPos = new Int32Array(this.sharedBuf, RING_SIZE * 8, 2);

        this.workletNode = new AudioWorkletNode(this.ctx, 'spectrum-audio', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { buf: this.sharedBuf, size: RING_SIZE },
        });
        this.workletNode.connect(this.gainNode);
        this.useWorklet = true;
      } catch {
        this.initScriptProcessor();
      }
    } else {
      this.initScriptProcessor();
    }

    this.gainNode.connect(this.ctx.destination);
    this.running = true;
  }

  private initScriptProcessor(): void {
    if (!this.ctx || !this.gainNode) return;
    this.processor = this.ctx.createScriptProcessor(4096, 0, 2);
    this.processor.onaudioprocess = (e) => this.audioCallback(e);
    this.processor.connect(this.gainNode);
    this.useWorklet = false;
  }

  private audioCallback(e: AudioProcessingEvent): void {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    for (let i = 0; i < outL.length; i++) {
      if (this.readPos !== this.writePos) {
        outL[i] = this.ringL[this.readPos];
        outR[i] = this.ringR[this.readPos];
        this.readPos = (this.readPos + 1) & RING_MASK;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
  }

  pushSample(left: number, right: number): void {
    if (this.useWorklet) {
      const pos = this.sharedPos!;
      const wp = Atomics.load(pos, 0);
      const next = (wp + 1) & RING_MASK;
      if (next === Atomics.load(pos, 1)) return;
      this.sharedL![wp] = left;
      this.sharedR![wp] = right;
      Atomics.store(pos, 0, next);
    } else {
      const next = (this.writePos + 1) & RING_MASK;
      if (next === this.readPos) return;
      this.ringL[this.writePos] = left;
      this.ringR[this.writePos] = right;
      this.writePos = next;
    }
  }

  bufferedSamples(): number {
    if (this.useWorklet) {
      const pos = this.sharedPos!;
      return (Atomics.load(pos, 0) - Atomics.load(pos, 1) + RING_SIZE) & RING_MASK;
    }
    return (this.writePos - this.readPos + RING_SIZE) & RING_MASK;
  }

  reset(): void {
    if (this.useWorklet && this.sharedPos) {
      Atomics.store(this.sharedPos, 0, 0);
      Atomics.store(this.sharedPos, 1, 0);
      this.sharedL!.fill(0);
      this.sharedR!.fill(0);
    } else {
      this.writePos = 0;
      this.readPos = 0;
      this.ringL.fill(0);
      this.ringR.fill(0);
    }
  }

  destroy(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.useWorklet = false;
    this.sharedBuf = null;
    this.sharedL = null;
    this.sharedR = null;
    this.sharedPos = null;
    this.running = false;
  }
}
