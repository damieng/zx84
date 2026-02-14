/**
 * Z80 disassembler — full instruction set including undocumented opcodes.
 *
 * Covers all prefixes (CB, ED, DD, FD, DD CB, FD CB) and undocumented
 * instructions (IXH/IXL/IYH/IYL register access, SLL, ED mirror NOPs,
 * DD/FD CB result-store variants).
 *
 * Mnemonic text uses marker bytes to tag operand types for colorized display:
 *   \x01...\x01 = numeric value (blue)
 *   \x02...\x02 = memory/jump address (purple)
 *   \x03...\x03 = I/O port (red)
 */

export interface DisasmLine {
  addr: number;
  length: number;
  text: string;       // tagged mnemonic
  isTerminal: boolean;
}

const R = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const RP = ['BC', 'DE', 'HL', 'SP'];
const RP2 = ['BC', 'DE', 'HL', 'AF'];
const CC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];

// Plain hex formatters
function h8(v: number): string { return v.toString(16).toUpperCase().padStart(2, '0'); }
function h16(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

// Tagged formatters — marker bytes delimit operand type for colorization
function val(s: string): string { return `\x01${s}\x01`; }
function adr(s: string): string { return `\x02${s}\x02`; }
function prt(s: string): string { return `\x03${s}\x03`; }

function v8(v: number): string { return val(h8(v)); }         // immediate byte
function v16(v: number): string { return val(h16(v)); }       // immediate word
function a16(v: number): string { return adr(h16(v)); }       // jump/memory address
function p8(v: number): string { return prt(h8(v)); }         // I/O port

function disp(d: number): string {
  const s = d < 128 ? d : d - 256;
  return val(s >= 0 ? '+' + h8(s) : '-' + h8(-s));
}

export function disasmOne(mem: Uint8Array, addr: number): DisasmLine {
  const start = addr;
  let terminal = false;
  const rd = () => { const v = mem[addr & 0xFFFF]; addr = (addr + 1) & 0xFFFF; return v; };
  const rd16 = () => { const lo = rd(); return lo | (rd() << 8); };
  const rel = () => { const d = rd(); return (addr + (d < 128 ? d : d - 256)) & 0xFFFF; };

  let op = rd();
  let text = '';

  // ── DD / FD prefix ──────────────────────────────────────────────────
  let ix = ''; // '' = no prefix, 'IX' or 'IY'
  if (op === 0xDD || op === 0xFD) {
    ix = op === 0xDD ? 'IX' : 'IY';
    op = rd();
    if (op === 0xDD || op === 0xFD || op === 0xED) {
      addr = start + 1;
      text = 'NOP*';
      return { addr: start, length: 1, text, isTerminal: false };
    }
    if (op === 0xCB) {
      const d = rd();
      const cb = rd();
      text = decodeDDFDCB(ix, d, cb);
      return { addr: start, length: addr - start, text, isTerminal: false };
    }
  }

  // ── CB prefix ───────────────────────────────────────────────────────
  if (op === 0xCB) {
    const cb = rd();
    text = decodeCB(cb);
    return { addr: start, length: addr - start, text, isTerminal: false };
  }

  // ── ED prefix ───────────────────────────────────────────────────────
  if (op === 0xED) {
    const ed = rd();
    const result = decodeED(ed, rd16);
    text = result.text;
    terminal = result.terminal;
    return { addr: start, length: addr - start, text, isTerminal: terminal };
  }

  // ── Main opcodes ────────────────────────────────────────────────────
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  // Helper: register name with IX/IY substitution
  const rn = (i: number, hasHL: boolean): string => {
    if (!ix) return R[i];
    if (i === 6) return '###';
    if (!hasHL && i === 4) return ix + 'H';
    if (!hasHL && i === 5) return ix + 'L';
    return R[i];
  };

  let dByte = 0;
  let hasDisp = false;
  const ixhl = (): string => {
    if (!ix) return '(HL)';
    if (!hasDisp) { dByte = rd(); hasDisp = true; }
    return `(${ix}${disp(dByte)})`;
  };
  const rpn = (i: number): string => {
    if (ix && i === 2) return ix;
    return RP[i];
  };

  switch (x) {
    case 0:
      switch (z) {
        case 0:
          switch (y) {
            case 0: text = 'NOP'; break;
            case 1: text = "EX AF,AF'"; break;
            case 2: text = `DJNZ ${a16(rel())}`; break;
            case 3: { const t = rel(); text = `JR ${a16(t)}`; terminal = true; break; }
            default: text = `JR ${CC[y - 4]},${a16(rel())}`;
          }
          break;
        case 1:
          if (q === 0) text = `LD ${rpn(p)},${v16(rd16())}`;
          else text = `ADD ${ix || 'HL'},${rpn(p)}`;
          break;
        case 2:
          if (q === 0) {
            switch (p) {
              case 0: text = 'LD (BC),A'; break;
              case 1: text = 'LD (DE),A'; break;
              case 2: text = `LD (${a16(rd16())}),${ix || 'HL'}`; break;
              case 3: text = `LD (${a16(rd16())}),A`; break;
            }
          } else {
            switch (p) {
              case 0: text = 'LD A,(BC)'; break;
              case 1: text = 'LD A,(DE)'; break;
              case 2: text = `LD ${ix || 'HL'},(${a16(rd16())})`; break;
              case 3: text = `LD A,(${a16(rd16())})`; break;
            }
          }
          break;
        case 3:
          text = `${q === 0 ? 'INC' : 'DEC'} ${rpn(p)}`;
          break;
        case 4:
          text = `INC ${y === 6 ? ixhl() : rn(y, false)}`;
          break;
        case 5:
          text = `DEC ${y === 6 ? ixhl() : rn(y, false)}`;
          break;
        case 6: {
          const dst = y === 6 ? ixhl() : rn(y, false);
          text = `LD ${dst},${v8(rd())}`;
          break;
        }
        case 7: {
          const ops = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'];
          text = ops[y];
          break;
        }
      }
      break;

    case 1:
      if (y === 6 && z === 6) {
        text = 'HALT';
        terminal = true;
      } else {
        const usesHL = y === 6 || z === 6;
        const dst = y === 6 ? ixhl() : rn(y, usesHL);
        const src = z === 6 ? ixhl() : rn(z, usesHL);
        text = `LD ${dst},${src}`;
      }
      break;

    case 2: {
      const operand = z === 6 ? ixhl() : rn(z, false);
      text = ALU[y] + operand;
      break;
    }

    case 3:
      switch (z) {
        case 0: text = `RET ${CC[y]}`; break;
        case 1:
          if (q === 0) {
            text = `POP ${ix && p === 2 ? ix : RP2[p]}`;
          } else {
            switch (p) {
              case 0: text = 'RET'; terminal = true; break;
              case 1: text = 'EXX'; break;
              case 2: text = `JP (${ix || 'HL'})`; terminal = true; break;
              case 3: text = `LD SP,${ix || 'HL'}`; break;
            }
          }
          break;
        case 2: text = `JP ${CC[y]},${a16(rd16())}`; break;
        case 3:
          switch (y) {
            case 0: { const t = rd16(); text = `JP ${a16(t)}`; terminal = true; break; }
            case 1: text = '(CB)'; break;
            case 2: text = `OUT (${p8(rd())}),A`; break;
            case 3: text = `IN A,(${p8(rd())})`; break;
            case 4: text = `EX (SP),${ix || 'HL'}`; break;
            case 5: text = 'EX DE,HL'; break;
            case 6: text = 'DI'; break;
            case 7: text = 'EI'; break;
          }
          break;
        case 4: text = `CALL ${CC[y]},${a16(rd16())}`; break;
        case 5:
          if (q === 0) {
            text = `PUSH ${ix && p === 2 ? ix : RP2[p]}`;
          } else {
            switch (p) {
              case 0: text = `CALL ${a16(rd16())}`; break;
              case 1: text = '(DD)'; break;
              case 2: text = '(ED)'; break;
              case 3: text = '(FD)'; break;
            }
          }
          break;
        case 6: text = ALU[y] + v8(rd()); break;
        case 7: text = `RST ${a16(y * 8)}`; break;
      }
      break;
  }

  if (!text) text = `DB ${v8(op)}`;

  return { addr: start, length: addr - start, text, isTerminal: terminal };
}

function decodeCB(op: number): string {
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  switch (x) {
    case 0: return `${ROT[y]} ${R[z]}`;
    case 1: return `BIT ${val(String(y))},${R[z]}`;
    case 2: return `RES ${val(String(y))},${R[z]}`;
    case 3: return `SET ${val(String(y))},${R[z]}`;
  }
  return `DB CB,${v8(op)}`;
}

function decodeDDFDCB(ix: string, d: number, op: number): string {
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const mem = `(${ix}${disp(d)})`;

  if (x === 0) {
    if (z === 6) return `${ROT[y]} ${mem}`;
    return `${ROT[y]} ${mem},${R[z]}`;
  }
  if (x === 1) {
    return `BIT ${val(String(y))},${mem}`;
  }
  const opn = x === 2 ? 'RES' : 'SET';
  if (z === 6) return `${opn} ${val(String(y))},${mem}`;
  return `${opn} ${val(String(y))},${mem},${R[z]}`;
}

function decodeED(
  op: number,
  rd16: () => number,
): { text: string; terminal: boolean } {
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  if (x === 1) {
    switch (z) {
      case 0:
        return { text: y === 6 ? `IN (${prt('C')})` : `IN ${R[y]},(${prt('C')})`, terminal: false };
      case 1:
        return { text: y === 6 ? `OUT (${prt('C')}),${v8(0)}` : `OUT (${prt('C')}),${R[y]}`, terminal: false };
      case 2:
        return { text: q === 0 ? `SBC HL,${RP[p]}` : `ADC HL,${RP[p]}`, terminal: false };
      case 3: {
        const nn = rd16();
        return { text: q === 0 ? `LD (${a16(nn)}),${RP[p]}` : `LD ${RP[p]},(${a16(nn)})`, terminal: false };
      }
      case 4:
        return { text: 'NEG', terminal: false };
      case 5:
        if (y === 1) return { text: 'RETI', terminal: true };
        return { text: 'RETN', terminal: true };
      case 6: {
        const modes = ['0', '0', '1', '2', '0', '0', '1', '2'];
        return { text: `IM ${val(modes[y])}`, terminal: false };
      }
      case 7: {
        const ops = ['LD I,A', 'LD R,A', 'LD A,I', 'LD A,R', 'RRD', 'RLD', 'NOP*', 'NOP*'];
        return { text: ops[y], terminal: false };
      }
    }
  }

  if (x === 2 && y >= 4) {
    const blk: Record<number, string[]> = {
      4: ['LDI', 'CPI', 'INI', 'OUTI'],
      5: ['LDD', 'CPD', 'IND', 'OUTD'],
      6: ['LDIR', 'CPIR', 'INIR', 'OTIR'],
      7: ['LDDR', 'CPDR', 'INDR', 'OTDR'],
    };
    if (z < 4) return { text: blk[y][z], terminal: false };
  }

  return { text: 'NOP*', terminal: false };
}

// ── Multi-line disassembly ────────────────────────────────────────────

export function disassemble(
  mem: Uint8Array,
  startAddr: number,
  maxLines = 24,
): DisasmLine[] {
  const lines: DisasmLine[] = [];
  let addr = startAddr & 0xFFFF;
  for (let i = 0; i < maxLines; i++) {
    const line = disasmOne(mem, addr);
    lines.push(line);
    addr = (addr + line.length) & 0xFFFF;
    if (line.isTerminal) break;
  }
  return lines;
}

/** Convert tagged mnemonic text to HTML with colored spans. */
function colorize(text: string): string {
  return text
    .replace(/\x01([^\x01]*)\x01/g, '<span class="d-val">$1</span>')
    .replace(/\x02([^\x02]*)\x02/g, '<span class="d-adr">$1</span>')
    .replace(/\x03([^\x03]*)\x03/g, '<span class="d-port">$1</span>');
}

/** Strip marker bytes from tagged mnemonic text to get plain text. */
export function stripMarkers(text: string): string {
  return text.replace(/[\x01\x02\x03]/g, '');
}

export function formatDisasmHtml(
  lines: DisasmLine[], mem: Uint8Array, pc: number,
  breakpoints?: Set<number>,
): string {
  return lines.map(l => {
    const cur = l.addr === pc;
    const bp = breakpoints?.has(l.addr);
    const cls = 'd-line' + (cur ? ' d-cur' : '') + (bp ? ' d-bp' : '');
    const addr = h16(l.addr);
    const bytes: string[] = [];
    for (let i = 0; i < l.length; i++) bytes.push(h8(mem[(l.addr + i) & 0xFFFF]));
    const bytesStr = bytes.join(' ').padEnd(11);
    const mnem = colorize(l.text);
    return `<div class="${cls}" data-addr="${l.addr}"><span class="d-off">${addr}</span> <span class="d-hex">${bytesStr}</span> ${mnem}</div>`;
  }).join('');
}
