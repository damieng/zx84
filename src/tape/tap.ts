/**
 * TAP tape image format parser + pulse-level tape playback engine.
 *
 * TAP files contain a sequence of data blocks, each prefixed with a 2-byte
 * little-endian length. Each block's first byte is the flag byte and the last
 * byte is an XOR checksum. The payload is everything between flag and checksum.
 *
 * The playback engine converts blocks to pulse sequences (pilot, sync, data,
 * tone, pulses, direct) and feeds the EAR bit based on T-state timing. This
 * allows both standard ROM loading and custom loaders that read the EAR port
 * directly.
 */

// ── TapeBlock discriminated union ─────────────────────────────────────────

export interface DataBlock {
  kind: 'data';
  flag: number;
  data: Uint8Array;
  pause: number;              // ms
  pilotPulse: number;         // T-states (0 for pure-data)
  syncPulse1: number;
  syncPulse2: number;
  bit0Pulse: number;
  bit1Pulse: number;
  pilotCount: number;         // 0 = skip pilot/sync (pure-data)
  usedBits: number;           // last byte
  source: 'tap' | 'standard' | 'turbo' | 'pure-data';
}

export interface ToneBlock     { kind: 'tone'; pulseLen: number; count: number; }
export interface PulsesBlock   { kind: 'pulses'; lengths: number[]; }
export interface PauseBlock    { kind: 'pause'; duration: number; }  // 0 = stop tape
export interface DirectBlock   { kind: 'direct'; tStatesPerSample: number; pause: number; usedBits: number; data: Uint8Array; }
export interface SetLevelBlock { kind: 'set-level'; level: number; }
export interface StopIf48KBlock { kind: 'stop-if-48k'; }
export interface GroupStartBlock { kind: 'group-start'; name: string; }
export interface GroupEndBlock { kind: 'group-end'; }
export interface TextBlock     { kind: 'text'; text: string; }
export interface ArchiveInfoBlock { kind: 'archive-info'; entries: { id: number; text: string }[]; }

export type TapeBlock = DataBlock | ToneBlock | PulsesBlock | PauseBlock | DirectBlock
  | SetLevelBlock | StopIf48KBlock | GroupStartBlock | GroupEndBlock | TextBlock | ArchiveInfoBlock;

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

/** Edge flags for the loader accelerator */
export const EDGE_FLAG_NONE = 0;
export const EDGE_FLAG_SHORT = 1;
export const EDGE_FLAG_LONG = 2;

/**
 * Threshold T-states to distinguish short vs long pulses.
 * Standard Spectrum: bit-0 = 855T, bit-1 = 1710T. Midpoint ≈ 1282T.
 * Turbo loaders use different timing; we use each block's own thresholds.
 */
const DEFAULT_SHORT_LONG_THRESHOLD = 1282;

const enum TapePhase {
  IDLE,
  PILOT,
  SYNC1,
  SYNC2,
  DATA,
  PAUSE,
  TONE,
  PULSES,
  DIRECT,
}

export class TapeDeck {
  blocks: TapeBlock[] = [];
  position = 0;
  paused = false;

  /** Whether the machine is a 48K model (used by stop-if-48k blocks) */
  is48K = false;

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

  /** Reconstructed raw block data (flag + payload + checksum) for data blocks */
  private rawData: Uint8Array | null = null;

  /** Data phase position */
  private byteIdx = 0;
  private bitIdx = 0;       // 7 down to 0 (MSB first)
  private pulseHalf = 0;    // 0 or 1 (two half-cycles per data bit)

  /** Number of used bits in the last byte (default 8) */
  private usedBitsLast = 8;

  /** Pause remaining in T-states */
  private pauseRemaining = 0;

  /** Per-block timing (from DataBlock) */
  private bPilot = PILOT_PULSE;
  private bSync1 = SYNC_1;
  private bSync2 = SYNC_2;
  private bBit0 = BIT_0;
  private bBit1 = BIT_1;

  /** Tone block: pulses remaining */
  private toneRemaining = 0;

