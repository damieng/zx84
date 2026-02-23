/**
 * .sp snapshot loader (Spectrum +3e format).
 *
 * Format: 38-byte header + 49152 bytes RAM (48K) or ~131KB (128K).
 * Little-endian, uncompressed.
 *
 * References:
 *   https://rk.nvg.ntnu.no/sinclair/faq/fileform.html
 *   https://fms.komkon.org/stuff/spectrum.faq
 */

import { Z80 } from '@/cores/Z80.ts';
import { SpectrumMemory } from '@/memory.ts';

export interface SPResult {
  is128K: boolean;
  port7FFD: number;
  borderColor: number;
}

function r16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

export function loadSP(data: Uint8Array, cpu: Z80, memory: SpectrumMemory): SPResult {
  if (data.length < 38) {
    throw new Error('File too small to be a valid .sp snapshot');
  }

  // Check magic signature "SP"
  if (data[0] !== 0x53 || data[1] !== 0x50) {
    throw new Error('Invalid .sp signature');
  }

  // Read header (38 bytes)
  const progLen = r16(data, 2);
  const progLoc = r16(data, 4);

  cpu.bc = r16(data, 6);
  cpu.de = r16(data, 8);
  cpu.hl = r16(data, 10);
  cpu.af = r16(data, 12);
  cpu.ix = r16(data, 14);
  cpu.iy = r16(data, 16);

  // Alternate registers
  const bc_ = r16(data, 18);
  const de_ = r16(data, 20);
  const hl_ = r16(data, 22);
  const af_ = r16(data, 24);
  cpu.b_ = (bc_ >> 8) & 0xFF;
  cpu.c_ = bc_ & 0xFF;
  cpu.d_ = (de_ >> 8) & 0xFF;
  cpu.e_ = de_ & 0xFF;
  cpu.h_ = (hl_ >> 8) & 0xFF;
  cpu.l_ = hl_ & 0xFF;
  cpu.a_ = (af_ >> 8) & 0xFF;
  cpu.f_ = af_ & 0xFF;

  cpu.r = data[26];
  cpu.i = data[27];
  cpu.sp = r16(data, 28);
  cpu.pc = r16(data, 30);

  const borderColor = data[34] & 0x07;
  const statusWord = r16(data, 36);

  // Parse status word
  cpu.iff1 = (statusWord & 0x01) !== 0;
  cpu.iff2 = (statusWord & 0x04) !== 0;

  // Interrupt mode: bit 3=1 → IM0, bit 3=0 → bit 1 determines IM1/IM2
  if (statusWord & 0x08) {
    cpu.im = 0;
  } else {
    cpu.im = (statusWord & 0x02) ? 2 : 1;
  }

  // Determine 48K or 128K based on file size
  const is128K = data.length > 49227;

  if (is128K) {
    // 128K: First 49152 bytes are banks 5, 2, and current bank at 0xC000
    const ramData = data.slice(38, 38 + 49152);
    memory.setBankFromSnapshot(5, ramData.slice(0, 16384));
    memory.setBankFromSnapshot(2, ramData.slice(16384, 32768));

    // Port 0x7FFD is at offset 38 + 49152 + 2 (after PC)
    const port7FFD = data[38 + 49152 + 2];
    const currentBank = port7FFD & 0x07;
    memory.setBankFromSnapshot(currentBank, ramData.slice(32768, 49152));

    // Load remaining banks (skip 2, 5, and current)
    let offset = 38 + 49152 + 3; // After port byte
    for (let bank = 0; bank < 8; bank++) {
      if (bank === 2 || bank === 5 || bank === currentBank) continue;
      if (offset + 16384 > data.length) break;
      memory.setBankFromSnapshot(bank, data.slice(offset, offset + 16384));
      offset += 16384;
    }

    // Apply banking to sync flat memory
    memory.port7FFD = port7FFD;
    memory.currentBank = currentBank;
    memory.currentROM = (port7FFD >> 4) & 1;
    memory.pagingLocked = (port7FFD & 0x20) !== 0;
    memory.applyBanking();

    return {
      is128K: true,
      port7FFD,
      borderColor,
    };
  } else {
    // 48K: 49152 bytes starting at progLoc (usually 0x4000)
    const ramStart = progLoc;
    const ramData = data.slice(38, 38 + progLen);

    if (ramStart === 0x4000 && progLen === 49152) {
      // Standard 48K layout
      memory.setBankFromSnapshot(5, ramData.slice(0, 16384));  // 0x4000-0x7FFF
      memory.setBankFromSnapshot(2, ramData.slice(16384, 32768)); // 0x8000-0xBFFF
      memory.setBankFromSnapshot(0, ramData.slice(32768, 49152)); // 0xC000-0xFFFF
      memory.applyBanking();
    } else {
      // Non-standard layout - copy directly to flat memory
      memory.flat.set(ramData, ramStart);
    }

    return {
      is128K: false,
      port7FFD: 0,
      borderColor,
    };
  }
}
