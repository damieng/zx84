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

    // Gain envelope
    this.motorGain = ctx.createGain();
    this.motorGain.gain.setValueAtTime(0, now);
    this.motorGain.gain.linearRampToValueAtTime(1, now + 0.1);
    this.motorGain.connect(this.masterGain);

    // Mechanical engage "kurlick" — short downward sweep + noise burst
    this.motorStartClick(now);

    // Subtle motor hum
    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = 'sine';
    this.motorOsc.frequency.value = 120;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.06;
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
    bp.frequency.value = 160;
    bp.Q.value = 4;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.1;
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

  // ── Motor start "kurlick" ───────────────────────────────────────────

  private motorStartClick(now: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const dur = 0.09;
    const samples = Math.ceil(ctx.sampleRate * dur);

    // "shuhh" — filtered noise that sweeps downward, like a mechanism sliding
    const noiseBuf = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(3000, now);
    hp.frequency.exponentialRampToValueAtTime(400, now + 0.06);

    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.3, now);
    noiseEnv.gain.linearRampToValueAtTime(0.15, now + 0.04);
    noiseEnv.gain.exponentialRampToValueAtTime(0.01, now + dur);

    noiseSrc.connect(hp);
    hp.connect(noiseEnv);
    noiseEnv.connect(this.masterGain);
    noiseSrc.start(now);
    noiseSrc.stop(now + dur);

    // "ckl" — sharp resonant click at the end, like a latch catching
    const clickTime = now + 0.05;
    const clickBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.015), ctx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickData.length; i++) clickData[i] = Math.random() * 2 - 1;
    const clickSrc = ctx.createBufferSource();
    clickSrc.buffer = clickBuf;

    const clickBp = ctx.createBiquadFilter();
    clickBp.type = 'bandpass';
    clickBp.frequency.value = 1800;
    clickBp.Q.value = 5;

    const clickEnv = ctx.createGain();
    clickEnv.gain.setValueAtTime(0.45, clickTime);
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
