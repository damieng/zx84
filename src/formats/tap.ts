/**
 * TAP tape image format parser + pulse-level tape playback engine.
 *
 * TAP files contain a sequence of data blocks, each prefixed with a 2-byte
 * little-endian length. Each block's first byte is the flag byte and the last
 * byte is an XOR checksum. The payload is everything between flag and checksum.
 *
 * The playback engine converts blocks to pulse sequences (pilot, sync, data)
 * and feeds the EAR bit based on T-state timing. This allows both standard ROM
 * loading and custom loaders that read the EAR port directly.
 */

export type TZXBlockType = 'standard' | 'turbo' | 'pure-data';

export interface TZXBlockMeta {
  type: TZXBlockType;
  pause: number;
  pilotPulse?: number;
  syncPulse1?: number;
  syncPulse2?: number;
  bit0Pulse?: number;
  bit1Pulse?: number;
  pilotCount?: number;
  usedBits?: number;
}

export interface TAPBlock {
  /** Flag byte (0x00 = header, 0xFF = data) */
  flag: number;
  /** Payload data (excludes flag and checksum bytes) */
  data: Uint8Array;
  /** TZX block metadata (only present for blocks loaded from TZX files) */
  tzx?: TZXBlockMeta;
}

// ── Standard Spectrum tape timing (T-states per half-cycle) ──────────────

const PILOT_PULSE = 2168;
const PILOT_HEADER = 8063;  // pilot pulses for header blocks (flag=0x00)
const PILOT_DATA = 3223;    // pilot pulses for data blocks (flag=0xFF)
const SYNC_1 = 667;
const SYNC_2 = 735;
const BIT_0 = 855;
const BIT_1 = 1710;
const PAUSE_DEFAULT_MS = 1000;
const Z80_CLOCK = 3500000;

const enum TapePhase {
  IDLE,
  PILOT,
  SYNC1,
  SYNC2,
  DATA,
  PAUSE,
}

export class TapeDeck {
  blocks: TAPBlock[] = [];
  position = 0;
  paused = false;

  // ── Playback engine state ──────────────────────────────────────────────

  /** Current EAR output bit (0 or 1) */
  earBit = 0;

  /** Whether the tape player is actively running */
  playing = false;

  private phase: TapePhase = TapePhase.IDLE;
  private playbackIdx = -1;

  /** Pilot tone pulses remaining */
  private pilotRemaining = 0;

  /** Current pulse length in T-states */
  private pulseLen = 0;

  /** T-states accumulated within the current pulse */
  private tInPulse = 0;

  /** Reconstructed raw block data (flag + payload + checksum) */
  private rawData: Uint8Array | null = null;

  /** Data phase position */
  private byteIdx = 0;
  private bitIdx = 0;       // 7 down to 0 (MSB first)
  private pulseHalf = 0;    // 0 or 1 (two half-cycles per data bit)

  /** Number of used bits in the last byte (default 8) */
  private usedBitsLast = 8;

  /** Pause remaining in T-states */
  private pauseRemaining = 0;

  /** Per-block timing (from TZX metadata or standard defaults) */
  private bPilot = PILOT_PULSE;
  private bSync1 = SYNC_1;
  private bSync2 = SYNC_2;
  private bBit0 = BIT_0;
  private bBit1 = BIT_1;

  // ── TAP parser ─────────────────────────────────────────────────────────

  /** Parse a TAP file into blocks */
  load(fileData: Uint8Array): void {
    this.blocks = [];
    this.position = 0;
    this.paused = false;
    this.stopPlayback();

    let offset = 0;
    while (offset + 2 <= fileData.length) {
      const blockLen = fileData[offset] | (fileData[offset + 1] << 8);
      offset += 2;

      if (blockLen < 2 || offset + blockLen > fileData.length) break;

      const flag = fileData[offset];
      // Payload is everything between flag and checksum
      const data = fileData.slice(offset + 1, offset + blockLen - 1);

      this.blocks.push({ flag, data });
      offset += blockLen;
    }
  }

  /** Return the current block and advance, or null if finished */
  nextBlock(): TAPBlock | null {
    if (this.position >= this.blocks.length) return null;
    return this.blocks[this.position++];
  }

  /** Reset playback to the beginning */
  rewind(): void {
    this.position = 0;
    if (this.playing) {
      this.beginBlock(0);
    }
  }

  get loaded(): boolean {
    return this.blocks.length > 0;
  }

  get finished(): boolean {
    return this.position >= this.blocks.length;
  }

  // ── Playback control ──────────────────────────────────────────────────

  /** Start pulse-level playback from the current position */
  startPlayback(): void {
    this.playing = true;
    this.earBit = 0;
    this.beginBlock(this.position);
  }

  /** Stop playback */
  stopPlayback(): void {
    this.playing = false;
    this.phase = TapePhase.IDLE;
    this.earBit = 0;
    this.rawData = null;
  }

  /**
   * Skip the current block (called after ROM trap instant-loads it).
   * Advances the player to start playing the next block.
   */
  skipBlock(): void {
    if (!this.playing) {
      this.playing = true;
      this.earBit = 0;
    }
    // position was already advanced by nextBlock()
    this.beginBlock(this.position);
  }

