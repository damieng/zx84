/**
 * Web Audio output for ZX Spectrum beeper + AY chip.
 * Uses ScriptProcessorNode with a ring buffer.
 */

const BUFFER_SIZE = 4096;
const RING_SIZE = 8192;

export class Audio {
  ctx: AudioContext | null = null;
  processor: ScriptProcessorNode | null = null;
  gainNode: GainNode | null = null;

  /** Stereo ring buffer */
  ringL: Float32Array;
  ringR: Float32Array;
  writePos = 0;
  readPos = 0;

  sampleRate = 44100;
  running = false;

  constructor() {
    this.ringL = new Float32Array(RING_SIZE);
    this.ringR = new Float32Array(RING_SIZE);
  }

  /**
   * Initialize audio context (must be called from user gesture).
   */
  init(): void {
    if (this.ctx) return;

    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.sampleRate = this.ctx.sampleRate;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0.7;

    this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 0, 2);
    this.processor.onaudioprocess = (e) => this.audioCallback(e);

    this.processor.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);

    this.running = true;
  }

  private audioCallback(e: AudioProcessingEvent): void {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);

    for (let i = 0; i < outL.length; i++) {
      if (this.readPos !== this.writePos) {
        outL[i] = this.ringL[this.readPos];
        outR[i] = this.ringR[this.readPos];
        this.readPos = (this.readPos + 1) & (RING_SIZE - 1);
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
  }

  /**
   * Push a stereo sample into the ring buffer.
   */
  pushSample(left: number, right: number): void {
    const next = (this.writePos + 1) & (RING_SIZE - 1);
    if (next === this.readPos) return; // Buffer full, drop sample
    this.ringL[this.writePos] = left;
    this.ringR[this.writePos] = right;
    this.writePos = next;
  }

  /**
   * How many samples are buffered.
   */
  bufferedSamples(): number {
    return (this.writePos - this.readPos + RING_SIZE) & (RING_SIZE - 1);
  }

  reset(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.ringL.fill(0);
    this.ringR.fill(0);
  }

  destroy(): void {
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
    this.running = false;
  }
}
