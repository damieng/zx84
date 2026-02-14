/**
 * SZX (ZX-State) snapshot loader.
 *
 * Block-based format from Spectaculator, also used by Fuse and others.
 * Reference: https://www.spectaculator.com/docs/zx-state/intro.shtml
 *
 * Header (8 bytes):
 *   [0..3] = 'ZXST' magic
 *   [4]    = major version, [5] = minor version
 *   [6]    = machine ID, [7] = flags
 *
 * Each block: 4-byte ID + 4-byte LE payload size, then payload.
 */

import { Z80 } from '../cores/z80.ts';
import { SpectrumMemory } from '../memory.ts';

export interface SZXResult {
  is128K: boolean;
  port7FFD: number;
  port1FFD: number;
  borderColor: number;
  ayRegs?: Uint8Array;
  ayCurrentReg?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function r16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function r32(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | ((d[o + 3] << 24) >>> 0);
}

function blockId(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

/** Inflate zlib (deflate) data using browser DecompressionStream. */
async function inflate(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed as unknown as BufferSource);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  if (chunks.length === 1) return chunks[0];

  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ── Machine ID mapping ──────────────────────────────────────────────────

function machineIs128K(machineId: number): boolean {
  // 0=16K, 1=48K, 2=128K, 3=+2, 4=+2A, 5=+3
  return machineId >= 2;
}

// ── Main loader ─────────────────────────────────────────────────────────

export async function loadSZX(
  data: Uint8Array,
  cpu: Z80,
  memory: SpectrumMemory
): Promise<SZXResult> {
  if (data.length < 8) {
    throw new Error('SZX file too small');
  }

  // Validate magic: ZXST
  if (data[0] !== 0x5A || data[1] !== 0x58 || data[2] !== 0x53 || data[3] !== 0x54) {
    throw new Error('Not a valid SZX file (bad magic)');
  }

  const machineId = data[6];
  const is128K = machineIs128K(machineId);

  const result: SZXResult = {
    is128K,
    port7FFD: 0,
    port1FFD: 0,
    borderColor: 7,
  };

  // ── Block iteration ─────────────────────────────────────────────────

  let offset = 8; // past header

  while (offset + 8 <= data.length) {
    const id = blockId(data, offset);
    const dwSize = r32(data, offset + 4);
    const blockStart = offset + 8;
    const blockEnd = blockStart + dwSize;

    if (blockEnd > data.length) break; // truncated block

    switch (id) {
      case 'Z80R':
        parseZ80R(data, blockStart, cpu);
        break;

      case 'SPCR':
        parseSPCR(data, blockStart, result);
        break;

      case 'RAMP':
        await parseRAMP(data, blockStart, dwSize, memory);
        break;

      case 'AY\0\0':
        parseAY(data, blockStart, result);
        break;

      // Unknown blocks: skip
    }

    offset = blockEnd;
  }

  // For 48K snapshots, flush RAM banks into flat memory
  if (!is128K) {
    // Banks 5, 2, 0 map to 0x4000, 0x8000, 0xC000
    memory.load48KRAM(build48KRAM(memory));
  }

  return result;
}

// ── Block parsers ───────────────────────────────────────────────────────

function parseZ80R(data: Uint8Array, o: number, cpu: Z80): void {
  // Z80R block layout (37 bytes minimum):
  // 0:  AF, 2: BC, 4: DE, 6: HL       (LE words)
  // 8:  AF', 10: BC', 12: DE', 14: HL'
  // 16: IX, 18: IY, 20: SP, 22: PC
  // 24: I, 25: R, 26: IFF1, 27: IFF2
  // 28: IM
  // 29: dwCyclesStart (4 bytes)
  // 33: chHoldIntReqCycles (1 byte) — skip
  // 34: chFlags (1 byte) — bit 1 = halted
  // 35: wMemPtr (2 bytes) — internal WZ register, skip

  const af  = r16(data, o + 0);
  const bc  = r16(data, o + 2);
  const de  = r16(data, o + 4);
  const hl  = r16(data, o + 6);
  const af_ = r16(data, o + 8);
  const bc_ = r16(data, o + 10);
  const de_ = r16(data, o + 12);
  const hl_ = r16(data, o + 14);

  cpu.a = (af >> 8) & 0xFF;
  cpu.f = af & 0xFF;
  cpu.b = (bc >> 8) & 0xFF;
  cpu.c = bc & 0xFF;
  cpu.d = (de >> 8) & 0xFF;
  cpu.e = de & 0xFF;
  cpu.h = (hl >> 8) & 0xFF;
  cpu.l = hl & 0xFF;

  cpu.a_ = (af_ >> 8) & 0xFF;
  cpu.f_ = af_ & 0xFF;
  cpu.b_ = (bc_ >> 8) & 0xFF;
  cpu.c_ = bc_ & 0xFF;
  cpu.d_ = (de_ >> 8) & 0xFF;
  cpu.e_ = de_ & 0xFF;
  cpu.h_ = (hl_ >> 8) & 0xFF;
  cpu.l_ = hl_ & 0xFF;

  cpu.ix = r16(data, o + 16);
  cpu.iy = r16(data, o + 18);
  cpu.sp = r16(data, o + 20);
  cpu.pc = r16(data, o + 22);

  cpu.i = data[o + 24];
  cpu.r = data[o + 25];

  cpu.iff1 = data[o + 26] !== 0;
  cpu.iff2 = data[o + 27] !== 0;

  cpu.im = data[o + 28] & 0x03;

  const dwCyclesStart = r32(data, o + 29);
  cpu.tStates = dwCyclesStart;

  // chFlags at offset 34 — bit 1 = halted
  if (o + 34 < data.length) {
    cpu.halted = (data[o + 34] & 0x02) !== 0;
  }
}

function parseSPCR(data: Uint8Array, o: number, result: SZXResult): void {
  // SPCR block: border(1), 7FFD(1), 1FFD(1), FE(1)
  result.borderColor = data[o] & 0x07;
  result.port7FFD = data[o + 1];
  result.port1FFD = data[o + 2];
  // data[o + 3] = portFE — not needed (border already extracted)
}

async function parseRAMP(
  data: Uint8Array,
  blockStart: number,
  dwSize: number,
  memory: SpectrumMemory
): Promise<void> {
  // RAMP block: wFlags(2), chPageNo(1), then page data
  const wFlags = r16(data, blockStart);
  const chPageNo = data[blockStart + 2];
  const pageDataStart = blockStart + 3;
  const pageDataLen = dwSize - 3;

  if (chPageNo >= 8) return; // invalid bank number

  if (wFlags & 1) {
    // Compressed (zlib/deflate)
    const compressed = data.subarray(pageDataStart, pageDataStart + pageDataLen);
    const decompressed = await inflate(compressed);
    memory.ramBanks[chPageNo].set(decompressed.subarray(0, 16384));
  } else {
    // Uncompressed — 16384 bytes
    memory.ramBanks[chPageNo].set(
      data.subarray(pageDataStart, pageDataStart + Math.min(pageDataLen, 16384))
    );
  }
}

function parseAY(data: Uint8Array, o: number, result: SZXResult): void {
  // AY block: chFlags(1), chCurrentRegister(1), chAyRegs[16]
  result.ayCurrentReg = data[o + 1];
  result.ayRegs = data.slice(o + 2, o + 2 + 16);
}

/** Build a contiguous 48K RAM image from banks 5, 2, 0. */
function build48KRAM(memory: SpectrumMemory): Uint8Array {
  const ram = new Uint8Array(49152);
  ram.set(memory.ramBanks[5], 0);       // 0x4000
  ram.set(memory.ramBanks[2], 16384);   // 0x8000
  ram.set(memory.ramBanks[0], 32768);   // 0xC000
  return ram;
}
