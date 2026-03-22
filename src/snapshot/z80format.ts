/**
 * .z80 snapshot loader (v1, v2, v3).
 *
 * Format versions:
 *   v1 — 30-byte header, 48K only. If header byte 12 bit 5 is set, data is compressed.
 *   v2 — 30-byte header + 23-byte extended header. Data in paged blocks.
 *   v3 — 30-byte header + 54/55-byte extended header. Data in paged blocks.
 *
 * Compression: 0xED 0xED <count> <byte> expands to <count> copies of <byte>.
 * v1 compressed data ends with the sequence 00 ED ED 00.
 *
 * References:
 *   https://worldofspectrum.org/faq/reference/z80format.htm
 *   https://sinclair.wiki.zxnet.co.uk/wiki/Z80_format
 */

import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';

export interface Z80Result {
  is128K: boolean;
  port7FFD: number;
  borderColor: number;
}

// ── Header parsing helpers ─────────────────────────────────────────────────

function r16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

// ── Decompression ──────────────────────────────────────────────────────────

/**
 * Decompress a v1 data block (entire RAM after 30-byte header).
 * Compressed stream ends with sentinel 00 ED ED 00.
 */
function decompressV1(src: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(49152); // 48K
  let op = 0;
  let ip = offset;
  const end = src.length;

  while (ip < end && op < 49152) {
    const b = src[ip++];

    if (b !== 0xED) {
      out[op++] = b;
      continue;
    }

    if (ip >= end) { out[op++] = b; break; }
    const b2 = src[ip++];

    if (b2 !== 0xED) {
      // Not a run — two literal bytes
      out[op++] = b;
      if (op < 49152) out[op++] = b2;
      continue;
    }

    // ED ED <count> <value>
    if (ip + 1 >= end) break;
    const count = src[ip++];
    const value = src[ip++];

    // Sentinel: 00 ED ED 00 means end (count=0, value comes from the 00 before)
    // Actually the sentinel is when we've already consumed ED ED and count=0
    if (count === 0) break;

    for (let i = 0; i < count && op < 49152; i++) {
      out[op++] = value;
    }
  }

  return out;
}

/**
 * Decompress a v2/v3 paged data block.
 * If compressedLen === 0xFFFF the block is uncompressed (16384 bytes).
 */
function decompressBlock(src: Uint8Array, offset: number, compressedLen: number): Uint8Array {
  if (compressedLen === 0xFFFF) {
    // Uncompressed
    return src.slice(offset, offset + 16384);
  }

  const out = new Uint8Array(16384);
  let op = 0;
  const end = offset + compressedLen;
  let ip = offset;

  while (ip < end && op < 16384) {
    const b = src[ip++];

    if (b !== 0xED) {
      out[op++] = b;
      continue;
    }

    if (ip >= end) { out[op++] = b; break; }
    const b2 = src[ip++];

    if (b2 !== 0xED) {
      out[op++] = b;
      if (op < 16384) out[op++] = b2;
      continue;
    }

    // ED ED <count> <value>
    if (ip + 1 >= end) break;
    const count = src[ip++];
    const value = src[ip++];

    for (let i = 0; i < count && op < 16384; i++) {
      out[op++] = value;
    }
  }

  return out;
}

// ── Page ID → RAM bank mapping ─────────────────────────────────────────────

/**
 * Map .z80 v2/v3 page IDs to RAM bank indices.
 *
 * For 48K:  page 4 → 0x8000 (bank 2), page 5 → 0xC000 (bank 0), page 8 → 0x4000 (bank 5)
 * For 128K: page 3 → bank 0, page 4 → bank 1, ..., page 10 → bank 7
 *           Pages 0-2 are ROM pages (ignored — we use user-supplied ROM)
 */
function pageToBank128K(pageId: number): number {
  // Pages 3-10 map to RAM banks 0-7
  if (pageId >= 3 && pageId <= 10) return pageId - 3;
  return -1; // ROM or invalid
}

// ── Version detection ──────────────────────────────────────────────────────

