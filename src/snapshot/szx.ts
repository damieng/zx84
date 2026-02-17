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

import { Z80 } from '@/cores/Z80.ts';
import { SpectrumMemory } from '@/memory.ts';

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

// ── SZX Writer ──────────────────────────────────────────────────────────

function w16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
}

function w32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
  data[offset + 2] = (value >> 16) & 0xFF;
  data[offset + 3] = (value >> 24) & 0xFF;
}

function writeBlockHeader(data: Uint8Array, offset: number, id: string, size: number): number {
  // 4-byte ID
  for (let i = 0; i < 4; i++) {
    data[offset + i] = i < id.length ? id.charCodeAt(i) : 0;
  }
  // 4-byte size (LE)
  w32(data, offset + 4, size);
  return offset + 8;
}

export function saveSZX(cpu: Z80, memory: SpectrumMemory, borderColor: number, ayRegs?: Uint8Array, ayCurrentReg?: number): Uint8Array {
  // Calculate total size:
  // Header: 8 bytes
  // Z80R: 8 (block header) + 37 (data) = 45
  // SPCR: 8 + 4 = 12
  // RAMP × 8: 8 × (8 + 3 + 16384) = 131144
  // AY (optional): 8 + 18 = 26
  const totalSize = 8 + 45 + 12 + (8 * (8 + 3 + 16384)) + (ayRegs ? 26 : 0);
  const data = new Uint8Array(totalSize);
  let offset = 0;

  // ── Header ──────────────────────────────────────────────────────────
  data[offset++] = 0x5A; // 'Z'
  data[offset++] = 0x58; // 'X'
  data[offset++] = 0x53; // 'S'
  data[offset++] = 0x54; // 'T'
  data[offset++] = 1;    // major version
  data[offset++] = 4;    // minor version
  data[offset++] = memory.is128K ? 2 : 1; // machine ID: 1=48K, 2=128K
  data[offset++] = 0;    // flags

  // ── Z80R block (CPU registers) ──────────────────────────────────────
  offset = writeBlockHeader(data, offset, 'Z80R', 37);

  w16(data, offset + 0, (cpu.a << 8) | cpu.f);   // AF
  w16(data, offset + 2, (cpu.b << 8) | cpu.c);   // BC
  w16(data, offset + 4, (cpu.d << 8) | cpu.e);   // DE
  w16(data, offset + 6, (cpu.h << 8) | cpu.l);   // HL
  w16(data, offset + 8, (cpu.a_ << 8) | cpu.f_); // AF'
  w16(data, offset + 10, (cpu.b_ << 8) | cpu.c_); // BC'
  w16(data, offset + 12, (cpu.d_ << 8) | cpu.e_); // DE'
  w16(data, offset + 14, (cpu.h_ << 8) | cpu.l_); // HL'
  w16(data, offset + 16, cpu.ix);
  w16(data, offset + 18, cpu.iy);
  w16(data, offset + 20, cpu.sp);
  w16(data, offset + 22, cpu.pc);
  data[offset + 24] = cpu.i;
  data[offset + 25] = cpu.r;
  data[offset + 26] = cpu.iff1 ? 1 : 0;
  data[offset + 27] = cpu.iff2 ? 1 : 0;
  data[offset + 28] = cpu.im;
  w32(data, offset + 29, cpu.tStates);
  data[offset + 33] = 0; // chHoldIntReqCycles
  data[offset + 34] = cpu.halted ? 0x02 : 0; // chFlags
  w16(data, offset + 35, 0); // wMemPtr
  offset += 37;

  // ── SPCR block (Spectrum-specific) ──────────────────────────────────
  offset = writeBlockHeader(data, offset, 'SPCR', 4);
  data[offset++] = borderColor & 0x07;
  data[offset++] = memory.port7FFD;
  data[offset++] = memory.port1FFD;
  data[offset++] = (borderColor & 0x07) << 1; // portFE

  // ── RAMP blocks (RAM pages) ─────────────────────────────────────────
  for (let page = 0; page < 8; page++) {
    offset = writeBlockHeader(data, offset, 'RAMP', 3 + 16384);
    w16(data, offset, 0); // wFlags: 0 = uncompressed
    offset += 2;
    data[offset++] = page; // chPageNo
    data.set(memory.ramBanks[page], offset);
    offset += 16384;
  }

  // ── AY block (AY chip state) ────────────────────────────────────────
  if (ayRegs) {
    offset = writeBlockHeader(data, offset, 'AY\0\0', 18);
    data[offset++] = 0; // chFlags
    data[offset++] = ayCurrentReg ?? 0; // chCurrentRegister
    data.set(ayRegs.slice(0, 16), offset);
    offset += 16;
  }

  return data;
}
