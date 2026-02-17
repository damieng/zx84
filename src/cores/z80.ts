/*
  Z80 CPU Core
  Based on the official Z80 documentation and various online resources.
  Includes full instruction set, flags, and interrupt handling plus undocumented behavior.
  Passes full zexdoc and zexall test suites.

  I/O is chip-agnostic — wire portOutHandler / portInHandler after construction:
    const cpu = new Z80(memory);
    cpu.portOutHandler = (port, val) => { ... };
    cpu.portInHandler  = (port) => { return 0xFF; };
*/

// Pre-computed flag tables — eliminates per-call bit math in ALU ops
// SZ[i]: Sign | Zero | undocumented bits 3,5
const SZ = new Uint8Array(256);
// SZP[i]: SZ[i] with parity bit (0x04) added
const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const s = i & 0x80;        // sign
  const z = i === 0 ? 0x40 : 0; // zero
  const u = i & 0x28;        // undocumented bits 3,5
  SZ[i] = s | z | u;
  // parity: even number of set bits → 0x04
  let p = i;
  p ^= p >> 4;
  p ^= p >> 2;
  p ^= p >> 1;
  SZP[i] = s | z | u | ((p & 1) === 0 ? 0x04 : 0);
}

// Opcodes that reference H, L, or HL and should be remapped by DD/FD prefix.
// Opcodes NOT in this set execute normally (prefix ignored, just adds 4 T-states).
const _ddfdHL = new Uint8Array(256);
(() => {
  // 16-bit HL: ADD HL,rr / INC HL / DEC HL / LD HL,nn / LD (nn),HL / LD HL,(nn) / LD SP,HL
  for (const op of [0x09, 0x19, 0x29, 0x39, 0x21, 0x22, 0x23, 0x2A, 0x2B, 0xF9]) _ddfdHL[op] = 1;
  // PUSH/POP HL, EX (SP),HL, JP (HL)
  for (const op of [0xE1, 0xE3, 0xE5, 0xE9]) _ddfdHL[op] = 1;
  // 8-bit H/L: INC/DEC H/L
  for (const op of [0x24, 0x25, 0x2C, 0x2D]) _ddfdHL[op] = 1;
  // LD r,H / LD r,L (x=1, z=4 or z=5, y!=6)
  for (let y = 0; y < 8; y++) {
    if (y === 6) continue;
    _ddfdHL[0x40 | (y << 3) | 4] = 1; // LD r,H
    _ddfdHL[0x40 | (y << 3) | 5] = 1; // LD r,L
  }
  // LD H,r / LD L,r (x=1, y=4 or y=5, z!=6)
  for (let z = 0; z < 8; z++) {
    if (z === 6) continue;
    _ddfdHL[0x40 | (4 << 3) | z] = 1; // LD H,r
    _ddfdHL[0x40 | (5 << 3) | z] = 1; // LD L,r
  }
  // ALU A,H / ALU A,L (x=2, z=4 or z=5)
  for (let y = 0; y < 8; y++) {
    _ddfdHL[0x80 | (y << 3) | 4] = 1; // ALU A,H
    _ddfdHL[0x80 | (y << 3) | 5] = 1; // ALU A,L
  }
  // LD H,n / LD L,n (0x26, 0x2E) — handled earlier in DD/FD, but mark just in case
  _ddfdHL[0x26] = 1;
  _ddfdHL[0x2E] = 1;
})();
function ddfdUsesHL(op: number): boolean { return _ddfdHL[op] !== 0; }

export class Z80 {
  memory: Uint8Array;
  portOutHandler: ((port: number, val: number) => void) | null;
  portInHandler: ((port: number) => number) | null;
  postStepHook: ((cpu: Z80) => void) | null;
  trapHandler: ((pc: number) => void) | null;

  // Main registers
  a = 0; f = 0;
  b = 0; c = 0;
  d = 0; e = 0;
  h = 0; l = 0;

  // MEMPTR (WZ) - internal 16-bit register for undocumented flags
  memptr = 0;

  // Shadow registers
  a_ = 0; f_ = 0;
  b_ = 0; c_ = 0;
  d_ = 0; e_ = 0;
  h_ = 0; l_ = 0;

  // Index registers
  ix = 0;
  iy = 0;

  // Other registers
  sp = 0;
  pc = 0;
  i = 0;
  r = 0;

  // Interrupt state
  iff1 = false;
  iff2 = false;
  im = 1;
  halted = false;

  // T-state counter
  tStates = 0;

  /** Vector byte for next IM 2 interrupt (0xFF = standard frame interrupt) */
  _pendingVector = 0xFF;

  // Flag constants
  static readonly FLAG_C = 0x01;
  static readonly FLAG_N = 0x02;
  static readonly FLAG_PV = 0x04;
  static readonly FLAG_H = 0x10;
  static readonly FLAG_Z = 0x40;
  static readonly FLAG_S = 0x80;

  constructor(memory: Uint8Array) {
    this.memory = memory;
    this.portOutHandler = null;
    this.portInHandler = null;
    this.postStepHook = null;
    this.trapHandler = null;
    this.reset();
  }

  reset(): void {
    this.a = 0; this.f = 0;
    this.b = 0; this.c = 0;
    this.d = 0; this.e = 0;
    this.h = 0; this.l = 0;

    this.a_ = 0; this.f_ = 0;
    this.b_ = 0; this.c_ = 0;
    this.d_ = 0; this.e_ = 0;
    this.h_ = 0; this.l_ = 0;

    this.ix = 0;
    this.iy = 0;

    this.sp = 0;
    this.pc = 0;
    this.i = 0;
    this.r = 0;

    this.iff1 = false;
    this.iff2 = false;
    this.im = 1;
    this.halted = false;

    this.memptr = 0;
    this.tStates = 0;
    this._pendingVector = 0xFF;
  }

  loadBinary(data: Uint8Array, address: number): void {
    if (address + data.length <= 65536) {
      this.memory.set(data, address);
    } else {
      for (let i = 0; i < data.length; i++) {
        this.memory[(address + i) & 0xFFFF] = data[i];
      }
    }
  }