function detectVersion(data: Uint8Array): { version: number; extHeaderLen: number } {
  // v1: PC at bytes 6-7 is non-zero
  const pc = r16(data, 6);
  if (pc !== 0) {
    return { version: 1, extHeaderLen: 0 };
  }

  // v2/v3: extended header length at bytes 30-31
  const extLen = r16(data, 30);
  if (extLen === 23) {
    return { version: 2, extHeaderLen: 23 };
  }
  // v3 uses 54 or 55
  return { version: 3, extHeaderLen: extLen };
}

// ── Hardware mode → is128K ─────────────────────────────────────────────────

function is128KHardware(hwMode: number, version: number): boolean {
  if (version === 2) {
    // v2: 0=48K, 1=48K+IF1, 2=SamRam, 3=128K, 4=128K+IF1
    return hwMode >= 3;
  }
  // v3: 0=48K, 1=48K+IF1, 2=SamRam, 3=48K+MGT,
  //     4=128K, 5=128K+IF1, 6=128K+MGT, 7=+3, ...
  return hwMode >= 4;
}

// ── Main loader ────────────────────────────────────────────────────────────

export function loadZ80(
  data: Uint8Array,
  cpu: Z80,
  memory: SpectrumMemory
): Z80Result {
  if (data.length < 30) {
    throw new Error(`.z80 file too small: ${data.length} bytes`);
  }

  const { version, extHeaderLen } = detectVersion(data);

  // ── Common header (bytes 0-29) ─────────────────────────────────────────

  cpu.a = data[0];
  cpu.f = data[1];
  cpu.c = data[2];
  cpu.b = data[3];
  cpu.l = data[4];
  cpu.h = data[5];

  // PC: from byte 6-7 for v1, from extended header for v2/v3
  const v1PC = r16(data, 6);

  cpu.sp = r16(data, 8);
  cpu.i = data[10];
  cpu.r = data[11];

  // Byte 12: mixed flags
  let byte12 = data[12];
  if (byte12 === 255) byte12 = 1; // Compatibility

  // R high bit from byte 12 bit 0
  cpu.r = (cpu.r & 0x7F) | ((byte12 & 0x01) << 7);

  const borderColor = (byte12 >> 1) & 0x07;
  const v1Compressed = (byte12 & 0x20) !== 0;

  cpu.e = data[13];
  cpu.d = data[14];
  cpu.c_ = data[15];
  cpu.b_ = data[16];
  cpu.e_ = data[17];
  cpu.d_ = data[18];
  cpu.l_ = data[19];
  cpu.h_ = data[20];
  cpu.a_ = data[21];
  cpu.f_ = data[22];

  cpu.iy = r16(data, 23);
  cpu.ix = r16(data, 25);

  cpu.iff1 = data[27] !== 0;
  cpu.iff2 = data[28] !== 0;

  cpu.im = data[29] & 0x03;

  // ── Version 1: 48K only ────────────────────────────────────────────────

  if (version === 1) {
    cpu.pc = v1PC;

    let ram: Uint8Array;
    if (v1Compressed) {
      ram = decompressV1(data, 30);
    } else {
      ram = data.slice(30, 30 + 49152);
    }

    memory.load48KRAM(ram);
    return { is128K: false, port7FFD: 0, borderColor };
  }

  // ── Version 2/3: paged blocks ──────────────────────────────────────────

  // Extended header starts at byte 30
  // Bytes 30-31: extended header length (already read)
  const extBase = 32; // first byte of extended header content

  cpu.pc = r16(data, extBase);

  const hwMode = data[extBase + 2];
  const is128K = is128KHardware(hwMode, version);

  // Port 0x7FFD (128K paging) — byte 35 (extBase+3)
  const port7FFD = is128K ? data[extBase + 3] : 0;

  // Data blocks start after the extended header
  const dataStart = 32 + extHeaderLen;
  let offset = dataStart;

  if (is128K) {
    // ── 128K: load paged blocks into RAM banks ───────────────────────────

    while (offset + 3 <= data.length) {
      const blockLen = r16(data, offset);
      const pageId = data[offset + 2];
      offset += 3;

      if (offset + (blockLen === 0xFFFF ? 16384 : blockLen) > data.length) break;

      const bank = pageToBank128K(pageId);
      if (bank >= 0 && bank < 8) {
        const decompressed = decompressBlock(data, offset, blockLen);
        memory.setBankFromSnapshot(bank, decompressed);
      }

      offset += (blockLen === 0xFFFF) ? 16384 : blockLen;
    }

    // Apply 128K paging state
    memory.port7FFD = port7FFD;
    memory.currentBank = port7FFD & 0x07;
    memory.currentROM = (port7FFD >> 4) & 1;
    memory.pagingLocked = (port7FFD & 0x20) !== 0;
    memory.applyBanking();

    return { is128K: true, port7FFD, borderColor };
  } else {
    // ── 48K: load paged blocks into 48K address space ────────────────────

    // Temporary 48K buffer
    const ram = new Uint8Array(49152);

    while (offset + 3 <= data.length) {
      const blockLen = r16(data, offset);
      const pageId = data[offset + 2];
      offset += 3;

      if (offset + (blockLen === 0xFFFF ? 16384 : blockLen) > data.length) break;

      const decompressed = decompressBlock(data, offset, blockLen);

      // 48K page mapping:
      //   page 4 → 0x8000-0xBFFF (offset 16384 in our 48K buffer)
      //   page 5 → 0xC000-0xFFFF (offset 32768)
      //   page 8 → 0x4000-0x7FFF (offset 0)
      switch (pageId) {
        case 8: ram.set(decompressed, 0); break;      // 0x4000
        case 4: ram.set(decompressed, 16384); break;   // 0x8000
        case 5: ram.set(decompressed, 32768); break;   // 0xC000
      }

      offset += (blockLen === 0xFFFF) ? 16384 : blockLen;
    }

    memory.load48KRAM(ram);
    return { is128K: false, port7FFD: 0, borderColor };
  }
}

