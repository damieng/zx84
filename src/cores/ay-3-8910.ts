/*
  AY-3-8910 / YM2149 Sound Chip Emulator
  Provides two register-update modes:
    - writeRegister(reg, value)  — per-register writes (Z80 I/O driven)
    - setRegisters(regs)         — bulk frame load (YM file driven)
*/

// YM2149 DAC voltage levels (5-bit, 32 entries).
// Based on measured values from SC68 / real YM2149 chips.
// The YM2149 has 16 unique DAC levels — consecutive 5-bit pairs produce
// the same voltage (0/1 → same, 2/3 → same, etc.), unlike the AY-3-8910
// which has 32 distinct levels. ~3 dB per 4-bit step.
export const VOLUME_TABLE: number[] = [
  0.0000, 0.0000, 0.0128, 0.0128, 0.0185, 0.0185, 0.0271, 0.0271,
  0.0400, 0.0400, 0.0591, 0.0591, 0.0823, 0.0823, 0.1347, 0.1347,
  0.1586, 0.1586, 0.2549, 0.2549, 0.3561, 0.3561, 0.4469, 0.4469,
  0.5640, 0.5640, 0.7083, 0.7083, 0.8423, 0.8423, 1.0000, 1.0000
];

export type AYStereoMode = 'MONO' | 'ABC' | 'ACB' | 'BAC' | 'BCA' | 'CAB' | 'CBA';

export class AY3891x {
  chipFreq: number;
  sampleRate: number;
  cyclesPerSample: number;
  cycleFrac: number;

  // Tone generators (3 channels)
  toneCounter: Float64Array;
  toneOutput: Uint8Array;
  tonePeriod: Uint16Array;

  // Noise generator
  noiseCounter: number;
  noisePeriod: number;
  noiseOutput: number;
  noiseRng: number;

  // Envelope
  envCounter: number;
  envPeriod: number;
  envShape: number;
  envStep: number;
  envHolding: boolean;
  envVolume: number;
  envAttack: number;
  envContinue: boolean;
  envAlternate: boolean;
  envHold: boolean;

  // Mixer and amplitude
  mixer: number;
  amplitude: Uint8Array;

  // Registers
  regs: Uint8Array;

  // Selected register (for Z80 I/O port-driven access)
  selectedReg: number;

  // Stereo panning mode
  stereoMode: AYStereoMode;

  // DC-blocking filter — toggle for conformance testing (disable to match raw VGMPlay output)
  dcBlocking = true;

  // DC-blocking filter state (AC coupling, like real hardware's coupling capacitor)
  // y[n] = α * (y[n-1] + x[n] - x[n-1]), α ≈ 0.997 for ~20 Hz cutoff at 44.1 kHz
  private _dcAlpha: number;
  private _dcPrevL: number;
  private _dcPrevR: number;
  private _dcOutL: number;
  private _dcOutR: number;

  constructor(chipFreq: number, sampleRate: number, stereoMode: AYStereoMode = 'ABC') {
    this.chipFreq = chipFreq || 1773400;
    this.sampleRate = sampleRate;
    this.cyclesPerSample = this.chipFreq / (sampleRate * 8);
    this.cycleFrac = 0;
    this.stereoMode = stereoMode;

    this.toneCounter = new Float64Array(3);
    this.toneOutput = new Uint8Array(3);
    this.tonePeriod = new Uint16Array(3);

    this.noiseCounter = 0;
    this.noisePeriod = 0;
    this.noiseOutput = 0;
    this.noiseRng = 1;

    this.envCounter = 0;
    this.envPeriod = 0;
    this.envShape = 0;
    this.envStep = 0;
    this.envHolding = false;
    this.envVolume = 0;
    this.envAttack = 0;
    this.envContinue = false;
    this.envAlternate = false;
    this.envHold = false;

    this.mixer = 0;
    this.amplitude = new Uint8Array(3);

    this.regs = new Uint8Array(16);

    this.selectedReg = 0;

    // DC-blocking filter: cutoff ~20 Hz, adapts to any sample rate
    this._dcAlpha = 1 - (2 * Math.PI * 20 / sampleRate);
    this._dcPrevL = 0;
    this._dcPrevR = 0;
    this._dcOutL = 0;
    this._dcOutR = 0;
  }