  /** Pulses block: current index into lengths array */
  private pulsesIdx = 0;
  private pulsesLengths: number[] = [];

  /** Direct block state */
  private directData: Uint8Array | null = null;
  private directTStatesPerSample = 0;
  private directByteIdx = 0;
  private directBitIdx = 0;
  private directUsedBitsLast = 8;
  private directPauseMs = 0;

  /** Edge flags: SHORT or LONG, updated when earBit toggles */
  lastEdgeFlags = EDGE_FLAG_NONE;

  /** Per-block threshold for distinguishing short vs long pulses */
  private shortLongThreshold = DEFAULT_SHORT_LONG_THRESHOLD;

  // ── TAP parser ─────────────────────────────────────────────────────────

  /** Parse a TAP file and return blocks without modifying deck state */
  parseTAP(fileData: Uint8Array): TapeBlock[] {
    const blocks: TapeBlock[] = [];
    let offset = 0;
    while (offset + 2 <= fileData.length) {
      const blockLen = fileData[offset] | (fileData[offset + 1] << 8);
      offset += 2;

      if (blockLen < 2 || offset + blockLen > fileData.length) break;

      const flag = fileData[offset];
      // Payload is everything between flag and checksum
      const data = fileData.slice(offset + 1, offset + blockLen - 1);

      blocks.push({
        kind: 'data',
        flag,
        data,
        pause: PAUSE_DEFAULT_MS,
        pilotPulse: PILOT_PULSE,
        syncPulse1: SYNC_1,
        syncPulse2: SYNC_2,
        bit0Pulse: BIT_0,
        bit1Pulse: BIT_1,
        pilotCount: flag === 0x00 ? PILOT_HEADER : PILOT_DATA,
        usedBits: 8,
        source: 'tap',
      });
      offset += blockLen;
    }
    return blocks;
  }

  /** Parse a TAP file into blocks (legacy — sets deck state) */
  load(fileData: Uint8Array): void {
    this.blocks = this.parseTAP(fileData);
    this.position = 0;
    this.paused = false;
    this.stopPlayback();
  }

  /**
   * Return the next ROM-loadable data block and advance past it, or null.
   * Only returns standard/turbo/tap DataBlocks — never pure-data, tone,
   * pulses, or direct blocks (those are for EAR-reading custom loaders).
   * Skips cosmetic and pause blocks. Stops scanning at custom loader blocks
   * so the playback engine can feed them through EAR.
   */
  nextDataBlock(): DataBlock | null {
    while (this.position < this.blocks.length) {
      const block = this.blocks[this.position];

      if (block.kind === 'data') {
        if (block.source === 'pure-data') {
          // Pure data is for custom loaders reading EAR, not the ROM trap
          return null;
        }
        this.position++;
        return block;
      }

      // Custom loader blocks — stop here, don't scan past them
      if (block.kind === 'tone' || block.kind === 'pulses' || block.kind === 'direct') {
        return null;
      }

      // Pause: duration=0 means "stop tape"
      if (block.kind === 'pause') {
        if (block.duration === 0) {
          this.paused = true;
          this.position++;
          return null;
        }
        // Non-zero pause: skip (ROM trap bypasses inter-block gaps)
        this.position++;
        continue;
      }

      // Stop if 48K
      if (block.kind === 'stop-if-48k') {
        if (this.is48K) {
          this.paused = true;
          this.position++;
          return null;
        }
        this.position++;
        continue;
      }

      // Cosmetic / control blocks: skip
      this.position++;
    }
    return null;
  }

