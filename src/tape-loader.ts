/**
 * ROM trap for instant tape loading.
 *
 * Intercepts the standard LD-BYTES routine at 0x0556 and transfers block data
 * directly into memory, bypassing the real tape-timing loop.
 */

import { Z80 } from './cores/z80.ts';
import type { TapeDeck } from './formats/tap.ts';

export function trapTapeLoad(cpu: Z80, tape: TapeDeck): void {
  // Expected flag byte is in A register
  const expectedFlag = cpu.a;
  // Carry flag: 1 = LOAD, 0 = VERIFY
  const isLoad = cpu.getFlag(Z80.FLAG_C);
  // IX = destination address, DE = byte count
  let dest = cpu.ix;
  let count = cpu.de;

  const block = tape.nextBlock();

  if (!block || block.flag !== expectedFlag) {
    // No block or flag mismatch — signal failure
    cpu.setFlag(Z80.FLAG_C, false);
  } else if (!isLoad) {
    // VERIFY mode — just set success without copying
    cpu.setFlag(Z80.FLAG_C, true);
  } else {
    // LOAD mode — copy block data into memory
    const len = Math.min(count, block.data.length);
    for (let i = 0; i < len; i++) {
      cpu.write8(dest, block.data[i]);
      dest = (dest + 1) & 0xFFFF;
    }
    count = 0;
    cpu.ix = dest;
    cpu.de = count;
    cpu.setFlag(Z80.FLAG_C, true);
  }

  // Pop return address (simulating RET from LD-BYTES)
  cpu.pc = cpu.pop16();
  // Re-enable interrupts (LD-BYTES runs with DI)
  cpu.iff1 = true;
  cpu.iff2 = true;
}