  reset(): void {
    this.cycleFrac = 0;
    this.toneCounter.fill(0);
    this.toneOutput.fill(0);
    this.tonePeriod.fill(1);
    this.noiseCounter = 0;
    this.noisePeriod = 1;
    this.noiseOutput = 0;
    this.noiseRng = 1;
    this.envCounter = 0;
    this.envPeriod = 1;
    this.envShape = 0;
    this.envStep = 0;
    this.envHolding = false;
    this.envVolume = 0;
    this.envAttack = 0;
    this.envContinue = false;
    this.envAlternate = false;
    this.envHold = false;
    this.mixer = 0;
    this.amplitude.fill(0);
    this.regs.fill(0);
    this.selectedReg = 0;
    this._dcPrevL = 0;
    this._dcPrevR = 0;
    this._dcOutL = 0;
    this._dcOutR = 0;
  }

  writeRegister(reg: number, value: number): void {
    reg &= 0x0F;
    this.regs[reg] = value;

    switch (reg) {
      case 0: case 1:
        this.tonePeriod[0] = (this.regs[0] | ((this.regs[1] & 0x0F) << 8)) || 1;
        break;
      case 2: case 3:
        this.tonePeriod[1] = (this.regs[2] | ((this.regs[3] & 0x0F) << 8)) || 1;
        break;
      case 4: case 5:
        this.tonePeriod[2] = (this.regs[4] | ((this.regs[5] & 0x0F) << 8)) || 1;
        break;
      case 6:
        this.noisePeriod = (value & 0x1F) || 1;
        break;
      case 7:
        this.mixer = value;
        break;
      case 8:
        this.amplitude[0] = value & 0x1F;
        break;
      case 9:
        this.amplitude[1] = value & 0x1F;
        break;
      case 10:
        this.amplitude[2] = value & 0x1F;
        break;
      case 11: case 12:
        this.envPeriod = (this.regs[11] | (this.regs[12] << 8)) || 1;
        break;
      case 13:
        this.envShape = value & 0x0F;
        this.envStep = 0;
        this.envHolding = false;
        this.envContinue = (this.envShape & 0x08) !== 0;
        this.envAttack = (this.envShape & 0x04) ? 0x1F : 0x00;
        this.envAlternate = (this.envShape & 0x02) !== 0;
        this.envHold = (this.envShape & 0x01) !== 0;
        this.envVolume = this.envAttack ? 0 : 31;
        break;
    }
  }

  readRegister(reg: number): number {
    return this.regs[reg & 0x0F];
  }

  setRegisters(regs: Uint8Array): void {
    for (let i = 0; i < Math.min(regs.length, 14); i++) {
      this.regs[i] = regs[i];
    }

    this.tonePeriod[0] = (this.regs[0] | ((this.regs[1] & 0x0F) << 8)) || 1;
    this.tonePeriod[1] = (this.regs[2] | ((this.regs[3] & 0x0F) << 8)) || 1;
    this.tonePeriod[2] = (this.regs[4] | ((this.regs[5] & 0x0F) << 8)) || 1;
    this.noisePeriod = (this.regs[6] & 0x1F) || 1;
    this.mixer = this.regs[7];
    this.amplitude[0] = this.regs[8] & 0x1F;
    this.amplitude[1] = this.regs[9] & 0x1F;
    this.amplitude[2] = this.regs[10] & 0x1F;

    const newEnvPeriod = this.regs[11] | (this.regs[12] << 8);
    this.envPeriod = newEnvPeriod || 1;

    if (this.regs[13] !== 0xFF) {
      this.envShape = this.regs[13] & 0x0F;
      this.envStep = 0;
      this.envHolding = false;
      this.envContinue = (this.envShape & 0x08) !== 0;
      this.envAttack = (this.envShape & 0x04) ? 0x1F : 0x00;
      this.envAlternate = (this.envShape & 0x02) !== 0;
      this.envHold = (this.envShape & 0x01) !== 0;
      this.envVolume = this.envAttack ? 0 : 31;
    }
  }

  clock(): void {
    for (let ch = 0; ch < 3; ch++) {
      this.toneCounter[ch]++;
      if (this.toneCounter[ch] >= this.tonePeriod[ch]) {
        this.toneCounter[ch] = 0;
        this.toneOutput[ch] ^= 1;
      }
    }

    this.noiseCounter++;
    if (this.noiseCounter >= this.noisePeriod) {
      this.noiseCounter = 0;
      const bit = ((this.noiseRng ^ (this.noiseRng >>> 3)) & 1);
      this.noiseRng = (this.noiseRng >>> 1) | (bit << 16);
      this.noiseOutput = this.noiseRng & 1;
    }

    this.envCounter++;
    if (this.envCounter >= this.envPeriod) {
      this.envCounter = 0;
      if (!this.envHolding) {
        this.envStep++;
        if (this.envStep >= 32) {
          if (!this.envContinue) {
            this.envVolume = 0;
            this.envHolding = true;
          } else if (this.envHold) {
            if (this.envAlternate) {
              this.envVolume = this.envAttack ? 0 : 31;
            } else {
              this.envVolume = this.envAttack ? 31 : 0;
            }
            this.envHolding = true;
          } else if (this.envAlternate) {
            this.envAttack ^= 0x1F;
            this.envStep = 0;
          } else {
            this.envStep = 0;
          }
        }
        if (!this.envHolding) {
          this.envVolume = (this.envAttack ? this.envStep : (31 - this.envStep)) & 0x1F;
        }
      }
    }
  }