  /**
   * Peek ahead: returns true if there's a ROM-loadable DataBlock before any
   * custom loader blocks. Used to decide whether the ROM trap should fire
   * (prevents busy-loop retries when only custom blocks remain).
   */
  hasRomBlock(): boolean {
    for (let i = this.position; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.kind === 'data') return block.source !== 'pure-data';
      if (block.kind === 'tone' || block.kind === 'pulses' || block.kind === 'direct') return false;
      if (block.kind === 'pause' && block.duration === 0) return false;
      if (block.kind === 'stop-if-48k' && this.is48K) return false;
      // cosmetic/pause blocks: continue scanning
    }
    return false;
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
    this.directData = null;
  }

  /**
   * Advance the tape to the next edge (earBit toggle).
   * Used by the loader accelerator to fast-forward through the current
   * pulse so the EAR bit toggles immediately.
   *
   * This calls advance() with exactly enough T-states to complete the
   * current pulse, so all normal bookkeeping (phase transitions, edge
   * flags, etc.) happens through the same code path as real-time playback.
   *
   * Returns null if the tape has no more edges (finished/paused/idle).
   */
  nextEdge(): { tStates: number; flags: number } | null {
    if (!this.playing || this.paused || this.phase === TapePhase.IDLE) return null;
    if (this.phase === TapePhase.PAUSE || this.phase === TapePhase.DIRECT) return null;

    const remaining = this.pulseLen - this.tInPulse;
    if (remaining <= 0) return null;

    // Save earBit before advance to detect the toggle
    const earBefore = this.earBit;

    // Feed exactly enough T-states to complete this pulse
    this.advance(remaining);

    // If earBit toggled, the edge happened
    if (this.earBit !== earBefore) {
      return { tStates: remaining, flags: this.lastEdgeFlags };
    }

    return null;
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
    // position was already advanced by nextDataBlock()
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

    if (this.phase === TapePhase.DIRECT) {
      this.advanceDirect(tStates);
      return;
    }

    this.tInPulse += tStates;
    while (this.tInPulse >= this.pulseLen &&
           (this.phase as number) !== TapePhase.IDLE &&
           (this.phase as number) !== TapePhase.PAUSE &&
           (this.phase as number) !== TapePhase.DIRECT) {
      // Record edge flags before toggling: was the completing pulse short or long?
      this.lastEdgeFlags = this.pulseLen >= this.shortLongThreshold
        ? EDGE_FLAG_LONG : EDGE_FLAG_SHORT;
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
      this.directData = null;
      return;
    }

    this.playbackIdx = idx;
    const block = this.blocks[idx];
    this.tInPulse = 0;

    switch (block.kind) {
      case 'data':
        this.beginDataBlock(block);
        break;

      case 'tone':
        this.phase = TapePhase.TONE;
        this.toneRemaining = block.count;
        this.pulseLen = block.pulseLen;
        break;

      case 'pulses':
        if (block.lengths.length === 0) {
          this.beginBlock(idx + 1);
          return;
        }
        this.phase = TapePhase.PULSES;
        this.pulsesLengths = block.lengths;
        this.pulsesIdx = 0;
        this.pulseLen = block.lengths[0];
        break;

      case 'pause':
        if (block.duration === 0) {
          this.paused = true;
          this.position = idx + 1;
          this.phase = TapePhase.IDLE;
          return;
        }
        this.position = idx + 1;
        this.phase = TapePhase.PAUSE;
        this.earBit = 0;
        this.pauseRemaining = Math.round(block.duration * Z80_CLOCK / 1000);
        break;

      case 'direct':
        this.beginDirectBlock(block);
        break;

      case 'set-level':
        this.earBit = block.level;
        this.position = idx + 1;
        this.beginBlock(idx + 1);
        return;

      case 'stop-if-48k':
        this.position = idx + 1;
        if (this.is48K) {
          this.paused = true;
          this.phase = TapePhase.IDLE;
          return;
        }
        this.beginBlock(idx + 1);
        return;

      // Cosmetic blocks — skip immediately
      case 'group-start':
      case 'group-end':
      case 'text':
      case 'archive-info':
        this.position = idx + 1;
        this.beginBlock(idx + 1);
        return;
    }
  }

  private beginDataBlock(block: DataBlock): void {
    // Pure data blocks store raw bytes directly (not TAP flag+payload+checksum format)
    this.rawData = block.source === 'pure-data' ? block.data : this.buildRawData(block);

    this.bPilot = block.pilotPulse;
    this.bSync1 = block.syncPulse1;
    this.bSync2 = block.syncPulse2;
    this.bBit0 = block.bit0Pulse;
    this.bBit1 = block.bit1Pulse;
    this.usedBitsLast = block.usedBits;
    // Set threshold midpoint between bit-0 and bit-1 pulse lengths
    this.shortLongThreshold = (block.bit0Pulse + block.bit1Pulse) >> 1;
    this.pauseRemaining = Math.round(block.pause * Z80_CLOCK / 1000);

    if (block.pilotCount === 0) {
      // Pure data blocks: no pilot or sync, straight to data
      this.phase = TapePhase.DATA;
      this.byteIdx = 0;
      this.bitIdx = 7;
      this.pulseHalf = 0;
      this.setDataPulseLen();
    } else {
      // Standard / turbo: pilot → sync → data
      this.phase = TapePhase.PILOT;
      this.pilotRemaining = block.pilotCount;
      this.pulseLen = this.bPilot;
    }
  }

  private beginDirectBlock(block: DirectBlock): void {
    this.phase = TapePhase.DIRECT;
    this.directData = block.data;
    this.directTStatesPerSample = block.tStatesPerSample;
    this.directByteIdx = 0;
    this.directBitIdx = 7;
    this.directUsedBitsLast = block.usedBits;
    this.directPauseMs = block.pause;
    this.tInPulse = 0;
    // Set initial EAR from first bit
    if (block.data.length > 0) {
      this.earBit = (block.data[0] >> 7) & 1;
    }
  }

  private advanceDirect(tStates: number): void {
    this.tInPulse += tStates;
    while (this.tInPulse >= this.directTStatesPerSample) {
      this.tInPulse -= this.directTStatesPerSample;

      this.directBitIdx--;

      // Check if we've finished the last used bit of the last byte
      const isLastByte = this.directByteIdx === this.directData!.length - 1;
      if (isLastByte && this.directBitIdx < (8 - this.directUsedBitsLast)) {
        // End of direct block — enter pause
        this.position = this.playbackIdx + 1;
        if (this.directPauseMs > 0) {
          this.phase = TapePhase.PAUSE;
          this.earBit = 0;
          this.pauseRemaining = Math.round(this.directPauseMs * Z80_CLOCK / 1000);
        } else {
          this.beginBlock(this.playbackIdx + 1);
        }
        this.directData = null;
        return;
      }

      if (this.directBitIdx < 0) {
        this.directByteIdx++;
        this.directBitIdx = 7;
        if (this.directByteIdx >= this.directData!.length) {
          this.position = this.playbackIdx + 1;
          if (this.directPauseMs > 0) {
            this.phase = TapePhase.PAUSE;
            this.earBit = 0;
            this.pauseRemaining = Math.round(this.directPauseMs * Z80_CLOCK / 1000);
          } else {
            this.beginBlock(this.playbackIdx + 1);
          }
          this.directData = null;
          return;
        }
      }

      // Set EAR absolutely (not toggle)
      this.earBit = (this.directData![this.directByteIdx] >> this.directBitIdx) & 1;
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

      case TapePhase.TONE:
        this.toneRemaining--;
        if (this.toneRemaining <= 0) {
          this.position = this.playbackIdx + 1;
          this.beginBlock(this.playbackIdx + 1);
        }
        break;

      case TapePhase.PULSES:
        this.pulsesIdx++;
        if (this.pulsesIdx >= this.pulsesLengths.length) {
          this.position = this.playbackIdx + 1;
          this.beginBlock(this.playbackIdx + 1);
        } else {
          this.pulseLen = this.pulsesLengths[this.pulsesIdx];
        }
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
  private buildRawData(block: DataBlock): Uint8Array {
    const raw = new Uint8Array(block.data.length + 2);
    raw[0] = block.flag;
    raw.set(block.data, 1);
    let checksum = block.flag;
    for (let i = 0; i < block.data.length; i++) checksum ^= block.data[i];
    raw[raw.length - 1] = checksum;
    return raw;
  }
}
