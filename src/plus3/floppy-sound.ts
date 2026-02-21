/**
 * Synthesised floppy drive soundscape.
 *
 * Two profiles:
 *  - "3inch" : Amstrad/Hitachi CF2 — clunky, resonant, pronounced engage click
 *  - "3.5inch": Sony/Alps 720K — smoother, higher-pitched, quieter seeks
 *
 * Motor drone, step clicks, and seek-to-zero rattle — all generated
 * from Web Audio oscillators and noise bursts. Connects directly to
 * ctx.destination via its own GainNode (independent of emulated audio).
 */

export type DriveType = '3inch' | '3.5inch';

interface DriveProfile {
  motorHumFreq: number;
  motorHumGain: number;
  motorNoiseFreq: number;
  motorNoiseQ: number;
  motorNoiseGain: number;
  motorRampUp: number;
  motorRampDown: number;
  engageHpStart: number;
  engageHpEnd: number;
  engageGain: number;
  engageLatchFreq: number;
  engageLatchQ: number;
  engageLatchGain: number;
  stepFreq: number;
  stepQ: number;
  stepGain: number;
  stepDur: number;
  seekInterval: number;
  seekToZeroInterval: number;
}

const PROFILES: Record<DriveType, DriveProfile> = {
  '3inch': {
    // Amstrad/Hitachi CF2 — chunky, mechanical, resonant
    motorHumFreq: 120, motorHumGain: 0.06,
    motorNoiseFreq: 160, motorNoiseQ: 4, motorNoiseGain: 0.1,
    motorRampUp: 0.1, motorRampDown: 0.15,
    engageHpStart: 3000, engageHpEnd: 400, engageGain: 0.3,
    engageLatchFreq: 1800, engageLatchQ: 5, engageLatchGain: 0.45,
    stepFreq: 1200, stepQ: 2, stepGain: 1.0, stepDur: 0.03,
    seekInterval: 0.01, seekToZeroInterval: 0.008,
  },
  '3.5inch': {
    // Sony/Alps 720K — smoother, lighter, higher-pitched
    motorHumFreq: 180, motorHumGain: 0.03,
    motorNoiseFreq: 280, motorNoiseQ: 3, motorNoiseGain: 0.06,
    motorRampUp: 0.06, motorRampDown: 0.1,
    engageHpStart: 4000, engageHpEnd: 800, engageGain: 0.15,
    engageLatchFreq: 2800, engageLatchQ: 3, engageLatchGain: 0.25,
    stepFreq: 2200, stepQ: 3, stepGain: 0.5, stepDur: 0.015,
    seekInterval: 0.006, seekToZeroInterval: 0.005,
  },
};

export class FloppySound {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  // Motor sound nodes
  private motorOsc: OscillatorNode | null = null;
  private motorNoise: AudioBufferSourceNode | null = null;
  private motorGain: GainNode | null = null;
  private motorRunning = false;

  // Previous state for edge detection
  private prevMotor = false;
  private prevTrack = 0;

  /** Current drive sound profile */
  driveType: DriveType = '3inch';

  private get P(): DriveProfile { return PROFILES[this.driveType]; }

