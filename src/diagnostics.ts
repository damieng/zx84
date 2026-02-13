/**
 * Stuck-loop diagnostics.
 *
 * Samples the PC over many steps, detects the repeating cycle,
 * disassembles the loop body, and speculates on exit conditions.
 */

import { Z80 } from './cores/z80.ts';

// ── Minimal Z80 disassembler (enough for loop analysis) ────────────────────

const R8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const R16 = ['BC', 'DE', 'HL', 'SP'];
const R16AF = ['BC', 'DE', 'HL', 'AF'];
const CC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];

function hex8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

interface DisResult {
  text: string;
  len: number;
  /** True if this is a conditional branch */
  isCond: boolean;
  /** Condition name for conditional branches */
  condName: string;
  /** Target address for branches */
  target: number;
  /** True if unconditional jump/ret (loop boundary) */
  isJump: boolean;
}

function disassemble(mem: Uint8Array, pc: number): DisResult {
  const op = mem[pc & 0xFFFF];
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  const r = (off: number) => mem[(pc + off) & 0xFFFF];
  const imm8 = () => r(1);
  const imm16 = () => r(1) | (r(2) << 8);
  const rel8 = () => { const v = r(1); return (pc + 2 + (v < 128 ? v : v - 256)) & 0xFFFF; };

  const res = (text: string, len: number, extra?: Partial<DisResult>): DisResult =>
    ({ text, len, isCond: false, condName: '', target: -1, isJump: false, ...extra });

  // ── Prefixed opcodes (just show prefix + raw for now) ──
  if (op === 0xCB) return res(`CB ${hex8(r(1))}`, 2);
  if (op === 0xDD || op === 0xFD) {
    const ix = op === 0xDD ? 'IX' : 'IY';
    const sub = r(1);
    if (sub === 0xCB) return res(`${ix} CB+${hex8(r(2))} ${hex8(r(3))}`, 4);
    if (sub === 0xE9) return res(`JP (${ix})`, 2, { isJump: true });
    return res(`${ix} prefix ${hex8(sub)}`, 2);
  }
  if (op === 0xED) {
    const sub = r(1);
    const sx = (sub >> 6) & 3;
    const sy = (sub >> 3) & 7;
    const sz = sub & 7;
    if (sx === 1 && sz === 0) return res(sy === 6 ? 'IN (C)' : `IN ${R8[sy]},(C)`, 2);
    if (sx === 1 && sz === 1) return res(sy === 6 ? 'OUT (C),0' : `OUT (C),${R8[sy]}`, 2);
    if (sub === 0xB0) return res('LDIR', 2);
    if (sub === 0xB8) return res('LDDR', 2);
    if (sub === 0xB1) return res('CPIR', 2);
    if (sub === 0xB9) return res('CPDR', 2);
    if (sub === 0x4D) return res('RETI', 2, { isJump: true });
    if (sub === 0x45) return res('RETN', 2, { isJump: true });
    return res(`ED ${hex8(sub)}`, 2);
  }

  // ── Main unprefixed opcodes ──
  switch (x) {
    case 0:
      switch (z) {
        case 0:
          if (y === 0) return res('NOP', 1);
          if (y === 1) return res("EX AF,AF'", 1);
          if (y === 2) return res(`DJNZ ${hex16(rel8())}`, 2, { isCond: true, condName: 'B!=0', target: rel8() });
          if (y === 3) return res(`JR ${hex16(rel8())}`, 2, { isJump: true, target: rel8() });
          return res(`JR ${CC[y - 4]},${hex16(rel8())}`, 2, { isCond: true, condName: CC[y - 4], target: rel8() });
        case 1:
          if (q === 0) return res(`LD ${R16[p]},${hex16(imm16())}`, 3);
          return res(`ADD HL,${R16[p]}`, 1);
        case 2: {
          if (q === 0) {
            if (p === 0) return res('LD (BC),A', 1);
            if (p === 1) return res('LD (DE),A', 1);
            if (p === 2) return res(`LD (${hex16(imm16())}),HL`, 3);
            return res(`LD (${hex16(imm16())}),A`, 3);
          } else {
            if (p === 0) return res('LD A,(BC)', 1);
            if (p === 1) return res('LD A,(DE)', 1);
            if (p === 2) return res(`LD HL,(${hex16(imm16())})`, 3);
            return res(`LD A,(${hex16(imm16())})`, 3);
          }
        }
        case 3:
          return res(`${q === 0 ? 'INC' : 'DEC'} ${R16[p]}`, 1);
        case 4: return res(`INC ${R8[y]}`, 1);
        case 5: return res(`DEC ${R8[y]}`, 1);
        case 6: return res(`LD ${R8[y]},${hex8(imm8())}`, 2);
        case 7: {
          const misc = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'];
          return res(misc[y], 1);
        }
      }
      break;
    case 1:
      if (y === 6 && z === 6) return res('HALT', 1);
      return res(`LD ${R8[y]},${R8[z]}`, 1);
    case 2:
      return res(`${ALU[y]}${R8[z]}`, 1);
    case 3:
      switch (z) {
        case 0: return res(`RET ${CC[y]}`, 1, { isCond: true, condName: CC[y], isJump: false });
        case 1:
          if (q === 0) return res(`POP ${R16AF[p]}`, 1);
          if (p === 0) return res('RET', 1, { isJump: true });
          if (p === 1) return res("EXX", 1);
          if (p === 2) return res('JP (HL)', 1, { isJump: true });
          return res('LD SP,HL', 1);
        case 2: return res(`JP ${CC[y]},${hex16(imm16())}`, 3, { isCond: true, condName: CC[y], target: imm16() });
        case 3:
          if (y === 0) return res(`JP ${hex16(imm16())}`, 3, { isJump: true, target: imm16() });
          if (y === 2) return res(`OUT (${hex8(imm8())}),A`, 2);
          if (y === 3) return res(`IN A,(${hex8(imm8())})`, 2);
          if (y === 4) return res('EX (SP),HL', 1);
          if (y === 5) return res('EX DE,HL', 1);
          if (y === 6) return res('DI', 1);
          if (y === 7) return res('EI', 1);
          return res(`CB prefix`, 1);
        case 4: return res(`CALL ${CC[y]},${hex16(imm16())}`, 3, { isCond: true, condName: CC[y], target: imm16() });
        case 5:
          if (q === 0) return res(`PUSH ${R16AF[p]}`, 1);
          if (p === 0) return res(`CALL ${hex16(imm16())}`, 3);
          return res(`prefix ${hex8(op)}`, 1);
        case 6: return res(`${ALU[y]}${hex8(imm8())}`, 2);
        case 7: return res(`RST ${hex8(y * 8)}`, 1);
      }
      break;
  }
  return res(`DB ${hex8(op)}`, 1);
}