  // Helper register pair access
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  get af(): number { return (this.a << 8) | this.f; }
  set af(v: number) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }

  // Memory access
  read8(addr: number): number {
    return this.memory[addr & 0xFFFF];
  }

  write8(addr: number, val: number): void {
    this.memory[addr & 0xFFFF] = val & 0xFF;
  }

  read16(addr: number): number {
    const lo = this.read8(addr);
    this.tStates += 3;  // 3T between consecutive memory reads
    return lo | (this.read8(addr + 1) << 8);
  }

  write16(addr: number, val: number): void {
    this.write8(addr, val & 0xFF);
    this.tStates += 3;  // 3T between consecutive memory writes
    this.write8(addr + 1, (val >> 8) & 0xFF);
  }

  fetch8(): number {
    const v = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    this.tStates += 3;  // Memory read cycle = 3T (contention checked at correct beam position)
    return v;
  }

  fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return (hi << 8) | lo;
  }

  push16(val: number): void {
    this.sp = (this.sp - 2) & 0xFFFF;
    this.write16(this.sp, val);
  }

  pop16(): number {
    const val = this.read16(this.sp);
    this.sp = (this.sp + 2) & 0xFFFF;
    return val;
  }

  // Flag helpers
  getFlag(flag: number): boolean { return (this.f & flag) !== 0; }
  setFlag(flag: number, val: boolean): void { this.f = val ? (this.f | flag) : (this.f & ~flag); }

  // --- I/O port handling ---
  portOut(port: number, val: number): void {
    if (this.portOutHandler) this.portOutHandler(port, val);
  }

  portIn(port: number): number {
    return this.portInHandler ? this.portInHandler(port) : 0xFF;
  }

  // --- Interrupt handling ---
  interrupt(): number {
    if (!this.iff1) return 0;

    this.halted = false;
    this.iff1 = false;
    this.iff2 = false;

    switch (this.im) {
      case 0:
        // IM 0: RST 38h on Spectrum. 13T: ack(7T), push@T+7/T+10
        this.tStates += 7;
        this.push16(this.pc);
        this.pc = 0x0038;
        this.tStates += 3;
        return 13;

      case 1:
        // IM 1: RST 38h. 13T: ack(7T), push@T+7/T+10
        this.tStates += 7;
        this.push16(this.pc);
        this.pc = 0x0038;
        this.tStates += 3;
        return 13;

      case 2: {
        // IM 2: vectored interrupt. 19T: ack(7T), push@T+7/T+10, read@T+13/T+16
        // Real Z80 pushes PC first, then reads the vector table.
        // Standard frame interrupt puts 0xFF on the bus; peripheral interrupts
        // supply their own vector byte via interruptWithVector().
        const vectorAddr = ((this.i << 8) | (this._pendingVector & 0xFF)) & 0xFFFF;
        this._pendingVector = 0xFF;
        this.tStates += 7;
        this.push16(this.pc);
        this.tStates += 3;
        this.pc = this.read16(vectorAddr);
        this.tStates += 3;
        return 19;
      }

      default:
        this.tStates += 7;
        this.push16(this.pc);
        this.pc = 0x0038;
        this.tStates += 3;
        return 13;
    }
  }

  /** Fire an IM 2 interrupt with a specific vector byte (for peripheral devices like Z80 PIO). */
  interruptWithVector(vector: number): number {
    this._pendingVector = vector & 0xFE; // PIO vectors are always even
    return this.interrupt();
  }

  // --- ALU operations ---
  add8(a: number, b: number): number {
    const result = a + b;
    const r8 = result & 0xFF;
    this.f = SZ[r8] |
             (result > 0xFF ? 0x01 : 0) |
             ((a ^ b ^ r8) & 0x10) |
             (((a ^ ~b) & (a ^ r8) & 0x80) ? 0x04 : 0);
    return r8;
  }

  adc8(a: number, b: number): number {
    const c = this.f & 0x01;
    const result = a + b + c;
    const r8 = result & 0xFF;
    this.f = SZ[r8] |
             (result > 0xFF ? 0x01 : 0) |
             ((a ^ b ^ r8) & 0x10) |
             (((a ^ ~b) & (a ^ r8) & 0x80) ? 0x04 : 0);
    return r8;
  }

  sub8(a: number, b: number): number {
    const result = a - b;
    const r8 = result & 0xFF;
    this.f = SZ[r8] |
             0x02 |
             (result < 0 ? 0x01 : 0) |
             ((a ^ b ^ r8) & 0x10) |
             (((a ^ b) & (a ^ r8) & 0x80) ? 0x04 : 0);
    return r8;
  }

  sbc8(a: number, b: number): number {
    const c = this.f & 0x01;
    const result = a - b - c;
    const r8 = result & 0xFF;
    this.f = SZ[r8] |
             0x02 |
             (result < 0 ? 0x01 : 0) |
             ((a ^ b ^ r8) & 0x10) |
             (((a ^ b) & (a ^ r8) & 0x80) ? 0x04 : 0);
    return r8;
  }

  and8(val: number): void {
    this.a &= val;
    this.f = SZP[this.a] | 0x10;
  }

  or8(val: number): void {
    this.a |= val;
    this.f = SZP[this.a];
  }

  xor8(val: number): void {
    this.a ^= val;
    this.f = SZP[this.a];
  }

  cp8(val: number): void {
    const result = this.a - val;
    const r8 = result & 0xFF;
    this.f = (r8 & 0x80) |
             (r8 === 0 ? 0x40 : 0) |
             (val & 0x28) |
             0x02 |
             (result < 0 ? 0x01 : 0) |
             ((this.a ^ val ^ r8) & 0x10) |
             (((this.a ^ val) & (this.a ^ r8) & 0x80) ? 0x04 : 0);
  }

  inc8(val: number): number {
    const r = (val + 1) & 0xFF;
    this.f = (this.f & 0x01) |
             SZ[r] |
             ((val & 0x0F) === 0x0F ? 0x10 : 0) |
             (val === 0x7F ? 0x04 : 0);
    return r;
  }

  dec8(val: number): number {
    const r = (val - 1) & 0xFF;
    this.f = (this.f & 0x01) |
             SZ[r] |
             0x02 |
             ((val & 0x0F) === 0x00 ? 0x10 : 0) |
             (val === 0x80 ? 0x04 : 0);
    return r;
  }

  add16(a: number, b: number): number {
    const result = a + b;
    this.memptr = (a + 1) & 0xFFFF;  // MEMPTR = original value + 1
    this.f = (this.f & 0xC4) |
             ((result >> 16) & 0x01) |
             (((a ^ b ^ result) >> 8) & 0x10) |
             ((result >> 8) & 0x28);  // Undoc flags from result high byte
    return result & 0xFFFF;
  }

  adc16(a: number, b: number): number {
    const c = this.f & 0x01;
    const result = a + b + c;
    const r16 = result & 0xFFFF;
    this.memptr = (a + 1) & 0xFFFF;  // MEMPTR = original value + 1
    this.f = ((r16 >> 8) & 0x80) |
             (r16 === 0 ? 0x40 : 0) |
             ((r16 >> 8) & 0x28) |  // Undoc flags from result high byte
             ((result >> 16) & 0x01) |
             (((a ^ b ^ r16) >> 8) & 0x10) |
             (((a ^ ~b) & (a ^ r16) & 0x8000) ? 0x04 : 0);
    return r16;
  }

  sbc16(a: number, b: number): number {
    const c = this.f & 0x01;
    const result = a - b - c;
    const r16 = result & 0xFFFF;
    this.memptr = (a + 1) & 0xFFFF;  // MEMPTR = original value + 1
    this.f = ((r16 >> 8) & 0x80) |
             (r16 === 0 ? 0x40 : 0) |
             ((r16 >> 8) & 0x28) |  // Undoc flags from result high byte
             0x02 |
             (result < 0 ? 0x01 : 0) |
             (((a ^ b ^ r16) >> 8) & 0x10) |
             (((a ^ b) & (a ^ r16) & 0x8000) ? 0x04 : 0);
    return r16;
  }

  // --- Rotate/Shift operations ---
  rlc(val: number): number {
    const c = (val >> 7) & 1;
    const r = ((val << 1) | c) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  rrc(val: number): number {
    const c = val & 1;
    const r = ((val >> 1) | (c << 7)) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  rl(val: number): number {
    const oldC = this.f & 0x01;
    const c = (val >> 7) & 1;
    const r = ((val << 1) | oldC) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  rr(val: number): number {
    const oldC = this.f & 0x01;
    const c = val & 1;
    const r = ((val >> 1) | (oldC << 7)) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  sla(val: number): number {
    const c = (val >> 7) & 1;
    const r = (val << 1) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  sra(val: number): number {
    const c = val & 1;
    const r = ((val >> 1) | (val & 0x80)) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  srl(val: number): number {
    const c = val & 1;
    const r = (val >> 1) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  sll(val: number): number {
    const c = (val >> 7) & 1;
    const r = ((val << 1) | 1) & 0xFF;
    this.f = SZP[r] | c;
    return r;
  }

  bit(n: number, val: number): void {
    const r = val & (1 << n);
    this.f = (this.f & 0x01) |         // Preserve C
             0x10 |                     // Set H
             (r ? 0 : 0x44) |           // Set Z and P/V if bit is 0
             (r & 0x80) |               // Set S if testing bit 7 and it's set
             (val & 0x28);              // Copy bits 3,5 from value (undocumented X,Y flags)
    // N flag (bit 1) is implicitly cleared since we don't set it
  }

  // --- Get/set 8-bit register by 3-bit code ---
  getReg8(code: number): number {
    switch (code) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.read8(this.hl);
      case 7: return this.a;
    }
    return 0;
  }

  setReg8(code: number, val: number): void {
    val &= 0xFF;
    switch (code) {
      case 0: this.b = val; break;
      case 1: this.c = val; break;
      case 2: this.d = val; break;
      case 3: this.e = val; break;
      case 4: this.h = val; break;
      case 5: this.l = val; break;
      case 6: this.write8(this.hl, val); break;
      case 7: this.a = val; break;
    }
  }

  getReg16(code: number): number {
    switch (code) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      case 3: return this.sp;
    }
    return 0;
  }

  setReg16(code: number, val: number): void {
    val &= 0xFFFF;
    switch (code) {
      case 0: this.bc = val; break;
      case 1: this.de = val; break;
      case 2: this.hl = val; break;
      case 3: this.sp = val; break;
    }
  }

  getReg16AF(code: number): number {
    switch (code) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      case 3: return this.af;
    }
    return 0;
  }

  setReg16AF(code: number, val: number): void {
    val &= 0xFFFF;
    switch (code) {
      case 0: this.bc = val; break;
      case 1: this.de = val; break;
      case 2: this.hl = val; break;
      case 3: this.af = val; break;
    }
  }

  checkCondition(cc: number): boolean {
    switch (cc) {
      case 0: return !(this.f & 0x40);
      case 1: return !!(this.f & 0x40);
      case 2: return !(this.f & 0x01);
      case 3: return !!(this.f & 0x01);
      case 4: return !(this.f & 0x04);
      case 5: return !!(this.f & 0x04);
      case 6: return !(this.f & 0x80);
      case 7: return !!(this.f & 0x80);
    }
    return false;
  }

  // --- Execute instructions until tStates budget is reached or CPU halts ---
  run(tBudget: number): void {
    const mem = this.memory;
    const limit = this.tStates + tBudget;
    while (this.tStates < limit) {
      if (this.halted) {
        // Skip remaining budget in one go (HALT burns 4 T per NOP)
        const remaining = limit - this.tStates;
        const nops = ((remaining + 3) / 4) | 0;
        this.tStates += nops * 4;
        this.r = (this.r & 0x80) | ((this.r + nops) & 0x7F);
        return;
      }
      const opcode = mem[this.pc];
      this.pc = (this.pc + 1) & 0xFFFF;
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      this.tStates += 4;  // M1 cycle (no contention hooks in fast path)
      this.executeMain(opcode);
    }
  }

  // --- Execute one instruction ---
  step(): number {
    if (this.halted) {
      // HALT repeats a NOP-like M1 fetch from PC — apply contention
      this.read8(this.pc);
      this.tStates += 4;
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      return 4;
    }

    const startT = this.tStates;
    const opcode = this.fetch8();      // +3T (M1 read)
    this.tStates += 1;                 // +1T (M1 refresh cycle)
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    this.executeMain(opcode);

    if (this.postStepHook) this.postStepHook(this);

    const elapsed = this.tStates - startT;
    if (elapsed <= 0) {
      this.tStates += 4;
      return 4;
    }
    return elapsed;
  }

  executeMain(opcode: number): void {
    const x = (opcode >> 6) & 3;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const p = (y >> 1) & 3;
    const q = y & 1;

    switch (x) {
      case 0:
        switch (z) {
          case 0:
            switch (y) {
              case 0:
                // NOP: 4T (M1 auto-counted)
                break;
              case 1: {
                // EX AF,AF': 4T (M1 auto-counted)
                let tmp: number;
                tmp = this.a; this.a = this.a_; this.a_ = tmp;
                tmp = this.f; this.f = this.f_; this.f_ = tmp;
                break;
              }
              case 2: {
                // DJNZ: 13T/8T. Auto: 4T M1 + 3T operand = 7T
                const offset = this.fetch8();
                this.b = (this.b - 1) & 0xFF;
                if (this.b !== 0) {
                  this.pc = (this.pc + (offset < 128 ? offset : offset - 256)) & 0xFFFF;
                  this.memptr = this.pc;  // DJNZ (taken): MEMPTR = jump target
                  this.tStates += 6;
                } else {
                  this.tStates += 1;
                }
                break;
              }
              case 3: {
                // JR: 12T. Auto: 7T
                const offset = this.fetch8();
                this.pc = (this.pc + (offset < 128 ? offset : offset - 256)) & 0xFFFF;
                this.memptr = this.pc;  // JR: MEMPTR = jump target
                this.tStates += 5;
                break;
              }
              default: {
                // JR cc: 12T/7T. Auto: 7T
                const offset = this.fetch8();
                if (this.checkCondition(y - 4)) {
                  this.pc = (this.pc + (offset < 128 ? offset : offset - 256)) & 0xFFFF;
                  this.memptr = this.pc;  // JR cc (taken): MEMPTR = jump target
                  this.tStates += 5;
                } else {
                  this.tStates += 1;
                }
                break;
              }
            }
            break;

          case 1:
            if (q === 0) {
              // LD rr,nn: 10T. Auto: 4T M1 + 6T fetch16 = 10T
              this.setReg16(p, this.fetch16());
            } else {
              // ADD HL,rr: 11T. Auto: 4T M1
              this.hl = this.add16(this.hl, this.getReg16(p));
              this.tStates += 7;
            }
            break;

          case 2:
            if (q === 0) {
              // Write instructions — M1 auto-counted (4T), contention at correct sub-cycle
              switch (p) {
                case 0: this.write8(this.bc, this.a); this.memptr = ((this.bc + 1) & 0xFF) | (this.a << 8); this.tStates += 3; break;  // LD (BC),A: 7T, write@T+4
                case 1: this.write8(this.de, this.a); this.memptr = ((this.de + 1) & 0xFF) | (this.a << 8); this.tStates += 3; break;  // LD (DE),A: 7T, write@T+4
                case 2: { const addr = this.fetch16(); this.write16(addr, this.hl); this.memptr = (addr + 1) & 0xFFFF; this.tStates += 3; break; }  // LD (nn),HL: 16T, writes@T+10,T+13
                case 3: { const addr = this.fetch16(); this.write8(addr, this.a); this.memptr = ((addr + 1) & 0xFF) | (this.a << 8); this.tStates += 3; break; }    // LD (nn),A: 13T, write@T+10
              }
            } else {
              // Read instructions — M1 auto-counted (4T), contention at correct sub-cycle
              switch (p) {
                case 0: this.a = this.read8(this.bc); this.memptr = (this.bc + 1) & 0xFFFF; this.tStates += 3; break;  // LD A,(BC): 7T, read@T+4
                case 1: this.a = this.read8(this.de); this.memptr = (this.de + 1) & 0xFFFF; this.tStates += 3; break;  // LD A,(DE): 7T, read@T+4
                case 2: { const addr = this.fetch16(); this.hl = this.read16(addr); this.memptr = (addr + 1) & 0xFFFF; this.tStates += 3; break; }  // LD HL,(nn): 16T, reads@T+10,T+13
                case 3: { const addr = this.fetch16(); this.a = this.read8(addr); this.memptr = (addr + 1) & 0xFFFF; this.tStates += 3; break; }    // LD A,(nn): 13T, read@T+10
              }
            }
            break;

          case 3:
            // INC/DEC rr: 6T. Auto: 4T M1
            if (q === 0) {
              this.setReg16(p, (this.getReg16(p) + 1) & 0xFFFF);
            } else {
              this.setReg16(p, (this.getReg16(p) - 1) & 0xFFFF);
            }
            this.tStates += 2;
            break;

          case 4: {
            if (y === 6) {
              // INC (HL): 11T, read@T+4, write@T+8. Auto: 4T M1
              const val = this.read8(this.hl);
              this.tStates += 4;
              this.write8(this.hl, this.inc8(val));
              this.tStates += 3;
            } else {
              // INC r: 4T (M1 auto-counted)
              this.setReg8(y, this.inc8(this.getReg8(y)));
            }
            break;
          }

          case 5: {
            if (y === 6) {
              // DEC (HL): 11T, read@T+4, write@T+8. Auto: 4T M1
              const val = this.read8(this.hl);
              this.tStates += 4;
              this.write8(this.hl, this.dec8(val));
              this.tStates += 3;
            } else {
              // DEC r: 4T (M1 auto-counted)
              this.setReg8(y, this.dec8(this.getReg8(y)));
            }
            break;
          }

          case 6:
            if (y === 6) {
              // LD (HL),n: 10T, write@T+7. Auto: 4T M1 + 3T operand = 7T
              const n = this.fetch8();
              this.write8(this.hl, n);
              this.tStates += 3;
            } else {
              // LD r,n: 7T. Auto: 4T M1 + 3T operand = 7T
              this.setReg8(y, this.fetch8());
            }
            break;

          case 7:
            switch (y) {
              case 0: {
                const c = (this.a >> 7) & 1;
                this.a = ((this.a << 1) | c) & 0xFF;
                this.f = (this.f & 0xC4) | c | (this.a & 0x28);
                break;
              }
              case 1: {
                const c = this.a & 1;
                this.a = ((this.a >> 1) | (c << 7)) & 0xFF;
                this.f = (this.f & 0xC4) | c | (this.a & 0x28);
                break;
              }
              case 2: {
                const oldC = this.f & 0x01;
                const c = (this.a >> 7) & 1;
                this.a = ((this.a << 1) | oldC) & 0xFF;
                this.f = (this.f & 0xC4) | c | (this.a & 0x28);
                break;
              }
              case 3: {
                const oldC = this.f & 0x01;
                const c = this.a & 1;
                this.a = ((this.a >> 1) | (oldC << 7)) & 0xFF;
                this.f = (this.f & 0xC4) | c | (this.a & 0x28);
                break;
              }
              case 4: {
                // DAA - Decimal Adjust Accumulator (from floooh/rz80)
                const origA = this.a;
                let val = origA;
                const f = this.f;

                if (f & 0x02) {
                  // After subtraction (N flag set)
                  if (((origA & 0x0F) > 0x09) || (f & 0x10)) {
                    val = (val - 0x06) & 0xFF;
                  }
                  if ((origA > 0x99) || (f & 0x01)) {
                    val = (val - 0x60) & 0xFF;
                  }
                } else {
                  // After addition (N flag clear)
                  if (((origA & 0x0F) > 0x09) || (f & 0x10)) {
                    val = (val + 0x06) & 0xFF;
                  }
                  if ((origA > 0x99) || (f & 0x01)) {
                    val = (val + 0x60) & 0xFF;
                  }
                }

                // Set flags: preserve C and N, set new C if needed, H from XOR, then S/Z/P
                this.f = (f & 0x03) |                        // Preserve C and N
                         (origA > 0x99 ? 0x01 : 0) |         // Set C if A > 0x99
                         ((origA ^ val) & 0x10) |            // H flag from bit 4 change
                         SZP[val];                           // S, Z, undoc bits 3,5, P/V
                this.a = val;
                break;
              }
              case 5:
                this.a ^= 0xFF;
                this.f = (this.f & 0xC5) | 0x12 | (this.a & 0x28);
                break;
              case 6:
                // SCF - Set Carry Flag
                this.f = (this.f & 0xC4) | 0x01 | (this.a & 0x28);
                break;
              case 7:
                // CCF - Complement Carry Flag
                this.f = ((this.f & 0xED) | ((this.f & 0x01) << 4) | (this.a & 0x28)) ^ 0x01;
                break;
            }
            // 4T instructions (M1 auto-counted)
            break;
        }
        break;

      case 1:
        if (y === 6 && z === 6) {
          // HALT: 4T (M1 auto-counted)
          this.halted = true;
        } else if (y === 6) {
          // LD (HL),r: 7T, write@T+4. Auto: 4T M1
          const val = this.getReg8(z);
          this.write8(this.hl, val);
          this.tStates += 3;
        } else if (z === 6) {
          // LD r,(HL): 7T, read@T+4. Auto: 4T M1
          this.setReg8(y, this.read8(this.hl));
          this.tStates += 3;
        } else {
          // LD r,r: 4T (M1 auto-counted)
          this.setReg8(y, this.getReg8(z));
        }
        break;

      case 2:
        if (z === 6) {
          // ALU A,(HL): 7T, read@T+4. Auto: 4T M1
          this.aluOp(y, this.read8(this.hl));
          this.tStates += 3;
        } else {
          // ALU A,r: 4T (M1 auto-counted)
          this.aluOp(y, this.getReg8(z));
        }
        break;

      case 3:
        switch (z) {
          case 0:
            if (this.checkCondition(y)) {
              // RET cc (true): 11T, reads@T+5,T+8. Auto: 4T M1
              this.tStates += 1;
              this.memptr = this.pc = this.pop16();  // RET: MEMPTR = PC = target
              this.tStates += 3;
            } else {
              // RET cc (false): 5T. Auto: 4T M1
              this.tStates += 1;
            }
            break;

          case 1:
            if (q === 0) {
              // POP qq: 10T, reads@T+4,T+7. Auto: 4T M1
              this.setReg16AF(p, this.pop16());
              this.tStates += 3;
            } else {
              switch (p) {
                case 0:
                  // RET: 10T, reads@T+4,T+7. Auto: 4T M1
                  this.memptr = this.pc = this.pop16();  // RET: MEMPTR = PC = target
                  this.tStates += 3;
                  break;
                case 1: {
                  // EXX: 4T (M1 auto-counted)
                  let tmp: number;
                  tmp = this.b; this.b = this.b_; this.b_ = tmp;
                  tmp = this.c; this.c = this.c_; this.c_ = tmp;
                  tmp = this.d; this.d = this.d_; this.d_ = tmp;
                  tmp = this.e; this.e = this.e_; this.e_ = tmp;
                  tmp = this.h; this.h = this.h_; this.h_ = tmp;
                  tmp = this.l; this.l = this.l_; this.l_ = tmp;
                  break;
                }
                case 2:
                  // JP (HL): 4T (M1 auto-counted)
                  this.pc = this.hl;
                  break;
                case 3:
                  // LD SP,HL: 6T. Auto: 4T M1
                  this.sp = this.hl;
                  this.tStates += 2;
                  break;
              }
            }
            break;

          case 2: {
            // JP cc,nn: 10T. Auto: 4T M1 + 6T fetch16 = 10T
            const addr = this.fetch16();
            this.memptr = addr;  // Always set MEMPTR, even if jump not taken
            if (this.checkCondition(y)) {
              this.pc = addr;
            }
            break;
          }

          case 3:
            switch (y) {
              case 0:
                // JP nn: 10T. Auto: 4T M1 + 6T fetch16 = 10T
                this.memptr = this.pc = this.fetch16();
                break;
              case 1:
                this.executeCB();
                break;
              case 2: {
                // OUT (n),A: 11T. Auto: 4T M1 + 3T operand = 7T
                const port = (this.a << 8) | this.fetch8();
                this.portOut(port, this.a);
                this.memptr = ((port + 1) & 0xFF) | (this.a << 8);  // OUT (port),A: MEMPTR_low = (port+1) & 0xFF, MEMPTR_hi = A
                this.tStates += 4;
                break;
              }
              case 3: {
                // IN A,(n): 11T. Auto: 4T M1 + 3T operand = 7T
                const aBeforeOp = this.a;
                const portLow = this.fetch8();
                const port = (this.a << 8) | portLow;
                this.a = this.portIn(port);
                this.memptr = ((aBeforeOp << 8) + portLow + 1) & 0xFFFF;  // IN A,(port): MEMPTR = (A_before << 8) + port_low + 1
                this.tStates += 4;
                break;
              }
              case 4: {
                // EX (SP),HL: 19T, reads@T+4/T+7, writes@T+11/T+14. Auto: 4T M1
                const lo = this.read8(this.sp);
                this.tStates += 3;
                const hi = this.read8((this.sp + 1) & 0xFFFF);
                this.tStates += 4;
                this.write8(this.sp, this.l);
                this.tStates += 3;
                this.write8((this.sp + 1) & 0xFFFF, this.h);
                this.l = lo; this.h = hi;
                this.memptr = (hi << 8) | lo;  // EX (SP),rp: MEMPTR = rp value after the operation
                this.tStates += 5;
                break;
              }
              case 5: {
                // EX DE,HL: 4T (M1 auto-counted)
                const tmp = this.de;
                this.de = this.hl;
                this.hl = tmp;
                break;
              }
              case 6:
                // DI: 4T (M1 auto-counted)
                this.iff1 = false;
                this.iff2 = false;
                break;
              case 7:
                // EI: 4T (M1 auto-counted)
                this.iff1 = true;
                this.iff2 = true;
                break;
            }
            break;

          case 4: {
            // CALL cc,nn: 17T/10T. Auto: 4T M1 + 6T fetch16 = 10T
            const addr = this.fetch16();
            this.memptr = addr;  // Always set MEMPTR, even if call not made
            if (this.checkCondition(y)) {
              // CALL cc,nn (true): 17T, writes@T+11,T+14
              this.tStates += 1;
              this.push16(this.pc);
              this.pc = addr;
              this.tStates += 3;
            }
            break;
          }

          case 5:
            if (q === 0) {
              // PUSH qq: 11T, writes@T+5,T+8. Auto: 4T M1
              this.tStates += 1;
              this.push16(this.getReg16AF(p));
              this.tStates += 3;
            } else {
              switch (p) {
                case 0: {
                  // CALL nn: 17T, writes@T+11,T+14. Auto: 4T M1 + 6T fetch16 = 10T
                  const addr = this.fetch16();
                  this.tStates += 1;
                  this.push16(this.pc);
                  this.memptr = this.pc = addr;  // CALL: MEMPTR = PC = target
                  this.tStates += 3;
                  break;
                }
                case 1:
                  this.executeDD();
                  break;
                case 2:
                  this.executeED();
                  break;
                case 3:
                  this.executeFD();
                  break;
              }
            }
            break;

          case 6: {
            // ALU A,n: 7T. Auto: 4T M1 + 3T operand = 7T
            const val = this.fetch8();
            this.aluOp(y, val);
            break;
          }

          case 7:
            // RST: 11T, writes@T+5,T+8. Auto: 4T M1
            this.tStates += 1;
            this.push16(this.pc);
            this.pc = y * 8;
            this.tStates += 3;
            break;
        }
        break;
    }
  }

  aluOp(op: number, val: number): void {
    switch (op) {
      case 0: this.a = this.add8(this.a, val); break;
      case 1: this.a = this.adc8(this.a, val); break;
      case 2: this.a = this.sub8(this.a, val); break;
      case 3: this.a = this.sbc8(this.a, val); break;
      case 4: this.and8(val); break;
      case 5: this.xor8(val); break;
      case 6: this.or8(val); break;
      case 7: this.cp8(val); break;
    }
  }

  executeCB(): void {
    const op = this.fetch8();      // +3T (M1 read)
    this.tStates += 1;             // +1T (M1 refresh)
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    const isMem = z === 6;
    let val: number;
    if (isMem) {
      // CB (HL): read@T+8. Auto: 4T(main M1) + 4T(CB M1) = 8T
      val = this.read8(this.hl);
    } else {
      val = this.getReg8(z);
    }

    switch (x) {
      case 0:
        switch (y) {
          case 0: val = this.rlc(val); break;
          case 1: val = this.rrc(val); break;
          case 2: val = this.rl(val); break;
          case 3: val = this.rr(val); break;
          case 4: val = this.sla(val); break;
          case 5: val = this.sra(val); break;
          case 6: val = this.sll(val); break;
          case 7: val = this.srl(val); break;
        }
        if (isMem) {
          // CB shift/rotate (HL): 15T, write@T+12. Auto: 8T
          this.tStates += 4;
          this.write8(this.hl, val);
          this.tStates += 3;
        } else {
          // CB shift/rotate r: 8T (auto-counted)
          this.setReg8(z, val);
        }
        break;

      case 1:
        if (isMem) {
          // BIT n,(HL): 12T. Auto: 8T
          // Undocumented flags come from MEMPTR high byte, not the value
          const r = val & (1 << y);
          const memptrH = (this.memptr >> 8) & 0xFF;
          this.f = (this.f & 0x01) |         // Preserve C
                   0x10 |                     // Set H
                   (r ? 0 : 0x44) |           // Set Z and P/V if bit is 0
                   (r & 0x80) |               // Set S if testing bit 7 and it's set
                   (memptrH & 0x28);          // Copy bits 3,5 from MEMPTR high byte
          this.tStates += 4;
        } else {
          // BIT n,r: 8T (auto-counted)
          this.bit(y, val);
        }
        break;

      case 2:
        if (isMem) {
          // CB RES n,(HL): 15T, write@T+12. Auto: 8T
          val &= ~(1 << y);
          this.tStates += 4;
          this.write8(this.hl, val);
          this.tStates += 3;
        } else {
          // CB RES n,r: 8T (auto-counted)
          this.setReg8(z, val & ~(1 << y));
        }
        break;

      case 3:
        if (isMem) {
          // CB SET n,(HL): 15T, write@T+12. Auto: 8T
          val |= (1 << y);
          this.tStates += 4;
          this.write8(this.hl, val);
          this.tStates += 3;
        } else {
          // CB SET n,r: 8T (auto-counted)
          this.setReg8(z, val | (1 << y));
        }
        break;
    }
  }

  executeED(): void {
    const op = this.fetch8();      // +3T (M1 read)
    this.tStates += 1;             // +1T (M1 refresh)
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const p = (y >> 1) & 3;
    const q = y & 1;

    if (x === 1) {
      switch (z) {
        case 0: {
          // IN r,(C): 12T. Auto: 8T
          const val = this.portIn(this.bc);
          this.memptr = (this.bc + 1) & 0xFFFF;  // IN r,(C): MEMPTR = BC + 1
          if (y !== 6) {
            this.setReg8(y, val);
          }
          this.f = (this.f & 0x01) | SZP[val];
          this.tStates += 4;
          break;
        }

        case 1:
          // OUT (C),r: 12T. Auto: 8T
          this.portOut(this.bc, y === 6 ? 0 : this.getReg8(y));
          this.memptr = (this.bc + 1) & 0xFFFF;  // OUT (C),r: MEMPTR = BC + 1
          this.tStates += 4;
          break;

        case 2:
          // SBC/ADC HL,rr: 15T. Auto: 8T
          if (q === 0) {
            this.hl = this.sbc16(this.hl, this.getReg16(p));
          } else {
            this.hl = this.adc16(this.hl, this.getReg16(p));
          }
          this.tStates += 7;
          break;

        case 3: {
          // ED LD (nn),rr / LD rr,(nn): 20T. Auto: 8T + 6T fetch16 = 14T
          const addr = this.fetch16();
          this.memptr = (addr + 1) & 0xFFFF;  // LD rp,(addr) / LD (addr),rp: MEMPTR = addr + 1
          if (q === 0) {
            // ED LD (nn),rr: writes@T+14,T+17
            this.write16(addr, this.getReg16(p));
            this.tStates += 3;
          } else {
            // ED LD rr,(nn): reads@T+14,T+17
            this.setReg16(p, this.read16(addr));
            this.tStates += 3;
          }
          break;
        }

        case 4: {
          // NEG: 8T (auto-counted)
          const old = this.a;
          this.a = this.sub8(0, old);
          break;
        }

        case 5:
          // RETI/RETN: 14T, reads@T+8,T+11. Auto: 8T
          this.memptr = this.pc = this.pop16();  // RETI/RETN: MEMPTR = PC = target
          this.iff1 = this.iff2;  // Restore interrupt state
          this.tStates += 3;
          break;

        case 6:
          // IM n: 8T (auto-counted)
          switch (y & 3) {
            case 0: case 1: this.im = 0; break;
            case 2: this.im = 1; break;
            case 3: this.im = 2; break;
          }
          break;

        case 7:
          switch (y) {
            case 0:
              // LD I,A: 9T. Auto: 8T
              this.i = this.a;
              this.tStates += 1;
              break;
            case 1:
              // LD R,A: 9T. Auto: 8T
              // All 8 bits of A are copied to R (including bit 7)
              this.r = this.a;
              this.tStates += 1;
              break;
            case 2:
              // LD A,I: 9T. Auto: 8T
              this.a = this.i;
              this.f = (this.f & 0x01) | SZ[this.a] | (this.iff2 ? 0x04 : 0);
              this.tStates += 1;
              break;
            case 3:
              // LD A,R: 9T. Auto: 8T
              this.a = this.r;
              this.f = (this.f & 0x01) | SZ[this.a] | (this.iff2 ? 0x04 : 0);
              this.tStates += 1;
              break;
            case 4: {
              // RRD: 18T, read@T+8, write@T+15. Auto: 8T
              const hlVal = this.read8(this.hl);
              const newHL = ((this.a & 0x0F) << 4) | (hlVal >> 4);
              this.a = (this.a & 0xF0) | (hlVal & 0x0F);
              this.f = (this.f & 0x01) | SZP[this.a];
              this.memptr = (this.hl + 1) & 0xFFFF;  // RRD: MEMPTR = HL + 1
              this.tStates += 7;
              this.write8(this.hl, newHL);
              this.tStates += 3;
              break;
            }
            case 5: {
              // RLD: 18T, read@T+8, write@T+15. Auto: 8T
              const hlVal = this.read8(this.hl);
              const newHL = ((hlVal << 4) | (this.a & 0x0F)) & 0xFF;
              this.a = (this.a & 0xF0) | (hlVal >> 4);
              this.f = (this.f & 0x01) | SZP[this.a];
              this.memptr = (this.hl + 1) & 0xFFFF;  // RLD: MEMPTR = HL + 1
              this.tStates += 7;
              this.write8(this.hl, newHL);
              this.tStates += 3;
              break;
            }
            default:
              // ED NOP: 8T (auto-counted)
              break;
          }
          break;
      }
    } else if (x === 2 && y >= 4) {
      switch (z) {
        case 0: {
          // LDI/LDD/LDIR/LDDR: read@T+8, write@T+11. Auto: 8T
          const val = this.read8(this.hl);
          this.tStates += 3;
          this.write8(this.de, val);
          const n = (val + this.a) & 0xFF;
          this.f = (this.f & 0xC1) | (n & 0x08) | ((n << 4) & 0x20);

          if (y === 4) {
            this.hl = (this.hl + 1) & 0xFFFF;
            this.de = (this.de + 1) & 0xFFFF;
          } else if (y === 5) {
            this.hl = (this.hl - 1) & 0xFFFF;
            this.de = (this.de - 1) & 0xFFFF;
          } else if (y === 6) {
            this.hl = (this.hl + 1) & 0xFFFF;
            this.de = (this.de + 1) & 0xFFFF;
          } else {
            this.hl = (this.hl - 1) & 0xFFFF;
            this.de = (this.de - 1) & 0xFFFF;
          }

          this.bc = (this.bc - 1) & 0xFFFF;
          if (this.bc !== 0) this.f |= 0x04;

          if ((y === 6 || y === 7) && this.bc !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            this.memptr = (this.pc + 1) & 0xFFFF;  // MEMPTR = PC + 1 during iteration
            this.tStates += 10;  // LDIR/LDDR: 21T total
          } else {
            this.tStates += 5;   // LDI/LDD: 16T total
          }
          break;
        }

        case 1: {
          // CPI/CPD/CPIR/CPDR: read@T+8. Auto: 8T
          const val = this.read8(this.hl);
          const result = (this.a - val) & 0xFF;
          const h = ((this.a ^ val ^ result) & 0x10);
          const n = result - (h ? 1 : 0);

          if (y === 4 || y === 6) {
            this.hl = (this.hl + 1) & 0xFFFF;
            this.memptr = (this.memptr + 1) & 0xFFFF;  // CPI/CPIR: MEMPTR = MEMPTR + 1
          } else {
            this.hl = (this.hl - 1) & 0xFFFF;
            this.memptr = (this.memptr - 1) & 0xFFFF;  // CPD/CPDR: MEMPTR = MEMPTR - 1
          }

          this.bc = (this.bc - 1) & 0xFFFF;

          this.f = (this.f & 0x01) |
                   (result & 0x80) |
                   (result === 0 ? 0x40 : 0) |
                   h |
                   0x02 |
                   (this.bc !== 0 ? 0x04 : 0) |
                   (n & 0x08) | ((n << 4) & 0x20);

          if ((y === 6 || y === 7) && this.bc !== 0 && result !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            this.memptr = (this.pc + 1) & 0xFFFF;  // CPIR/CPDR repeating: MEMPTR = PC + 1
            this.tStates += 13;  // CPIR/CPDR: 21T total (8+13)
          } else {
            this.tStates += 8;   // CPI/CPD: 16T total (8+8)
          }
          break;
        }

        case 2: {
          // INI/IND/INIR/INDR: I/O@T+9, write@T+13. Auto: 8T
          const bcBeforeDec = this.bc;
          const val = this.portIn(this.bc);
          this.tStates += 5;
          this.write8(this.hl, val);
          this.b = (this.b - 1) & 0xFF;

          // INI/IND: MEMPTR = BC_before_decrementing_B ± 1
          if (y === 4 || y === 6) {
            this.memptr = (bcBeforeDec + 1) & 0xFFFF;  // INI/INIR
          } else {
            this.memptr = (bcBeforeDec - 1) & 0xFFFF;  // IND/INDR
          }

          // Documented flag formula (verified against FUSE emulator)
          const t = (y === 4 || y === 6)
            ? (val + ((this.c + 1) & 0xFF)) & 0x1FF  // INI/INIR
            : (val + ((this.c - 1) & 0xFF)) & 0x1FF; // IND/INDR
          const c = t > 0xFF ? 1 : 0;
          const h = c;
          const pv_temp = ((t & 0x07) ^ this.b) & 0xFF;
          let parity = pv_temp;
          parity ^= parity >> 4;
          parity ^= parity >> 2;
          parity ^= parity >> 1;
          const pv = (parity & 1) ? 0 : 0x04;

          this.f = (this.b & 0xA8) |              // S, Y, X from B after decrement
                   (this.b === 0 ? 0x40 : 0) |    // Z
                   (h << 4) |                      // H
                   pv |                            // P/V
                   ((val >> 6) & 0x02) |          // N = bit 7 of I/O value
                   c;                              // C

          if (y === 4 || y === 6) {
            this.hl = (this.hl + 1) & 0xFFFF;
          } else {
            this.hl = (this.hl - 1) & 0xFFFF;
          }

          if ((y === 6 || y === 7) && this.b !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            this.memptr = this.pc + 1;  // During repeat: MEMPTR = PC + 1
            this.tStates += 8;   // INIR/INDR: 21T total (13+8)
          } else {
            this.tStates += 3;   // INI/IND: 16T total (13+3)
          }
          break;
        }

        case 3: {
          // OUTI/OUTD/OTIR/OTDR: read@T+9. Auto: 8T
          this.tStates += 1;
          const val = this.read8(this.hl);

          // Modify HL first (C code uses HL++ or HL-- in the READ itself)
          if (y === 4 || y === 6) {
            this.hl = (this.hl + 1) & 0xFFFF;  // OUTI/OTIR
          } else {
            this.hl = (this.hl - 1) & 0xFFFF;  // OUTD/OTDR
          }

          this.b = (this.b - 1) & 0xFF;
          this.portOut(this.bc, val);

          // OUTI/OUTD: MEMPTR = BC_after_decrementing_B ± 1
          if (y === 4 || y === 6) {
            this.memptr = (this.bc + 1) & 0xFFFF;  // OUTI/OTIR
          } else {
            this.memptr = (this.bc - 1) & 0xFFFF;  // OUTD/OTDR
          }

          // Compute t using L AFTER HL modification (C code: t = io + L after HL++)
          const t = (val + this.l) & 0x1FF;
          const c = t > 0xFF ? 1 : 0;
          const h = c;
          const pv_temp = ((t & 0x07) ^ this.b) & 0xFF;
          let parity = pv_temp;
          parity ^= parity >> 4;
          parity ^= parity >> 2;
          parity ^= parity >> 1;
          const pv = (parity & 1) ? 0 : 0x04;

          this.f = (this.b & 0xA8) |              // S, Y, X from B after decrement
                   (this.b === 0 ? 0x40 : 0) |    // Z
                   (h << 4) |                      // H
                   pv |                            // P/V
                   ((val >> 6) & 0x02) |          // N = bit 7 of I/O value
                   c;                              // C

          if ((y === 6 || y === 7) && this.b !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            this.memptr = this.pc + 1;  // During repeat: MEMPTR = PC + 1
            this.tStates += 12;  // OTIR/OTDR: 21T total (9+12)
          } else {
            this.tStates += 7;   // OUTI/OUTD: 16T total (9+7)
          }
          break;
        }

        default:
          // ED block default: 8T (auto-counted)
          break;
      }
    } else if (op === 0x00 && this.trapHandler) {
      // ED 00: trap instruction — calls handler with address of the ED byte
      this.trapHandler((this.pc - 2) & 0xFFFF);
      // 8T (auto-counted)
    } else {
      // ED NOP: 8T (auto-counted)
    }
  }

  executeDD(): void {
    const op = this.fetch8();      // +3T (M1 read)
    this.tStates += 1;             // +1T (M1 refresh)
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    if (op === 0xCB) {
      this.executeDDCB();
      return;
    }

    if (op === 0xDD || op === 0xFD) {
      // DD DD/FD: 8T (4T DD M1 + 4T this M1, both auto-counted)
      this.pc = (this.pc - 1) & 0xFFFF;
      return;
    }

    const savedH = this.h;
    const savedL = this.l;
    this.h = (this.ix >> 8) & 0xFF;
    this.l = this.ix & 0xFF;

    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) {
      const d = this.fetch8();
      const addr = (this.ix + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;

      if (y === 6) {
        // LD (IX+d),r: 19T, write@T+15. Auto: 8T(DD+op M1) + 3T(d) = 11T
        const val = this.getReg8(z);
        this.tStates += 4;
        this.write8(addr, val);
        this.tStates += 4;
      } else {
        // LD r,(IX+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
        this.tStates += 5;
        this.setReg8(y, this.read8(addr));
        this.tStates += 3;
      }
    } else if (x === 2 && z === 6) {
      // ALU A,(IX+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
      const d = this.fetch8();
      const addr = (this.ix + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      this.tStates += 5;
      this.aluOp(y, this.read8(addr));
      this.tStates += 3;
    } else if (x === 0 && z === 6 && y !== 6) {
      if (op === 0x36) {
        // LD (IX+d),n: 19T, write@T+15. Auto: 8T + 3T(d) + 3T(n) = 14T
        const d = this.fetch8();
        const n = this.fetch8();
        const addr = (this.ix + (d < 128 ? d : d - 256)) & 0xFFFF;
        this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
        this.h = savedH; this.l = savedL;
        this.tStates += 1;
        this.write8(addr, n);
        this.tStates += 4;
      } else if (op === 0x26 || op === 0x2E) {
        // Undocumented: LD IXH/IXL, nn: 11T. Auto: 8T + 3T(n) = 11T
        const n = this.fetch8();
        if (op === 0x26) {
          this.ix = (n << 8) | (this.ix & 0xFF);
        } else {
          this.ix = (this.ix & 0xFF00) | n;
        }
        this.h = savedH; this.l = savedL;
      } else {
        this.h = savedH; this.l = savedL;
        // DD prefix M1 already auto-counted
        this.executeMain(op);
      }
    } else if (x === 0 && (z === 4 || z === 5) && y === 6) {
      // INC/DEC (IX+d): 23T, read@T+16, write@T+20. Auto: 8T + 3T(d) = 11T
      const d = this.fetch8();
      const addr = (this.ix + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      this.tStates += 5;
      const val = this.read8(addr);
      this.tStates += 4;
      this.write8(addr, z === 4 ? this.inc8(val) : this.dec8(val));
      this.tStates += 3;
    } else if (op === 0x36) {
      // LD (IX+d),n: 19T, write@T+15 (duplicate guard). Auto: 8T + 3T(d) + 3T(n) = 14T
      const d = this.fetch8();
      const n = this.fetch8();
      const addr = (this.ix + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      this.tStates += 1;
      this.write8(addr, n);
      this.tStates += 4;
    } else if (ddfdUsesHL(op)) {
      // DD prefix M1 already auto-counted
      this.executeMain(op);
      this.ix = (this.h << 8) | this.l;
      this.h = savedH;
      this.l = savedL;
      return;
    } else {
      // Opcode doesn't reference H/L/HL — DD prefix auto-counted
      this.h = savedH;
      this.l = savedL;
      this.executeMain(op);
      return;
    }
  }

  executeFD(): void {
    const op = this.fetch8();      // +3T (M1 read)
    this.tStates += 1;             // +1T (M1 refresh)
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    if (op === 0xCB) {
      this.executeFDCB();
      return;
    }

    if (op === 0xDD || op === 0xFD) {
      // FD DD/FD: 8T (4T FD M1 + 4T this M1, both auto-counted)
      this.pc = (this.pc - 1) & 0xFFFF;
      return;
    }

    const savedH = this.h;
    const savedL = this.l;
    this.h = (this.iy >> 8) & 0xFF;
    this.l = this.iy & 0xFF;

    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) {
      const d = this.fetch8();
      const addr = (this.iy + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      if (y === 6) {
        // LD (IY+d),r: 19T, write@T+15. Auto: 8T + 3T(d) = 11T
        const val = this.getReg8(z);
        this.tStates += 4;
        this.write8(addr, val);
        this.tStates += 4;
      } else {
        // LD r,(IY+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
        this.tStates += 5;
        this.setReg8(y, this.read8(addr));
        this.tStates += 3;
      }
    } else if (x === 2 && z === 6) {
      // ALU A,(IY+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
      const d = this.fetch8();
      const addr = (this.iy + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      this.tStates += 5;
      this.aluOp(y, this.read8(addr));
      this.tStates += 3;
    } else if (x === 0 && z === 6 && y !== 6) {
      if (op === 0x36) {
        // LD (IY+d),n: 19T, write@T+15. Auto: 8T + 3T(d) + 3T(n) = 14T
        const d = this.fetch8();
        const n = this.fetch8();
        const addr = (this.iy + (d < 128 ? d : d - 256)) & 0xFFFF;
        this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
        this.h = savedH; this.l = savedL;
        this.tStates += 1;
        this.write8(addr, n);
        this.tStates += 4;
      } else if (op === 0x26 || op === 0x2E) {
        // Undocumented: LD IYH/IYL, nn: 11T. Auto: 8T + 3T(n) = 11T
        const n = this.fetch8();
        if (op === 0x26) {
          this.iy = (n << 8) | (this.iy & 0xFF);
        } else {
          this.iy = (this.iy & 0xFF00) | n;
        }
        this.h = savedH; this.l = savedL;
      } else {
        this.h = savedH; this.l = savedL;
        // FD prefix M1 already auto-counted
        this.executeMain(op);
      }
    } else if (x === 0 && (z === 4 || z === 5) && y === 6) {
      // INC/DEC (IY+d): 23T, read@T+16, write@T+20. Auto: 8T + 3T(d) = 11T
      const d = this.fetch8();
      const addr = (this.iy + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      this.tStates += 5;
      const val = this.read8(addr);
      this.tStates += 4;
      this.write8(addr, z === 4 ? this.inc8(val) : this.dec8(val));
      this.tStates += 3;
    } else if (op === 0x36) {
      // LD (IY+d),n: 19T, write@T+15 (duplicate guard). Auto: 8T + 3T(d) + 3T(n) = 14T
      const d = this.fetch8();
      const n = this.fetch8();
      const addr = (this.iy + (d < 128 ? d : d - 256)) & 0xFFFF;
      this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
      this.h = savedH; this.l = savedL;
      this.tStates += 1;
      this.write8(addr, n);
      this.tStates += 4;
    } else if (ddfdUsesHL(op)) {
      // FD prefix M1 already auto-counted
      this.executeMain(op);
      this.iy = (this.h << 8) | this.l;
      this.h = savedH;
      this.l = savedL;
      return;
    } else {
      // Opcode doesn't reference H/L/HL — FD prefix auto-counted
      this.h = savedH;
      this.l = savedL;
      this.executeMain(op);
      return;
    }
  }

  executeDDCB(): void {
    const d = this.fetch8();
    const addr = (this.ix + (d < 128 ? d : d - 256)) & 0xFFFF;
    const op = this.fetch8();
    this._executeIndexCB(addr, op);
  }

  executeFDCB(): void {
    const d = this.fetch8();
    const addr = (this.iy + (d < 128 ? d : d - 256)) & 0xFFFF;
    const op = this.fetch8();
    this._executeIndexCB(addr, op);
  }

  _executeIndexCB(addr: number, op: number): void {
    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.memptr = addr;

    // DDCB/FDCB: read@T+16, write@T+20 (23T), BIT: read@T+16 (20T)
    // Auto: 4T(DD/FD M1) + 4T(CB M1) + 3T(d) + 3T(op) = 14T; +2T extra wait on op byte
    this.tStates += 2;
    let val = this.read8(addr);

    switch (x) {
      case 0:
        switch (y) {
          case 0: val = this.rlc(val); break;
          case 1: val = this.rrc(val); break;
          case 2: val = this.rl(val); break;
          case 3: val = this.rr(val); break;
          case 4: val = this.sla(val); break;
          case 5: val = this.sra(val); break;
          case 6: val = this.sll(val); break;
          case 7: val = this.srl(val); break;
        }
        this.tStates += 4;
        this.write8(addr, val);
        if (z !== 6) this.setReg8(z, val);
        this.tStates += 3;
        break;

      case 1:
        this.bit(y, val);
        // BIT n,(IX+d) / BIT n,(IY+d): undocumented flags from MEMPTR high byte
        this.f = (this.f & ~0x28) | ((this.memptr >> 8) & 0x28);
        this.tStates += 4;
        break;

      case 2:
        val &= ~(1 << y);
        this.tStates += 4;
        this.write8(addr, val);
        if (z !== 6) this.setReg8(z, val);
        this.tStates += 3;
        break;

      case 3:
        val |= (1 << y);
        this.tStates += 4;
        this.write8(addr, val);
        if (z !== 6) this.setReg8(z, val);
        this.tStates += 3;
        break;
    }
  }
}