  private getChannelOutput(ch: number): number {
    const toneEnable = !((this.mixer >> ch) & 1);
    const noiseEnable = !((this.mixer >> (ch + 3)) & 1);

    const toneOut = toneEnable ? this.toneOutput[ch] : 1;
    const noiseOut = noiseEnable ? this.noiseOutput : 1;

    if (toneOut & noiseOut) {
      const amp = this.amplitude[ch];
      if (amp & 0x10) {
        return VOLUME_TABLE[this.envVolume];
      } else {
        if (amp > 0) {
          return VOLUME_TABLE[amp * 2 + 1];
        }
      }
    }
    return 0;
  }

  output(): number {
    let sum = 0;
    for (let ch = 0; ch < 3; ch++) {
      sum += this.getChannelOutput(ch);
    }
    return sum / 3 * 0.75;
  }

  // Pre-allocated stereo output — reused every call to avoid GC pressure in hot loop
  private readonly _stereoOut = { left: 0, right: 0 };

  // Stereo output with configurable panning modes
  outputStereo(): { left: number; right: number } {
    const a = this.getChannelOutput(0);
    const b = this.getChannelOutput(1);
    const c = this.getChannelOutput(2);
    const out = this._stereoOut;

    switch (this.stereoMode) {
      case 'MONO':
        out.left = out.right = (a + b + c) / 3 * 0.75;
        break;
      case 'ABC':
        out.left = (a + b * 0.5) / 1.5 * 0.75;
        out.right = (c + b * 0.5) / 1.5 * 0.75;
        break;
      case 'ACB':
        out.left = (a + c * 0.5) / 1.5 * 0.75;
        out.right = (b + c * 0.5) / 1.5 * 0.75;
        break;
      case 'BAC':
        out.left = (b + a * 0.5) / 1.5 * 0.75;
        out.right = (c + a * 0.5) / 1.5 * 0.75;
        break;
      case 'BCA':
        out.left = (b + c * 0.5) / 1.5 * 0.75;
        out.right = (a + c * 0.5) / 1.5 * 0.75;
        break;
      case 'CAB':
        out.left = (c + a * 0.5) / 1.5 * 0.75;
        out.right = (b + a * 0.5) / 1.5 * 0.75;
        break;
      case 'CBA':
        out.left = (c + b * 0.5) / 1.5 * 0.75;
        out.right = (a + b * 0.5) / 1.5 * 0.75;
        break;
      default:
        out.left = (a + b * 0.5) / 1.5 * 0.75;
        out.right = (c + b * 0.5) / 1.5 * 0.75;
    }

    return out;
  }

  generateSample(): number {
    this.cycleFrac += this.cyclesPerSample;
    while (this.cycleFrac >= 1) {
      this.cycleFrac--;
      this.clock();
    }
    const raw = this.output();
    if (this.dcBlocking) {
      // DC-blocking filter (AC coupling) — removes DC bias dynamically
      this._dcOutL = this._dcAlpha * (this._dcOutL + raw - this._dcPrevL);
      this._dcPrevL = raw;
      return this._dcOutL;
    }
    return raw;
  }

  generateSampleStereo(): { left: number; right: number } {
    this.cycleFrac += this.cyclesPerSample;
    while (this.cycleFrac >= 1) {
      this.cycleFrac--;
      this.clock();
    }
    const raw = this.outputStereo();
    if (this.dcBlocking) {
      // DC-blocking filter (AC coupling) — removes DC bias dynamically
      const outL = this._dcAlpha * (this._dcOutL + raw.left - this._dcPrevL);
      const outR = this._dcAlpha * (this._dcOutR + raw.right - this._dcPrevR);
      this._dcPrevL = raw.left;
      this._dcPrevR = raw.right;
      this._dcOutL = outL;
      this._dcOutR = outR;
      raw.left = outL;
      raw.right = outR;
    }
    return raw;
  }

  setStereoMode(mode: AYStereoMode): void {
    this.stereoMode = mode;
  }
}