  /**
   * Advance playback by the given number of T-states.
   * Toggles earBit at pulse boundaries.
   */
  advance(tStates: number): void {
    if (!this.playing || this.paused || this.phase === TapePhase.IDLE) return;

    if (this.phase === TapePhase.PAUSE) {
      this.pauseRemaining -= tStates;
      if (this.pauseRemaining <= 0) {
        this.beginBlock(this.playbackIdx + 1);
      }
      return;
    }

    this.tInPulse += tStates;
    while (this.tInPulse >= this.pulseLen &&
           (this.phase as number) !== TapePhase.IDLE &&
           (this.phase as number) !== TapePhase.PAUSE) {
      this.tInPulse -= this.pulseLen;
      this.earBit ^= 1;
      this.advancePulse();
    }
  }

  // ── Internal playback mechanics ───────────────────────────────────────

  private beginBlock(idx: number): void {
    if (idx >= this.blocks.length) {
      this.phase = TapePhase.IDLE;
      this.playing = false;
      this.rawData = null;
      return;
    }

    this.playbackIdx = idx;
    const block = this.blocks[idx];
    this.rawData = this.buildRawData(block);
    this.tInPulse = 0;

    // Get timing from TZX metadata or use standard defaults
    const tzx = block.tzx;
    this.bPilot = tzx?.pilotPulse ?? PILOT_PULSE;
    this.bSync1 = tzx?.syncPulse1 ?? SYNC_1;
    this.bSync2 = tzx?.syncPulse2 ?? SYNC_2;
    this.bBit0 = tzx?.bit0Pulse ?? BIT_0;
    this.bBit1 = tzx?.bit1Pulse ?? BIT_1;
    this.usedBitsLast = tzx?.usedBits ?? 8;
    const pauseMs = tzx?.pause ?? PAUSE_DEFAULT_MS;
    this.pauseRemaining = Math.round(pauseMs * Z80_CLOCK / 1000);

    if (tzx?.type === 'pure-data') {
      // Pure data blocks: no pilot or sync, straight to data
      this.phase = TapePhase.DATA;
      this.byteIdx = 0;
      this.bitIdx = 7;
      this.pulseHalf = 0;
      this.setDataPulseLen();
    } else {
      // Standard / turbo: pilot → sync → data
      this.phase = TapePhase.PILOT;
      if (tzx?.pilotCount !== undefined) {
        this.pilotRemaining = tzx.pilotCount;
      } else {
        this.pilotRemaining = (block.flag === 0x00) ? PILOT_HEADER : PILOT_DATA;
      }
      this.pulseLen = this.bPilot;
    }
  }

  private advancePulse(): void {
    switch (this.phase) {
      case TapePhase.PILOT:
        this.pilotRemaining--;
        if (this.pilotRemaining <= 0) {
          this.phase = TapePhase.SYNC1;
          this.pulseLen = this.bSync1;
        }
        // else pulseLen stays as bPilot
        break;

      case TapePhase.SYNC1:
        this.phase = TapePhase.SYNC2;
        this.pulseLen = this.bSync2;
        break;

      case TapePhase.SYNC2:
        this.phase = TapePhase.DATA;
        this.byteIdx = 0;
        this.bitIdx = 7;
        this.pulseHalf = 0;
        this.setDataPulseLen();
        break;

      case TapePhase.DATA:
        this.pulseHalf++;
        if (this.pulseHalf >= 2) {
          this.pulseHalf = 0;
          this.bitIdx--;

          // Check if we've finished the last used bit of the last byte
          const isLastByte = this.byteIdx === this.rawData!.length - 1;
          if (isLastByte && this.bitIdx < (8 - this.usedBitsLast)) {
            this.enterPause();
            return;
          }

          if (this.bitIdx < 0) {
            this.byteIdx++;
            this.bitIdx = 7;
            if (this.byteIdx >= this.rawData!.length) {
              this.enterPause();
              return;
            }
          }

          this.setDataPulseLen();
        }
        // else pulseLen stays same (second half-cycle of same bit)
        break;
    }
  }

  private setDataPulseLen(): void {
    const byte = this.rawData![this.byteIdx];
    const bit = (byte >> this.bitIdx) & 1;
    this.pulseLen = bit ? this.bBit1 : this.bBit0;
  }

  private enterPause(): void {
    this.phase = TapePhase.PAUSE;
    this.earBit = 0;
    // Advance deck position past this completed block
    this.position = this.playbackIdx + 1;
  }

  /** Reconstruct raw block bytes: flag + payload + XOR checksum */
  private buildRawData(block: TAPBlock): Uint8Array {
    const raw = new Uint8Array(block.data.length + 2);
    raw[0] = block.flag;
    raw.set(block.data, 1);
    let checksum = block.flag;
    for (let i = 0; i < block.data.length; i++) checksum ^= block.data[i];
    raw[raw.length - 1] = checksum;
    return raw;
  }
}