  /** Attach to an existing AudioContext (lazy — may not exist until first click). */
  attach(ctx: AudioContext): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.4;
    this.masterGain.connect(ctx.destination);
  }

  /** Polling entry point — call every frame with current FDC state. */
  update(motorOn: boolean, track: number): void {
    if (!this.ctx || !this.masterGain) return;

    // Motor transitions
    if (motorOn && !this.prevMotor) this.startMotor();
    if (!motorOn && this.prevMotor) this.stopMotor();

    // Track transitions (only while motor is on)
    if (motorOn && track !== this.prevTrack) {
      const delta = Math.abs(track - this.prevTrack);
      if (track === 0 && this.prevTrack > 1) {
        // Seek-to-zero rattle
        this.seekToZero(this.prevTrack);
      } else if (delta === 1) {
        this.stepClick();
      } else if (delta > 1) {
        this.scheduledClicks(delta);
      }
    }

    this.prevMotor = motorOn;
    this.prevTrack = track;
  }

  /** Reset previous state to avoid false triggers after machine reset. */
  reset(): void {
    this.stopMotor();
    this.prevMotor = false;
    this.prevTrack = 0;
  }

  destroy(): void {
    this.stopMotor();
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.ctx = null;
  }

  // ── Motor sound ──────────────────────────────────────────────────────

  private startMotor(): void {
    if (!this.ctx || !this.masterGain || this.motorRunning) return;
    this.motorRunning = true;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const P = this.P;

    // Gain envelope
    this.motorGain = ctx.createGain();
    this.motorGain.gain.setValueAtTime(0, now);
    this.motorGain.gain.linearRampToValueAtTime(1, now + P.motorRampUp);
    this.motorGain.connect(this.masterGain);

    // Mechanical engage click
    this.motorStartClick(now);

    // Subtle motor hum
    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = 'sine';
    this.motorOsc.frequency.value = P.motorHumFreq;
    const oscGain = ctx.createGain();
    oscGain.gain.value = P.motorHumGain;
    this.motorOsc.connect(oscGain);
    oscGain.connect(this.motorGain);
    this.motorOsc.start(now);

    // Gentle filtered noise (soft whirr)
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const noise = noiseBuf.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;

    this.motorNoise = ctx.createBufferSource();
    this.motorNoise.buffer = noiseBuf;
    this.motorNoise.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = P.motorNoiseFreq;
    bp.Q.value = P.motorNoiseQ;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = P.motorNoiseGain;
    this.motorNoise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(this.motorGain);
    this.motorNoise.start(now);
  }

  private stopMotor(): void {
    if (!this.ctx || !this.motorRunning) return;
    this.motorRunning = false;
    const now = this.ctx.currentTime;

    if (this.motorGain) {
      this.motorGain.gain.cancelScheduledValues(now);
      this.motorGain.gain.setValueAtTime(this.motorGain.gain.value, now);
      this.motorGain.gain.linearRampToValueAtTime(0, now + this.P.motorRampDown);
    }

    const cleanup = () => {
      this.motorOsc?.stop();
      this.motorOsc?.disconnect();
      this.motorOsc = null;
      this.motorNoise?.stop();
      this.motorNoise?.disconnect();
      this.motorNoise = null;
      this.motorGain?.disconnect();
      this.motorGain = null;
    };
    setTimeout(cleanup, 200);
  }

  // ── Motor start click ─────────────────────────────────────────────

  private motorStartClick(now: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const P = this.P;
    const dur = 0.09;
    const samples = Math.ceil(ctx.sampleRate * dur);

    // Filtered noise sweep — mechanism engaging
    const noiseBuf = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(P.engageHpStart, now);
    hp.frequency.exponentialRampToValueAtTime(P.engageHpEnd, now + 0.06);

    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(P.engageGain, now);
    noiseEnv.gain.linearRampToValueAtTime(P.engageGain * 0.5, now + 0.04);
    noiseEnv.gain.exponentialRampToValueAtTime(0.01, now + dur);

    noiseSrc.connect(hp);
    hp.connect(noiseEnv);
    noiseEnv.connect(this.masterGain);
    noiseSrc.start(now);
    noiseSrc.stop(now + dur);

    // Sharp resonant click — latch catching
    const clickTime = now + 0.05;
    const clickBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.015), ctx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickData.length; i++) clickData[i] = Math.random() * 2 - 1;
    const clickSrc = ctx.createBufferSource();
    clickSrc.buffer = clickBuf;

    const clickBp = ctx.createBiquadFilter();
    clickBp.type = 'bandpass';
    clickBp.frequency.value = P.engageLatchFreq;
    clickBp.Q.value = P.engageLatchQ;

    const clickEnv = ctx.createGain();
    clickEnv.gain.setValueAtTime(P.engageLatchGain, clickTime);
    clickEnv.gain.exponentialRampToValueAtTime(0.01, clickTime + 0.015);

    clickSrc.connect(clickBp);
    clickBp.connect(clickEnv);
    clickEnv.connect(this.masterGain);
    clickSrc.start(clickTime);
    clickSrc.stop(clickTime + 0.015);
  }

  // ── Step click ───────────────────────────────────────────────────────

  private stepClick(when?: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const P = this.P;
    const t = when ?? ctx.currentTime;

    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * P.stepDur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = P.stepFreq;
    bp.Q.value = P.stepQ;

    const env = ctx.createGain();
    env.gain.setValueAtTime(P.stepGain, t);
    env.gain.exponentialRampToValueAtTime(0.01, t + P.stepDur);

    src.connect(bp);
    bp.connect(env);
    env.connect(this.masterGain);
    src.start(t);
    src.stop(t + P.stepDur);
  }

  // ── Seek-to-zero rattle ──────────────────────────────────────────────

  private seekToZero(fromTrack: number): void {
    if (!this.ctx) return;
    const count = Math.min(fromTrack, 80);
    const now = this.ctx.currentTime;
    for (let i = 0; i < count; i++) {
      this.stepClick(now + i * this.P.seekToZeroInterval);
    }
  }

  // ── Scheduled clicks (multi-step seek) ───────────────────────────────

  private scheduledClicks(steps: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < steps; i++) {
      this.stepClick(now + i * this.P.seekInterval);
    }
  }
}