// ── Z80 Writer ─────────────────────────────────────────────────────────────

/**
 * Compress a 16KB block using ED ED <count> <byte> RLE compression.
 * Returns compressed data or original data if compression doesn't help.
 */
function compressBlock(src: Uint8Array): { data: Uint8Array; compressed: boolean } {
  const out: number[] = [];
  let i = 0;

  while (i < src.length) {
    const byte = src[i];

    // Check for ED byte - needs special handling
    if (byte === 0xED) {
      // Look ahead to see if next byte is also ED
      if (i + 1 < src.length && src[i + 1] === 0xED) {
        // Literal ED ED sequence - encode as ED ED 01 ED
        out.push(0xED, 0xED, 0x01, 0xED);
        i += 2;
        continue;
      }
      // Single ED - just output it
      out.push(byte);
      i++;
      continue;
    }

    // Count consecutive identical bytes
    let count = 1;
    while (i + count < src.length && src[i + count] === byte && count < 255) {
      count++;
    }

    // Use RLE if we have 5+ identical bytes, or 4+ if the byte is ED
    if (count >= 5) {
      out.push(0xED, 0xED, count, byte);
      i += count;
    } else {
      // Output literal bytes
      for (let j = 0; j < count; j++) {
        out.push(byte);
      }
      i += count;
    }
  }

  const compressed = new Uint8Array(out);
  // Only use compression if it actually saves space
  if (compressed.length < src.length) {
    return { data: compressed, compressed: true };
  }
  return { data: src, compressed: false };
}

function w16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
}

/**
 * Save a .z80 v3 snapshot.
 * v3 format supports both 48K and 128K machines with all hardware modes.
 */
