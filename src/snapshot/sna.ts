/**
 * SNA snapshot loader and saver (48K and 128K).
 *
 * 48K SNA: 49,179 bytes (27 bytes header + 49,152 bytes RAM)
 * 128K SNA: 131,103+ bytes (adds PC, port 0x7FFD, TR-DOS flag, extra banks)
 */

import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';

export interface SNAResult {
  is128K: boolean;
  port7FFD: number;
  borderColor: number;
}

/**
 * Load a .sna snapshot file.
 * Returns metadata needed to configure the machine after loading.
 */
export function loadSNA(
  data: Uint8Array,
  cpu: Z80,
  memory: SpectrumMemory
): SNAResult {
  if (data.length < 49179) {
    throw new Error(`SNA file too small: ${data.length} bytes (expected >= 49179)`);
  }

  // 27-byte header: register state
  cpu.i = data[0];
  cpu.l_ = data[1];  cpu.h_ = data[2];
  cpu.e_ = data[3];  cpu.d_ = data[4];
  cpu.c_ = data[5];  cpu.b_ = data[6];
  cpu.f_ = data[7];  cpu.a_ = data[8];

  cpu.l = data[9];   cpu.h = data[10];
  cpu.e = data[11];  cpu.d = data[12];
  cpu.c = data[13];  cpu.b = data[14];

  cpu.iy = data[15] | (data[16] << 8);
  cpu.ix = data[17] | (data[18] << 8);

  // Bit 2 of byte 19: IFF2
  cpu.iff2 = (data[19] & 0x04) !== 0;
  cpu.iff1 = cpu.iff2;

  cpu.r = data[20];

  cpu.f = data[21];  cpu.a = data[22];
  cpu.sp = data[23] | (data[24] << 8);

  cpu.im = data[25];

  const borderColor = data[26] & 0x07;

  const is128K = data.length > 49179;

  if (is128K) {
    // 128K SNA: load RAM banks
    // Bytes 27-49178: RAM dump of banks 5, 2, and the current bank at 0xC000
    // Byte 49179-49180: PC (little-endian)
    // Byte 49181: port 0x7FFD value
    // Byte 49182: TR-DOS ROM paged flag (ignored)
    // Remaining: extra 16KB banks (those not already in the main 48KB)

    const port7FFD = data[49181];
    const currentBank = port7FFD & 0x07;

    // Load the three banks from the main 48K region
    // 0x4000-0x7FFF = bank 5
    memory.setBankFromSnapshot(5, data.subarray(27, 27 + 16384));
    // 0x8000-0xBFFF = bank 2
    memory.setBankFromSnapshot(2, data.subarray(27 + 16384, 27 + 32768));
    // 0xC000-0xFFFF = current bank
    memory.setBankFromSnapshot(currentBank, data.subarray(27 + 32768, 27 + 49152));

    // Load remaining banks from the extra data
    // The order is 0,1,2,3,4,5,6,7 but skipping banks 5, 2, and currentBank
    let offset = 49183;
    for (let bank = 0; bank < 8; bank++) {
      if (bank === 5 || bank === 2 || bank === currentBank) continue;
      if (offset + 16384 <= data.length) {
        memory.setBankFromSnapshot(bank, data.subarray(offset, offset + 16384));
        offset += 16384;
      }
    }

    // Set up paging
    memory.port7FFD = port7FFD;
    memory.currentBank = currentBank;
    memory.currentROM = (port7FFD >> 4) & 1;
    memory.pagingLocked = (port7FFD & 0x20) !== 0;
    memory.applyBanking();

    // PC from extended header
    cpu.pc = data[49179] | (data[49180] << 8);

    return { is128K: true, port7FFD, borderColor };
  } else {
    // 48K SNA: load 48KB RAM
    memory.load48KRAM(data.subarray(27, 27 + 49152));

    // PC is recovered by popping from stack
    cpu.pc = memory.readByte(cpu.sp) | (memory.readByte((cpu.sp + 1) & 0xFFFF) << 8);
    cpu.sp = (cpu.sp + 2) & 0xFFFF;

    return { is128K: false, port7FFD: 0, borderColor };
  }
}

/**
 * Save the current machine state as a .sna file.
 * 48K: 49,179 bytes. 128K: 131,103 bytes.
 */
export function saveSNA(
  cpu: Z80,
  memory: SpectrumMemory,
  borderColor: number
): Uint8Array {
  const banks = memory.flushBanks();

  if (memory.is128K) {
    // 128K SNA: header(27) + banks 5,2,current(49152) + PC(2) + 7FFD(1) + TRDOS(1) + remaining banks(5*16384)
    const data = new Uint8Array(131103);
    writeHeader(data, cpu, borderColor);

    // Main 48K region: banks 5, 2, currentBank
    data.set(banks[5], 27);
    data.set(banks[2], 27 + 16384);
    data.set(banks[memory.currentBank], 27 + 32768);

    // Extended header
    data[49179] = cpu.pc & 0xFF;
    data[49180] = (cpu.pc >> 8) & 0xFF;
    data[49181] = memory.port7FFD;
    data[49182] = 0; // TR-DOS flag

    // Remaining banks in order 0-7, skipping 5, 2, and currentBank
    let offset = 49183;
    for (let bank = 0; bank < 8; bank++) {
      if (bank === 5 || bank === 2 || bank === memory.currentBank) continue;
      data.set(banks[bank], offset);
      offset += 16384;
    }

    return data;
  } else {
    // 48K SNA: push PC onto stack, then dump header + 48K RAM
    const data = new Uint8Array(49179);

    // Push PC onto stack (SNA 48K stores PC on the stack)
    const sp = (cpu.sp - 2) & 0xFFFF;
    memory.writeByte(sp, cpu.pc & 0xFF);
    memory.writeByte((sp + 1) & 0xFFFF, (cpu.pc >> 8) & 0xFF);

    writeHeader(data, cpu, borderColor);
    // Write modified SP (with PC pushed)
    data[23] = sp & 0xFF;
    data[24] = (sp >> 8) & 0xFF;

    // 48K RAM at 0x4000-0xFFFF: banks 5, 2, currentBank
    const banks = memory.flushBanks();
    data.set(banks[5], 27);
    data.set(banks[2], 27 + 16384);
    data.set(banks[memory.currentBank], 27 + 32768);

    // Restore original stack
    memory.writeByte(sp, 0);
    memory.writeByte((sp + 1) & 0xFFFF, 0);

    return data;
  }
}

function writeHeader(data: Uint8Array, cpu: Z80, borderColor: number): void {
  data[0] = cpu.i;
  data[1] = cpu.l_;  data[2] = cpu.h_;
  data[3] = cpu.e_;  data[4] = cpu.d_;
  data[5] = cpu.c_;  data[6] = cpu.b_;
  data[7] = cpu.f_;  data[8] = cpu.a_;

  data[9] = cpu.l;   data[10] = cpu.h;
  data[11] = cpu.e;  data[12] = cpu.d;
  data[13] = cpu.c;  data[14] = cpu.b;

  data[15] = cpu.iy & 0xFF;  data[16] = (cpu.iy >> 8) & 0xFF;
  data[17] = cpu.ix & 0xFF;  data[18] = (cpu.ix >> 8) & 0xFF;

  data[19] = cpu.iff2 ? 0x04 : 0x00;
  data[20] = cpu.r;

  data[21] = cpu.f;  data[22] = cpu.a;
  data[23] = cpu.sp & 0xFF;  data[24] = (cpu.sp >> 8) & 0xFF;

  data[25] = cpu.im;
  data[26] = borderColor & 0x07;
}