// ── Loop detection ─────────────────────────────────────────────────────────

interface LoopInfo {
  /** Unique PCs in the cycle, in execution order */
  pcs: number[];
  /** Full cycle length in steps */
  cycleLen: number;
}

function detectLoop(pcTrace: number[]): LoopInfo | null {
  const len = pcTrace.length;
  if (len < 4) return null;

  // Try cycle lengths from 1 up to half the trace
  for (let cl = 1; cl <= Math.min(len / 2, 200); cl++) {
    let match = true;
    // Check that the last `cl` entries repeat at least twice
    for (let i = 0; i < cl; i++) {
      if (pcTrace[len - 1 - i] !== pcTrace[len - 1 - cl - i]) {
        match = false;
        break;
      }
    }
    if (match) {
      const pcs = pcTrace.slice(len - cl, len);
      // Deduplicate while keeping order
      const seen = new Set<number>();
      const unique: number[] = [];
      for (const pc of pcs) {
        if (!seen.has(pc)) {
          seen.add(pc);
          unique.push(pc);
        }
      }
      return { pcs: unique, cycleLen: cl };
    }
  }
  return null;
}

// ── Main diagnostic entry point ────────────────────────────────────────────

export function diagnoseStuckLoop(cpu: Z80): string {
  const lines: string[] = [];

  // Snapshot current state
  const savedPC = cpu.pc;
  const savedT = cpu.tStates;

  // Step the CPU and record PCs
  const SAMPLE_COUNT = 2000;
  const pcTrace: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    pcTrace.push(cpu.pc);
    if (cpu.halted) {
      // If halted, we know the loop: it's just HALT
      lines.push('CPU is HALTed — waiting for interrupt');
      lines.push(`  PC = ${hex16(cpu.pc)}  SP = ${hex16(cpu.sp)}`);
      lines.push(`  IFF1 = ${cpu.iff1}  IFF2 = ${cpu.iff2}  IM = ${cpu.im}`);
      if (!cpu.iff1) {
        lines.push('');
        lines.push('!! Interrupts DISABLED while HALTed — CPU is permanently stuck');
        lines.push('   The CPU will never wake up from HALT without interrupts.');
      }
      dumpRegisters(cpu, lines);
      // Restore
      cpu.pc = savedPC;
      cpu.tStates = savedT;
      cpu.halted = true;
      return lines.join('\n');
    }
    cpu.step();
  }

  const loop = detectLoop(pcTrace);

  if (!loop) {
    lines.push('No simple loop detected in 2000 steps.');
    lines.push(`PC wandered from ${hex16(pcTrace[0])} to ${hex16(pcTrace[pcTrace.length - 1])}`);
    const uniquePCs = new Set(pcTrace);
    lines.push(`Visited ${uniquePCs.size} unique addresses`);
    dumpRegisters(cpu, lines);
    cpu.pc = savedPC;
    cpu.tStates = savedT;
    return lines.join('\n');
  }

  lines.push(`Loop detected: ${loop.cycleLen} steps, ${loop.pcs.length} unique PCs`);
  lines.push('');

  // Disassemble the loop body
  lines.push('--- Loop body ---');
  const conditionals: DisResult[] = [];
  for (const pc of loop.pcs) {
    const d = disassemble(cpu.memory, pc);
    const addr = hex16(pc);
    lines.push(`  ${addr}  ${d.text}`);
    if (d.isCond) conditionals.push({ ...d, target: d.target });
  }

  // Show registers
  lines.push('');
  dumpRegisters(cpu, lines);

  // Analyse exit conditions
  if (conditionals.length > 0) {
    lines.push('');
    lines.push('--- Exit conditions ---');
    for (const c of conditionals) {
      lines.push(analyseCondition(c, cpu));
    }
  }

  // Check if loop is polling a port
  const portReads = loop.pcs
    .map(pc => disassemble(cpu.memory, pc))
    .filter(d => d.text.includes('IN '));
  if (portReads.length > 0) {
    lines.push('');
    lines.push('--- Port polling ---');
    for (const pr of portReads) {
      lines.push(`  ${pr.text}`);
    }
    lines.push('  Loop is polling I/O — may be waiting for hardware response.');
    // Show the port address if we can figure it out
    if (portReads.some(p => p.text.includes('IN A,('))) {
      const port = cpu.a << 8 | cpu.memory[(loop.pcs[0] + 1) & 0xFFFF];
      lines.push(`  Port address (A<<8|n): ${hex16(port)}`);
    }
    if (portReads.some(p => p.text.includes('IN') && p.text.includes('(C)'))) {
      lines.push(`  Port address (BC): ${hex16(cpu.bc)}`);
    }
  }

  // Check for interesting memory reads
  const memReads = loop.pcs
    .map(pc => disassemble(cpu.memory, pc))
    .filter(d => d.text.includes('(HL)') || d.text.includes('(BC)') || d.text.includes('(DE)'));
  if (memReads.length > 0) {
    lines.push('');
    lines.push('--- Memory access ---');
    lines.push(`  HL = ${hex16(cpu.hl)} -> [${hex8(cpu.memory[cpu.hl])}]`);
    lines.push(`  BC = ${hex16(cpu.bc)} -> [${hex8(cpu.memory[cpu.bc])}]`);
    lines.push(`  DE = ${hex16(cpu.de)} -> [${hex8(cpu.memory[cpu.de])}]`);
  }

  // Restore CPU state (we've been stepping it)
  // We can't perfectly restore since we advanced tStates and side effects happened,
  // but restore PC so emulation can continue
  cpu.pc = savedPC;
  cpu.tStates = savedT;

  return lines.join('\n');
}

