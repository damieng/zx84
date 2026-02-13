/**
 * TZX tape image format parser.
 *
 * Extracts standard data blocks from TZX files into TAPBlock format
 * for use with the ROM-trap tape loader. Block types that carry
 * Spectrum data (0x10 standard, 0x11 turbo, 0x14 pure data) are
 * converted; timing/metadata blocks are skipped.
 */

import type { TAPBlock, TZXBlockMeta } from './tap.ts';

const TZX_MAGIC = [0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A]; // "ZXTape!\x1A"

function read16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function read24(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
}

function read32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

/** Extract a TAPBlock from raw block data (flag + payload + checksum). */
function extractBlock(raw: Uint8Array, tzx?: TZXBlockMeta): TAPBlock | null {
  if (raw.length < 2) return null;
  const block: TAPBlock = { flag: raw[0], data: raw.slice(1, raw.length - 1) };
  if (tzx) block.tzx = tzx;
  return block;
}

export function parseTZX(fileData: Uint8Array): TAPBlock[] {
  // Verify magic header
  for (let i = 0; i < TZX_MAGIC.length; i++) {
    if (fileData[i] !== TZX_MAGIC[i]) {
      throw new Error('Not a valid TZX file');
    }
  }

  const blocks: TAPBlock[] = [];
  let o = 10; // skip 8-byte magic + major + minor version

  while (o < fileData.length) {
    const id = fileData[o++];

    switch (id) {
      case 0x10: { // Standard Speed Data Block
        const pause = read16(fileData, o);
        const len = read16(fileData, o + 2);
        const meta: TZXBlockMeta = { type: 'standard', pause };
        const blk = extractBlock(fileData.slice(o + 4, o + 4 + len), meta);
        if (blk) blocks.push(blk);
        o += 4 + len;
        break;
      }
      case 0x11: { // Turbo Speed Data Block
        const pilotPulse = read16(fileData, o);
        const syncPulse1 = read16(fileData, o + 2);
        const syncPulse2 = read16(fileData, o + 4);
        const bit0Pulse = read16(fileData, o + 6);
        const bit1Pulse = read16(fileData, o + 8);
        const pilotCount = read16(fileData, o + 10);
        const usedBits = fileData[o + 12];
        const pause = read16(fileData, o + 13);
        const len = read24(fileData, o + 15);
        const meta: TZXBlockMeta = {
          type: 'turbo', pause, pilotPulse, syncPulse1, syncPulse2,
          bit0Pulse, bit1Pulse, pilotCount, usedBits,
        };
        const blk = extractBlock(fileData.slice(o + 18, o + 18 + len), meta);
        if (blk) blocks.push(blk);
        o += 18 + len;
        break;
      }
      case 0x12: // Pure Tone
        o += 4;
        break;
      case 0x13: // Pulse Sequence
        o += 1 + fileData[o] * 2;
        break;
      case 0x14: { // Pure Data Block
        const bit0Pulse = read16(fileData, o);
        const bit1Pulse = read16(fileData, o + 2);
        const usedBits = fileData[o + 4];
        const pause = read16(fileData, o + 5);
        const len = read24(fileData, o + 7);
        const meta: TZXBlockMeta = { type: 'pure-data', pause, bit0Pulse, bit1Pulse, usedBits };
        const raw = fileData.slice(o + 10, o + 10 + len);
        if (raw.length >= 2) {
          const blk = extractBlock(raw, meta);
          if (blk) blocks.push(blk);
        }
        o += 10 + len;
        break;
      }
      case 0x15: { // Direct Recording
        const len = read24(fileData, o + 5);
        o += 8 + len;
        break;
      }
      case 0x18: // CSW Recording
      case 0x19: { // Generalized Data Block
        o += 4 + read32(fileData, o);
        break;
      }
      case 0x20: // Pause / Stop the tape
        o += 2;
        break;
      case 0x21: // Group Start
        o += 1 + fileData[o];
        break;
      case 0x22: // Group End
        break;
      case 0x23: // Jump to Block
        o += 2;
        break;
      case 0x24: // Loop Start
        o += 2;
        break;
      case 0x25: // Loop End
        break;
      case 0x26: // Call Sequence
        o += 2 + read16(fileData, o) * 2;
        break;
      case 0x27: // Return from Sequence
        break;
      case 0x28: // Select Block
        o += 2 + read16(fileData, o);
        break;
      case 0x2A: // Stop tape if in 48K mode
        o += 4;
        break;
      case 0x2B: // Set Signal Level
        o += 4 + read32(fileData, o);
        break;
      case 0x30: // Text Description
        o += 1 + fileData[o];
        break;
      case 0x31: // Message Block
        o += 2 + fileData[o + 1];
        break;
      case 0x32: // Archive Info
        o += 2 + read16(fileData, o);
        break;
      case 0x33: // Hardware Type
        o += 1 + fileData[o] * 3;
        break;
      case 0x35: // Custom Info Block
        o += 20 + read32(fileData, o + 16);
        break;
      case 0x5A: // Glue block
        o += 9;
        break;
      default:
        throw new Error(`Unknown TZX block type 0x${id.toString(16).padStart(2, '0')} at offset ${o - 1}`);
    }
  }

  return blocks;
}