export function saveZ80(
  cpu: Z80,
  memory: SpectrumMemory,
  borderColor: number,
  is128K: boolean
): Uint8Array {
  // ── 30-byte common header ──────────────────────────────────────────────

  const header = new Uint8Array(30);

  header[0] = cpu.a;
  header[1] = cpu.f;
  header[2] = cpu.c;
  header[3] = cpu.b;
  header[4] = cpu.l;
  header[5] = cpu.h;

  // PC = 0 for v2/v3 (actual PC goes in extended header)
  w16(header, 6, 0);

  w16(header, 8, cpu.sp);
  header[10] = cpu.i;
  header[11] = cpu.r & 0x7F;

  // Byte 12: bit 0 = R bit 7, bits 1-3 = border color, bit 5 = v1 compression (unused in v3)
  const rBit7 = (cpu.r & 0x80) >> 7;
  header[12] = rBit7 | ((borderColor & 0x07) << 1);

  header[13] = cpu.e;
  header[14] = cpu.d;
  header[15] = cpu.c_;
  header[16] = cpu.b_;
  header[17] = cpu.e_;
  header[18] = cpu.d_;
  header[19] = cpu.l_;
  header[20] = cpu.h_;
  header[21] = cpu.a_;
  header[22] = cpu.f_;

  w16(header, 23, cpu.iy);
  w16(header, 25, cpu.ix);

  header[27] = cpu.iff1 ? 1 : 0;
  header[28] = cpu.iff2 ? 1 : 0;
  header[29] = cpu.im & 0x03;

  // ── 54-byte v3 extended header ─────────────────────────────────────────

  const extHeaderLen = 54;
  const extHeader = new Uint8Array(2 + extHeaderLen);

  // Bytes 0-1: extended header length
  w16(extHeader, 0, extHeaderLen);

  // Bytes 2-3 (extBase+0,+1): PC
  w16(extHeader, 2, cpu.pc);

  // Byte 4 (extBase+2): hardware mode
  // v3 hardware modes: 0=48K, 1=48K+IF1, 3=48K+MGT, 4=128K, 5=128K+IF1, 7=+3, 9=Pentagon, 12=+2, 13=+2A
  const hwMode = is128K ? 4 : 0; // 4 = 128K, 0 = 48K
  extHeader[4] = hwMode;

  // Byte 5 (extBase+3): port 0x7FFD value (128K paging)
  extHeader[5] = is128K ? memory.port7FFD : 0;

  // Byte 6 (extBase+4): interface 1 ROM paged (0 = no)
  extHeader[6] = 0;

  // Byte 7 (extBase+5): hardware modify flags (0 = emulate, 1 = modify)
  extHeader[7] = 0;

  // Byte 8 (extBase+6): last OUT to port 0xFFFF (AY sound)
  extHeader[8] = 0;

  // Bytes 9-24 (extBase+7 to +22): reserved, set to 0
  for (let i = 9; i <= 24; i++) {
    extHeader[i] = 0;
  }

  // The rest of extended header bytes (up to 54) are also reserved
  for (let i = 25; i < 2 + extHeaderLen; i++) {
    extHeader[i] = 0;
  }

  // ── Data blocks ────────────────────────────────────────────────────────

  const blocks: Uint8Array[] = [];
  const banks = memory.flushBanks();

  if (is128K) {
    // 128K: write all 8 RAM banks (pages 3-10)
    for (let bank = 0; bank < 8; bank++) {
      const pageId = bank + 3;
      const bankData = banks[bank];
      const { data: compressed, compressed: isCompressed } = compressBlock(bankData);

      // Block header: 2 bytes length + 1 byte page ID
      const blockHeader = new Uint8Array(3);
      if (isCompressed) {
        w16(blockHeader, 0, compressed.length);
      } else {
        w16(blockHeader, 0, 0xFFFF); // 0xFFFF = uncompressed
      }
      blockHeader[2] = pageId;

      blocks.push(blockHeader);
      blocks.push(compressed);
    }
  } else {
    // 48K: write three pages (4, 5, 8)
    // Page 8 = 0x4000-0x7FFF (bank 5)
    // Page 4 = 0x8000-0xBFFF (bank 2)
    // Page 5 = 0xC000-0xFFFF (bank 0)

    const pages = [
      { pageId: 8, bank: 5 },
      { pageId: 4, bank: 2 },
      { pageId: 5, bank: 0 },
    ];

    for (const { pageId, bank } of pages) {
      const bankData = banks[bank];
      const { data: compressed, compressed: isCompressed } = compressBlock(bankData);

      const blockHeader = new Uint8Array(3);
      if (isCompressed) {
        w16(blockHeader, 0, compressed.length);
      } else {
        w16(blockHeader, 0, 0xFFFF);
      }
      blockHeader[2] = pageId;

      blocks.push(blockHeader);
      blocks.push(compressed);
    }
  }

  // ── Concatenate all parts ──────────────────────────────────────────────

  let totalLen = header.length + extHeader.length;
  for (const block of blocks) {
    totalLen += block.length;
  }

  const result = new Uint8Array(totalLen);
  let offset = 0;

  result.set(header, offset);
  offset += header.length;

  result.set(extHeader, offset);
  offset += extHeader.length;

  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }

  return result;
}
