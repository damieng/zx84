/**
 * TZX tape image format parser.
 *
 * Parses TZX files into a TapeBlock[] array using the discriminated union
 * type system. All meaningful block types are extracted: data blocks (0x10,
 * 0x11, 0x14), pure tone (0x12), pulse sequence (0x13), direct recording
 * (0x15), pause/stop (0x20), groups (0x21/22), loops (0x24/25), stop-if-48k
 * (0x2A), set signal level (0x2B), text (0x30), and archive info (0x32).
 * Loops are expanded at parse time.
 */

import type { TapeBlock, DataBlock } from './tap.ts';

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

function readString(d: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(d[o + i]);
  return s;
}

/** Extract a DataBlock from raw block data with baked-in timing. */
function extractDataBlock(
  raw: Uint8Array,
  pause: number,
  pilotPulse: number,
  syncPulse1: number,
  syncPulse2: number,
  bit0Pulse: number,
  bit1Pulse: number,
  pilotCount: number,
  usedBits: number,
  source: DataBlock['source'],
): DataBlock | null {
  if (raw.length < 2) return null;
  return {
    kind: 'data',
    flag: raw[0],
    data: raw.slice(1, raw.length - 1),
    pause,
    pilotPulse,
    syncPulse1,
    syncPulse2,
    bit0Pulse,
    bit1Pulse,
    pilotCount,
    usedBits,
    source,
  };
}

export function parseTZX(fileData: Uint8Array): TapeBlock[] {
  // Verify magic header
  for (let i = 0; i < TZX_MAGIC.length; i++) {
    if (fileData[i] !== TZX_MAGIC[i]) {
      throw new Error('Not a valid TZX file');
    }
  }

  const blocks: TapeBlock[] = [];
  let o = 10; // skip 8-byte magic + major + minor version

  // Loop expansion state
  let loopStart = -1;
  let loopCount = 0;

  while (o < fileData.length) {
    const id = fileData[o++];

    switch (id) {
      case 0x10: { // Standard Speed Data Block
        const pause = read16(fileData, o);
        const len = read16(fileData, o + 2);
        const raw = fileData.slice(o + 4, o + 4 + len);
        const pilotCount = raw.length > 0 && raw[0] === 0x00 ? 8063 : 3223;
        const blk = extractDataBlock(raw, pause, 2168, 667, 735, 855, 1710, pilotCount, 8, 'standard');
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
        const raw = fileData.slice(o + 18, o + 18 + len);
        const blk = extractDataBlock(raw, pause, pilotPulse, syncPulse1, syncPulse2, bit0Pulse, bit1Pulse, pilotCount, usedBits, 'turbo');
        if (blk) blocks.push(blk);
        o += 18 + len;
        break;
      }
      case 0x12: { // Pure Tone
        const pulseLen = read16(fileData, o);
        const count = read16(fileData, o + 2);
        blocks.push({ kind: 'tone', pulseLen, count });
        o += 4;
        break;
      }
      case 0x13: { // Pulse Sequence
        const count = fileData[o];
        const lengths: number[] = [];
        for (let i = 0; i < count; i++) {
          lengths.push(read16(fileData, o + 1 + i * 2));
        }
        blocks.push({ kind: 'pulses', lengths });
        o += 1 + count * 2;
        break;
      }
      case 0x14: { // Pure Data Block
        // Pure data is NOT in TAP format — no flag byte or checksum.
        // Store raw bytes directly; the playback engine uses them as-is.
        const bit0Pulse = read16(fileData, o);
        const bit1Pulse = read16(fileData, o + 2);
        const usedBits = fileData[o + 4];
        const pause = read16(fileData, o + 5);
        const len = read24(fileData, o + 7);
        const data = fileData.slice(o + 10, o + 10 + len);
        if (data.length > 0) {
          blocks.push({
            kind: 'data',
            flag: 0xFF,
            data,
            pause,
            pilotPulse: 0,
            syncPulse1: 0,
            syncPulse2: 0,
            bit0Pulse,
            bit1Pulse,
            pilotCount: 0,
            usedBits,
            source: 'pure-data',
          });
        }
        o += 10 + len;
        break;
      }
      case 0x15: { // Direct Recording
        const tStatesPerSample = read16(fileData, o);
        const pause = read16(fileData, o + 2);
        const usedBits = fileData[o + 4];
        const len = read24(fileData, o + 5);
        const data = fileData.slice(o + 8, o + 8 + len);
        blocks.push({ kind: 'direct', tStatesPerSample, pause, usedBits, data });
        o += 8 + len;
        break;
      }
      case 0x18: // CSW Recording
      case 0x19: { // Generalized Data Block
        o += 4 + read32(fileData, o);
        break;
      }
      case 0x20: { // Pause / Stop the tape
        const duration = read16(fileData, o);
        blocks.push({ kind: 'pause', duration });
        o += 2;
        break;
      }
      case 0x21: { // Group Start
        const nameLen = fileData[o];
        const name = readString(fileData, o + 1, nameLen);
        blocks.push({ kind: 'group-start', name });
        o += 1 + nameLen;
        break;
      }
      case 0x22: // Group End
        blocks.push({ kind: 'group-end' });
        break;
      case 0x23: // Jump to Block
        o += 2;
        break;
      case 0x24: // Loop Start
        loopCount = read16(fileData, o);
        loopStart = blocks.length;
        o += 2;
        break;
      case 0x25: { // Loop End
        if (loopStart >= 0 && loopCount > 1) {
          const loopBody = blocks.slice(loopStart);
          for (let i = 1; i < loopCount; i++) {
            for (const blk of loopBody) blocks.push(blk);
          }
        }
        loopStart = -1;
        loopCount = 0;
        break;
      }
      case 0x26: // Call Sequence
        o += 2 + read16(fileData, o) * 2;
        break;
      case 0x27: // Return from Sequence
        break;
      case 0x28: // Select Block
        o += 2 + read16(fileData, o);
        break;
      case 0x2A: // Stop tape if in 48K mode
        blocks.push({ kind: 'stop-if-48k' });
        o += 4;
        break;
      case 0x2B: { // Set Signal Level
        const blockLen = read32(fileData, o);
        const level = fileData[o + 4] & 1;
        blocks.push({ kind: 'set-level', level });
        o += 4 + blockLen;
        break;
      }
      case 0x30: { // Text Description
        const textLen = fileData[o];
        const text = readString(fileData, o + 1, textLen);
        blocks.push({ kind: 'text', text });
        o += 1 + textLen;
        break;
      }
      case 0x31: // Message Block
        o += 2 + fileData[o + 1];
        break;
      case 0x32: { // Archive Info
        const totalLen = read16(fileData, o);
        const numStrings = fileData[o + 2];
        const entries: { id: number; text: string }[] = [];
        let pos = o + 3;
        for (let i = 0; i < numStrings && pos < o + 2 + totalLen; i++) {
          const entryId = fileData[pos];
          const entryLen = fileData[pos + 1];
          const entryText = readString(fileData, pos + 2, entryLen);
          entries.push({ id: entryId, text: entryText });
          pos += 2 + entryLen;
        }
        blocks.push({ kind: 'archive-info', entries });
        o += 2 + totalLen;
        break;
      }
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
