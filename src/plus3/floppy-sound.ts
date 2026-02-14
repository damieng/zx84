/**
 * Synthesised floppy drive soundscape.
 *
 * Motor drone, step clicks, and seek-to-zero rattle — all generated
 * from Web Audio oscillators and noise bursts. Connects directly to
 * ctx.destination via its own GainNode (independent of emulated audio).
 */

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

  /** Attach to an existing AudioContext (lazy — may not exist until first click). */
  attach(ctx: AudioContext): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.06;
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

    // Gain envelope
    this.motorGain = ctx.createGain();
    this.motorGain.gain.setValueAtTime(0, now);
    this.motorGain.gain.linearRampToValueAtTime(1, now + 0.1);
    this.motorGain.connect(this.masterGain);

    // Low sine drone (gentle hum, not buzzy)
    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = 'sine';
    this.motorOsc.frequency.value = 60;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.4;
    this.motorOsc.connect(oscGain);
    oscGain.connect(this.motorGain);
    this.motorOsc.start(now);

    // Band-pass filtered white noise (mechanical rumble)
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const noise = noiseBuf.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;

    this.motorNoise = ctx.createBufferSource();
    this.motorNoise.buffer = noiseBuf;
    this.motorNoise.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 80;
    bp.Q.value = 2;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.6;
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
      this.motorGain.gain.linearRampToValueAtTime(0, now + 0.15);
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

  // ── Step click ───────────────────────────────────────────────────────

  private stepClick(when?: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const t = when ?? ctx.currentTime;

    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.03), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(1, t);
    env.gain.exponentialRampToValueAtTime(0.01, t + 0.03);

    src.connect(bp);
    bp.connect(env);
    env.connect(this.masterGain);
    src.start(t);
    src.stop(t + 0.03);
  }

  // ── Seek-to-zero rattle ──────────────────────────────────────────────

  private seekToZero(fromTrack: number): void {
    if (!this.ctx) return;
    const count = Math.min(fromTrack, 80);
    const now = this.ctx.currentTime;
    for (let i = 0; i < count; i++) {
      this.stepClick(now + i * 0.008);
    }
  }

  // ── Scheduled clicks (multi-step seek) ───────────────────────────────

  private scheduledClicks(steps: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < steps; i++) {
      this.stepClick(now + i * 0.01);
    }
  }
}
