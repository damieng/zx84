/**
 * TAP tape image format parser.
 *
 * TAP files contain a sequence of data blocks, each prefixed with a 2-byte
 * little-endian length. Each block's first byte is the flag byte and the last
 * byte is an XOR checksum. The payload is everything between flag and checksum.
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

export class TapeDeck {
  blocks: TAPBlock[] = [];
  position = 0;
  paused = false;

  /** Parse a TAP file into blocks */
  load(fileData: Uint8Array): void {
    this.blocks = [];
    this.position = 0;
    this.paused = false;

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
  }

  get loaded(): boolean {
    return this.blocks.length > 0;
  }

  get finished(): boolean {
    return this.position >= this.blocks.length;
  }
}
