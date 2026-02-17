/**
 * Audio mixer peripheral: beeper accumulation, DC-blocking filter,
 * and stereo sample generation (beeper + AY).
 */

import type { Audio } from '@/audio.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';

export class AudioMixer {
  /** Gain factors for AY/beeper balance (0.0-1.0, set from ayMix slider) */
  beeperGain = 1.0;
  ayGain = 1.0;

  /** Previous beeper state for toggle detection (read by io-ports.ts) */
  prevBeeperBit = 0;

  /** T-states per audio sample */
  tStatesPerSample: number;

  /** CPU clock speed in Hz */
  private cpuClock: number;

  /** Beeper duty cycle accumulator for current audio sample */
  private beeperAccum = 0;
  beeperTStatesAccum = 0;

  /** DC-blocking filter for beeper */
  private beeperDCAlpha = 0;
  private beeperDCPrev = 0;
  private beeperDCOut = 0;

  constructor(cpuClock = 3500000) {
    this.cpuClock = cpuClock;
    this.tStatesPerSample = cpuClock / 44100;
  }

  /** Compute tStatesPerSample and DC alpha from actual audio sample rate. */
  init(sampleRate: number): void {
    this.tStatesPerSample = this.cpuClock / sampleRate;
    // DC-blocking filter: ~20Hz cutoff, same as AY core
    this.beeperDCAlpha = 1 - (2 * Math.PI * 20 / sampleRate);
  }

  /** Accumulate beeper duty for the given elapsed T-states. */
  accumulate(beeperBit: number, elapsed: number): void {
    this.beeperAccum += beeperBit * elapsed;
    this.beeperTStatesAccum += elapsed;
  }

  /** Generate audio samples when enough T-states have accumulated. */
  generateSamples(audio: Audio, ay: AY3891x | null, is128k: boolean): void {
    while (this.beeperTStatesAccum >= this.tStatesPerSample) {
      this.beeperTStatesAccum -= this.tStatesPerSample;

      const beeperDuty = this.beeperAccum / this.tStatesPerSample;
      // DC-blocking high-pass filter: y[n] = alpha(y[n-1] + x[n] - x[n-1])
      const beeperRaw = beeperDuty * 0.8;
      this.beeperDCOut = this.beeperDCAlpha * (this.beeperDCOut + beeperRaw - this.beeperDCPrev);
      this.beeperDCPrev = beeperRaw;
      const beeperOut = this.beeperDCOut;

      let left: number, right: number;
      if (is128k && ay) {
        const aySample = ay.generateSampleStereo();
        left = aySample.left * this.ayGain + beeperOut * this.beeperGain;
        right = aySample.right * this.ayGain + beeperOut * this.beeperGain;
      } else {
        left = beeperOut * this.beeperGain;
        right = beeperOut * this.beeperGain;
      }

      audio.pushSample(
        Math.max(-1, Math.min(1, left)),
        Math.max(-1, Math.min(1, right))
      );

      this.beeperAccum = 0;
    }
  }

  reset(): void {
    this.beeperAccum = 0;
    this.beeperTStatesAccum = 0;
    this.beeperDCPrev = 0;
    this.beeperDCOut = 0;
    this.prevBeeperBit = 0;
  }
}
