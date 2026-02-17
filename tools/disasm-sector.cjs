#!/usr/bin/env node
/**
 * DSK Sector Disassembler
 * Extracts sector data from a DSK disk image and Z80-disassembles it.
 *
 * Usage: node disasm-sector.cjs <disk.dsk> [options]
 *   --track N           Track number (default: 0)
 *   --side N            Side number (default: 0)
 *   --sectors R,...     Hex R values to extract in order (default: all)
 *   --org NNNN          Load address hex, no 0x prefix (default: 0000)
 *   --hex               Hex dump instead of Z80 disassembly
 *   --skip N            Skip first N bytes of extracted data
 *   --count N           Disassemble only N bytes
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Utilities ────────────────────────────────────────────────────────────────

const h2 = n => n.toString(16).toUpperCase().padStart(2, '0');
const h4 = n => (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

// ── DSK Parser ───────────────────────────────────────────────────────────────

function parseDSK(buf) {
  const magic = String.fromCharCode(...buf.slice(0, 8));
  const isExt = magic.startsWith('EXTENDED');
  if (!isExt && !magic.startsWith('MV - CPC')) throw new Error('Not a DSK file');

  const numTracks = buf[0x30];
  const numSides  = buf[0x31];
  const total     = numTracks * numSides;

  const trackSizes = [];
  if (isExt) {
    for (let i = 0; i < total; i++) trackSizes.push(buf[0x34 + i] * 256);
  } else {
    const fixedSize = buf[0x32] | (buf[0x33] << 8);
    for (let i = 0; i < total; i++) trackSizes.push(fixedSize);
  }

  const tracks = [];
  let offset = 256;

  for (let t = 0; t < numTracks; t++) {
    tracks[t] = [];
    for (let s = 0; s < numSides; s++) {
      const idx  = t * numSides + s;
      const size = trackSizes[idx];
      if (size === 0) { tracks[t][s] = null; continue; }

      const toff  = offset;
      const hdr   = String.fromCharCode(...buf.slice(toff, toff + 10));
      if (!hdr.startsWith('Track-Info')) { offset += size; tracks[t][s] = null; continue; }

      const sc     = buf[toff + 0x15];
      const gap3   = buf[toff + 0x16];
      const filler = buf[toff + 0x17];

      const sectors = [];
      let dataOff = toff + 256;   // sector data follows 256-byte track header

      for (let i = 0; i < sc; i++) {
        const sib  = toff + 0x18 + i * 8;
        const c    = buf[sib];
        const h    = buf[sib + 1];
        const r    = buf[sib + 2];
        const n    = buf[sib + 3];
        const st1  = buf[sib + 4];
        const st2  = buf[sib + 5];
        const dlen = isExt ? (buf[sib + 6] | (buf[sib + 7] << 8)) : (128 << n);
        const actualSize = (isExt && dlen > 0) ? dlen : (128 << n);
        sectors.push({ c, h, r, n, st1, st2, actualSize, dataOffset: dataOff });
        dataOff += actualSize;
      }

      tracks[t][s] = { sectors, gap3, filler };
      offset += size;
    }
  }

  return { isExt, numTracks, numSides, tracks };
}

// ── Z80 Disassembler ─────────────────────────────────────────────────────────

const R8    = ['B','C','D','E','H','L','(HL)','A'];
const R16   = ['BC','DE','HL','SP'];
const R16AF = ['BC','DE','HL','AF'];
const CC    = ['NZ','Z','NC','C','PO','PE','P','M'];
const ALU   = ['ADD A,','ADC A,','SUB ','SBC A,','AND ','XOR ','OR ','CP '];
const ROT   = ['RLC','RRC','RL','RR','SLA','SRA','SLL','SRL'];

function disasm(bytes, org) {
  let pos = 0;
  const result = [];

  function byte()  { if (pos >= bytes.length) throw new RangeError('EOF'); return bytes[pos++]; }
  function imm8()  { return byte(); }
  function imm16() { const lo = byte(), hi = byte(); return lo | (hi << 8); }
  function sb(b)   { return b >= 128 ? b - 256 : b; }
  function rel(e)  { return h4((org + pos + sb(e)) & 0xFFFF); }
  function dsp(d)  { return d > 0 ? `+${d}` : d < 0 ? `${d}` : ''; }

  function decode() {
    const addr  = org + pos;
    const start = pos;
    let mn;

    const op = byte();
    if      (op === 0xCB) mn = decodeCB();
    else if (op === 0xDD) mn = decodeXY('IX');
    else if (op === 0xFD) mn = decodeXY('IY');
    else if (op === 0xED) mn = decodeED();
    else                  mn = decodeMain(op);

    const raw = Array.from(bytes.slice(start, pos));
    result.push({ addr, raw, mn });
  }

  // ── Unprefixed instructions ────────────────────────────────────────────────

  function decodeMain(op) {
    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z =  op       & 7;
    const p = (y >> 1)  & 3;
    const q =  y        & 1;

    if (x === 0) {
      switch (z) {
        case 0:
          if (y === 0) return 'NOP';
          if (y === 1) return "EX AF,AF'";
          if (y === 2) { const e = imm8(); return `DJNZ ${rel(e)}h`; }
          if (y === 3) { const e = imm8(); return `JR ${rel(e)}h`; }
          { const e = imm8(); return `JR ${CC[y - 4]},${rel(e)}h`; }
        case 1:
          if (q === 0) return `LD ${R16[p]},${h4(imm16())}h`;
          return `ADD HL,${R16[p]}`;
        case 2:
          if (q === 0) {
            if (p === 0) return 'LD (BC),A';
            if (p === 1) return 'LD (DE),A';
            if (p === 2) return `LD (${h4(imm16())}h),HL`;
            return `LD (${h4(imm16())}h),A`;
          }
          if (p === 0) return 'LD A,(BC)';
          if (p === 1) return 'LD A,(DE)';
          if (p === 2) return `LD HL,(${h4(imm16())}h)`;
          return `LD A,(${h4(imm16())}h)`;
        case 3: return q === 0 ? `INC ${R16[p]}` : `DEC ${R16[p]}`;
        case 4: return `INC ${R8[y]}`;
        case 5: return `DEC ${R8[y]}`;
        case 6: return `LD ${R8[y]},${h2(imm8())}h`;
        case 7: return ['RLCA','RRCA','RLA','RRA','DAA','CPL','SCF','CCF'][y];
      }
    }

    if (x === 1) {
      if (op === 0x76) return 'HALT';
      return `LD ${R8[y]},${R8[z]}`;
    }

    if (x === 2) return ALU[y] + R8[z];

    // x === 3
    switch (z) {
      case 0: return `RET ${CC[y]}`;
      case 1:
        if (q === 0) return `POP ${R16AF[p]}`;
        if (p === 0) return 'RET';
        if (p === 1) return 'EXX';
        if (p === 2) return 'JP (HL)';
        return 'LD SP,HL';
      case 2: return `JP ${CC[y]},${h4(imm16())}h`;
      case 3:
        if (y === 0) return `JP ${h4(imm16())}h`;
        if (y === 2) return `OUT (${h2(imm8())}h),A`;
        if (y === 3) return `IN A,(${h2(imm8())}h)`;
        if (y === 4) return 'EX (SP),HL';
        if (y === 5) return 'EX DE,HL';
        if (y === 6) return 'DI';
        if (y === 7) return 'EI';
        break;
      case 4: return `CALL ${CC[y]},${h4(imm16())}h`;
      case 5:
        if (q === 0) return `PUSH ${R16AF[p]}`;
        if (p === 0) return `CALL ${h4(imm16())}h`;
        break;
      case 6: return ALU[y] + h2(imm8()) + 'h';
      case 7: return `RST ${h2(y * 8)}h`;
    }
    return `DB ${h2(op)}h`;
  }

  // ── CB prefix: rotates, shifts, BIT/RES/SET ───────────────────────────────

  function decodeCB() {
    const op = byte();
    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z =  op       & 7;
    if (x === 0) return `${ROT[y]} ${R8[z]}`;
    if (x === 1) return `BIT ${y},${R8[z]}`;
    if (x === 2) return `RES ${y},${R8[z]}`;
    return `SET ${y},${R8[z]}`;
  }

  // ── DD/FD prefix: IX/IY instructions ─────────────────────────────────────

  function decodeXY(xy) {
    const op = byte();

    // Nested or overriding prefixes
    if (op === 0xCB) return decodeXYCB(xy);
    if (op === 0xDD) { pos--; return decodeXY('IX'); }
    if (op === 0xFD) { pos--; return decodeXY('IY'); }
    if (op === 0xED) return decodeED();

    const XH = `${xy}H`, XL = `${xy}L`;

    switch (op) {
      // 16-bit load / arithmetic
      case 0x09: return `ADD ${xy},BC`;
      case 0x19: return `ADD ${xy},DE`;
      case 0x21: return `LD ${xy},${h4(imm16())}h`;
      case 0x22: return `LD (${h4(imm16())}h),${xy}`;
      case 0x23: return `INC ${xy}`;
      case 0x24: return `INC ${XH}`;
      case 0x25: return `DEC ${XH}`;
      case 0x26: return `LD ${XH},${h2(imm8())}h`;
      case 0x29: return `ADD ${xy},${xy}`;
      case 0x2A: return `LD ${xy},(${h4(imm16())}h)`;
      case 0x2B: return `DEC ${xy}`;
      case 0x2C: return `INC ${XL}`;
      case 0x2D: return `DEC ${XL}`;
      case 0x2E: return `LD ${XL},${h2(imm8())}h`;
      case 0x34: { const d = sb(imm8()); return `INC (${xy}${dsp(d)})`; }
      case 0x35: { const d = sb(imm8()); return `DEC (${xy}${dsp(d)})`; }
      case 0x36: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),${h2(imm8())}h`; }
      case 0x39: return `ADD ${xy},SP`;
      // LD r,(IXY+d) and LD (IXY+d),r
      case 0x46: { const d = sb(imm8()); return `LD B,(${xy}${dsp(d)})`; }
      case 0x4E: { const d = sb(imm8()); return `LD C,(${xy}${dsp(d)})`; }
      case 0x56: { const d = sb(imm8()); return `LD D,(${xy}${dsp(d)})`; }
      case 0x5E: { const d = sb(imm8()); return `LD E,(${xy}${dsp(d)})`; }
      case 0x66: { const d = sb(imm8()); return `LD H,(${xy}${dsp(d)})`; }
      case 0x6E: { const d = sb(imm8()); return `LD L,(${xy}${dsp(d)})`; }
      case 0x7E: { const d = sb(imm8()); return `LD A,(${xy}${dsp(d)})`; }
      case 0x70: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),B`; }
      case 0x71: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),C`; }
      case 0x72: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),D`; }
      case 0x73: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),E`; }
      case 0x74: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),H`; }
      case 0x75: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),L`; }
      case 0x77: { const d = sb(imm8()); return `LD (${xy}${dsp(d)}),A`; }
      // LD r,XH / LD r,XL (undocumented)
      case 0x44: return `LD B,${XH}`;    case 0x45: return `LD B,${XL}`;
      case 0x4C: return `LD C,${XH}`;    case 0x4D: return `LD C,${XL}`;
      case 0x54: return `LD D,${XH}`;    case 0x55: return `LD D,${XL}`;
      case 0x5C: return `LD E,${XH}`;    case 0x5D: return `LD E,${XL}`;
      case 0x60: return `LD ${XH},B`;    case 0x61: return `LD ${XH},C`;
      case 0x62: return `LD ${XH},D`;    case 0x63: return `LD ${XH},E`;
      case 0x64: return `LD ${XH},${XH}`; case 0x65: return `LD ${XH},${XL}`;
      case 0x67: return `LD ${XH},A`;
      case 0x68: return `LD ${XL},B`;    case 0x69: return `LD ${XL},C`;
      case 0x6A: return `LD ${XL},D`;    case 0x6B: return `LD ${XL},E`;
      case 0x6C: return `LD ${XL},${XH}`; case 0x6D: return `LD ${XL},${XL}`;
      case 0x6F: return `LD ${XL},A`;
      case 0x7C: return `LD A,${XH}`;    case 0x7D: return `LD A,${XL}`;
      // ALU (IXY+d) and undocumented ALU XH/XL
      case 0x84: return `ADD A,${XH}`;   case 0x85: return `ADD A,${XL}`;
      case 0x86: { const d = sb(imm8()); return `ADD A,(${xy}${dsp(d)})`; }
      case 0x8C: return `ADC A,${XH}`;   case 0x8D: return `ADC A,${XL}`;
      case 0x8E: { const d = sb(imm8()); return `ADC A,(${xy}${dsp(d)})`; }
      case 0x94: return `SUB ${XH}`;     case 0x95: return `SUB ${XL}`;
      case 0x96: { const d = sb(imm8()); return `SUB (${xy}${dsp(d)})`; }
      case 0x9C: return `SBC A,${XH}`;   case 0x9D: return `SBC A,${XL}`;
      case 0x9E: { const d = sb(imm8()); return `SBC A,(${xy}${dsp(d)})`; }
      case 0xA4: return `AND ${XH}`;     case 0xA5: return `AND ${XL}`;
      case 0xA6: { const d = sb(imm8()); return `AND (${xy}${dsp(d)})`; }
      case 0xAC: return `XOR ${XH}`;     case 0xAD: return `XOR ${XL}`;
      case 0xAE: { const d = sb(imm8()); return `XOR (${xy}${dsp(d)})`; }
      case 0xB4: return `OR ${XH}`;      case 0xB5: return `OR ${XL}`;
      case 0xB6: { const d = sb(imm8()); return `OR (${xy}${dsp(d)})`; }
      case 0xBC: return `CP ${XH}`;      case 0xBD: return `CP ${XL}`;
      case 0xBE: { const d = sb(imm8()); return `CP (${xy}${dsp(d)})`; }
      // Stack / JP
      case 0xE1: return `POP ${xy}`;
      case 0xE3: return `EX (SP),${xy}`;
      case 0xE5: return `PUSH ${xy}`;
      case 0xE9: return `JP (${xy})`;
      case 0xF9: return `LD SP,${xy}`;
      default:
        // DD/FD has no effect on this opcode — disassemble as plain
        pos--;
        return decodeMain(op);
    }
  }

  // ── DDCB/FDCB prefix ────────────────────────────────────────────────────────

  function decodeXYCB(xy) {
    const d  = sb(imm8());
    const op = byte();
    const x  = (op >> 6) & 3;
    const y  = (op >> 3) & 7;
    const z  =  op       & 7;
    const loc = `(${xy}${dsp(d)})`;
    const dst = z === 6 ? '' : `,${R8[z]}`;   // undocumented: also store in register
    if (x === 0) return `${ROT[y]} ${loc}${dst}`;
    if (x === 1) return `BIT ${y},${loc}`;
    if (x === 2) return `RES ${y},${loc}${dst}`;
    return `SET ${y},${loc}${dst}`;
  }

  // ── ED prefix: extended instructions ────────────────────────────────────────

  function decodeED() {
    const op = byte();
    const x  = (op >> 6) & 3;
    const y  = (op >> 3) & 7;
    const z  =  op       & 7;
    const p  = (y >> 1)  & 3;
    const q  =  y        & 1;

    if (x === 1) {
      switch (z) {
        case 0: return y === 6 ? 'IN F,(C)' : `IN ${R8[y]},(C)`;
        case 1: return y === 6 ? 'OUT (C),0' : `OUT (C),${R8[y]}`;
        case 2: return q === 0 ? `SBC HL,${R16[p]}` : `ADC HL,${R16[p]}`;
        case 3: return q === 0
                  ? `LD (${h4(imm16())}h),${R16[p]}`
                  : `LD ${R16[p]},(${h4(imm16())}h)`;
        case 4: return 'NEG';
        case 5: return y === 1 ? 'RETI' : 'RETN';
        case 6: return ['IM 0','IM 0/1','IM 1','IM 2','IM 0','IM 0/1','IM 1','IM 2'][y];
        case 7: return ['LD I,A','LD R,A','LD A,I','LD A,R','RRD','RLD','NOP*','NOP*'][y];
      }
    }

    if (x === 2 && y >= 4 && z <= 3) {
      // Block transfer / search / I-O instructions
      const blt = [
        ['LDI', 'CPI', 'INI', 'OUTI'],
        ['LDD', 'CPD', 'IND', 'OUTD'],
        ['LDIR','CPIR','INIR','OTIR'],
        ['LDDR','CPDR','INDR','OTDR'],
      ];
      return blt[y - 4][z];
    }

    return `DB EDh,${h2(op)}h`;
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  while (pos < bytes.length) {
    const before = pos;
    try {
      decode();
    } catch {
      // Truncated instruction at end of buffer — emit remaining bytes as DB
      while (before < bytes.length && pos <= before) {
        const b = bytes[pos++];
        result.push({ addr: org + pos - 1, raw: [b], mn: `DB ${h2(b)}h` });
      }
    }
  }

  return result;
}

// ── Hex Dump ─────────────────────────────────────────────────────────────────

function hexDump(bytes, baseAddr) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const addr  = h4(baseAddr + i);
    const hex   = chunk.map(h2).join(' ').padEnd(47);
    const ascii = chunk.map(b => b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.').join('');
    lines.push(`${addr}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

// ── Argument parser ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { dskPath: null, track: 0, side: 0, sectors: null,
              org: 0x0000, doHex: false, skip: 0, count: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--track':   a.track   = parseInt(argv[++i]); break;
      case '--side':    a.side    = parseInt(argv[++i]); break;
      case '--sectors': a.sectors = argv[++i].split(',').map(s => parseInt(s.trim(), 16)); break;
      case '--org':     a.org     = parseInt(argv[++i], 16); break;
      case '--hex':     a.doHex   = true; break;
      case '--skip':    a.skip    = parseInt(argv[++i]); break;
      case '--count':   a.count   = parseInt(argv[++i]); break;
      default:          if (!a.dskPath && !argv[i].startsWith('-')) a.dskPath = argv[i]; break;
    }
  }
  return a;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node disasm-sector.cjs <disk.dsk> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --track N           Track number (default: 0)');
    console.log('  --side N            Side number (default: 0)');
    console.log('  --sectors R,...     Hex R values (e.g. 01,02,03) (default: all)');
    console.log('  --org NNNN          Load address hex, no prefix (default: 0000)');
    console.log('  --hex               Hex dump instead of Z80 disassembly');
    console.log('  --skip N            Skip first N bytes of combined sector data');
    console.log('  --count N           Disassemble only N bytes');
    console.log('');
    console.log('Examples:');
    console.log('  # Disassemble T0 sectors 2,3,4 as if loaded at 0x0100');
    console.log('  node disasm-sector.cjs game.dsk --track 0 --sectors 02,03,04 --org 0100');
    console.log('  # Hex dump the protection track');
    console.log('  node disasm-sector.cjs game.dsk --track 33 --hex');
    process.exit(0);
  }

  const a = parseArgs(args);

  if (!a.dskPath) { console.error('Error: No DSK file specified'); process.exit(1); }
  if (!fs.existsSync(a.dskPath)) { console.error(`Error: File not found: ${a.dskPath}`); process.exit(1); }

  const buf = fs.readFileSync(a.dskPath);
  let dsk;
  try { dsk = parseDSK(buf); }
  catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }

  if (a.track >= dsk.numTracks) {
    console.error(`Error: Track ${a.track} out of range (0-${dsk.numTracks - 1})`);
    process.exit(1);
  }
  if (a.side >= dsk.numSides) {
    console.error(`Error: Side ${a.side} out of range (0-${dsk.numSides - 1})`);
    process.exit(1);
  }

  const trackData = dsk.tracks[a.track][a.side];
  if (!trackData) {
    console.error(`Error: Track ${a.track} side ${a.side} is unformatted`);
    process.exit(1);
  }

  // Select sectors (by R value)
  let selected;
  if (a.sectors) {
    selected = a.sectors.map(r => {
      const s = trackData.sectors.find(s => s.r === r);
      if (!s) {
        console.error(`Error: R=${h2(r)}h not found on T${a.track}S${a.side}`);
        process.exit(1);
      }
      return s;
    });
  } else {
    selected = trackData.sectors;
  }

  // Concatenate sector data
  const chunks = selected.map(s => {
    const end = s.dataOffset + s.actualSize;
    if (end > buf.length) {
      console.warn(`Warning: Sector R=${h2(s.r)}h data truncated in file`);
      return buf.slice(s.dataOffset);
    }
    return buf.slice(s.dataOffset, end);
  });
  let data = Buffer.concat(chunks);
  if (a.skip)  data = data.slice(a.skip);
  if (a.count) data = data.slice(0, a.count);

  // Header
  const border = '═'.repeat(65);
  console.log(border);
  console.log(`  DSK:  ${path.basename(a.dskPath)}`);
  console.log(`  Track ${a.track} / Side ${a.side}  ─  ${selected.length} sector(s)`);
  const rList = selected.map(s => `${h2(s.r)}h`).join(', ');
  console.log(`  R values: ${rList}`);
  console.log(`  Bytes:  ${data.length}  │  ORG: ${h4(a.org)}h`);
  console.log(border);
  console.log();

  const bytes = Array.from(data);

  if (a.doHex) {
    console.log(hexDump(bytes, a.org));
    return;
  }

  const instrs = disasm(bytes, a.org);
  for (const { addr, raw, mn } of instrs) {
    const rawStr = raw.map(h2).join(' ').padEnd(14);
    console.log(`  ${h4(addr)}  ${rawStr}  ${mn}`);
  }
}

main();