function dumpRegisters(cpu: Z80, lines: string[]): void {
  lines.push('--- Registers ---');
  lines.push(`  AF = ${hex16(cpu.af)}  BC = ${hex16(cpu.bc)}  DE = ${hex16(cpu.de)}  HL = ${hex16(cpu.hl)}`);
  lines.push(`  AF'= ${hex16((cpu.a_ << 8) | cpu.f_)}  BC'= ${hex16((cpu.b_ << 8) | cpu.c_)}  DE'= ${hex16((cpu.d_ << 8) | cpu.e_)}  HL'= ${hex16((cpu.h_ << 8) | cpu.l_)}`);
  lines.push(`  IX = ${hex16(cpu.ix)}  IY = ${hex16(cpu.iy)}  SP = ${hex16(cpu.sp)}  PC = ${hex16(cpu.pc)}`);
  lines.push(`  I  = ${hex8(cpu.i)}    R  = ${hex8(cpu.r)}    IM = ${cpu.im}    IFF1 = ${cpu.iff1}  IFF2 = ${cpu.iff2}`);

  // Decode flags
  const f = cpu.f;
  const flags = [
    f & 0x80 ? 'S' : '-',
    f & 0x40 ? 'Z' : '-',
    f & 0x10 ? 'H' : '-',
    f & 0x04 ? 'P' : '-',
    f & 0x02 ? 'N' : '-',
    f & 0x01 ? 'C' : '-',
  ].join('');
  lines.push(`  Flags: ${flags}  (S=${f >> 7 & 1} Z=${f >> 6 & 1} H=${f >> 4 & 1} PV=${f >> 2 & 1} N=${f >> 1 & 1} C=${f & 1})`);

  // Stack peek
  lines.push(`  Stack: ${hex16(cpu.sp)} -> ${hex8(cpu.memory[cpu.sp])} ${hex8(cpu.memory[(cpu.sp + 1) & 0xFFFF])} ${hex8(cpu.memory[(cpu.sp + 2) & 0xFFFF])} ${hex8(cpu.memory[(cpu.sp + 3) & 0xFFFF])}`);
}

function analyseCondition(c: DisResult, cpu: Z80): string {
  const f = cpu.f;
  const flagState: Record<string, boolean> = {
    'Z': !!(f & 0x40),
    'NZ': !(f & 0x40),
    'C': !!(f & 0x01),
    'NC': !(f & 0x01),
    'PE': !!(f & 0x04),
    'PO': !(f & 0x04),
    'M': !!(f & 0x80),
    'P': !(f & 0x80),
  };

  const name = c.condName;
  const targetStr = c.target >= 0 ? hex16(c.target) : '(ret addr)';

  if (name === 'B!=0') {
    // DJNZ
    return `  DJNZ: B = ${hex8(cpu.b)} (${cpu.b} dec). Loop runs ${cpu.b} more times. Exits when B reaches 0.`;
  }

  const currentlyTrue = flagState[name];
  if (currentlyTrue !== undefined) {
    const inLoop = currentlyTrue;
    // If the branch target is within the loop PCs, the branch IS the loop-back
    // and the exit is when the condition is NOT met (falls through)
    const branchStr = `${name} is currently ${currentlyTrue ? 'TRUE' : 'FALSE'}`;

    if (inLoop) {
      // Condition is true = branch taken = looping. Need it to become false to exit.
      const inverse: Record<string, string> = {
        'Z': 'NZ (result != 0)', 'NZ': 'Z (result == 0)',
        'C': 'NC (no borrow/carry)', 'NC': 'C (borrow/carry)',
        'PE': 'PO (odd parity / no overflow)', 'PO': 'PE (even parity / overflow)',
        'M': 'P (positive / bit7=0)', 'P': 'M (negative / bit7=1)',
      };
      return `  ${c.text} -> ${targetStr}: ${branchStr} (looping). Exit needs: ${inverse[name] || '?'}`;
    } else {
      return `  ${c.text} -> ${targetStr}: ${branchStr} (not taken — this branch is not the loop-back)`;
    }
  }

  return `  ${c.text} -> ${targetStr}: condition "${name}"`;
}
