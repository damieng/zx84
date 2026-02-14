/**
 * +3DOS BIOS trap handler.
 *
 * Intercepts +3DOS ROM subroutine calls and performs sector I/O directly
 * on the DskImage, bypassing the FDC. This gives instant, reliable disk
 * access for standard software that uses the +3DOS API.
 *
 * Trap addresses sourced from ZEsarUX plus3dos_handler.c — both jump table
 * entries and internal implementation addresses are trapped for maximum
 * compatibility.
 */

import { Z80 } from './cores/z80.ts';
import type { SpectrumMemory } from './memory.ts';
import type { UPD765A } from './cores/upd765a.ts';

/** Nominal T-state costs for trapped operations. */
const TSTATES_READ = 100;
const TSTATES_WRITE = 100;
const TSTATES_SEEK = 50;
const TSTATES_MISC = 20;

export class Plus3DosTrap {
  private cpu: Z80;
  private memory: SpectrumMemory;
  private fdc: UPD765A;

  /** Per-track Read ID cycling index (same idea as FDC idIndex). */
  private idIndex = [0, 0, 0, 0];

  /** Circular buffer of recent trap events for debug display. */
  private _trapLog: string[] = [];
  private static readonly MAX_LOG = 32;

  constructor(cpu: Z80, memory: SpectrumMemory, fdc: UPD765A) {
    this.cpu = cpu;
    this.memory = memory;
    this.fdc = fdc;
  }

  reset(): void {
    this.idIndex = [0, 0, 0, 0];
    this._trapLog = [];
  }

  get trapLog(): readonly string[] { return this._trapLog; }

  private log(name: string): void {
    if (this._trapLog.length >= Plus3DosTrap.MAX_LOG) this._trapLog.shift();
    this._trapLog.push(name);
  }

  /**
   * Check if the current PC is a trappable +3DOS address.
   * If so, perform the operation and return true (caller should skip step()).
   * Otherwise return false.
   */
  check(pc: number): boolean {
    switch (pc) {
      // DD_READ_SECTOR — jump table + internals
      case 0x0163:
      case 0x197C:
      case 0x1BFF:
        this.log(`READ_SECTOR T${(this.cpu.de >> 8) & 0xFF} S${this.cpu.de & 0xFF}`);
        return this.ddReadSector();

      // DD_WRITE_SECTOR — jump table + internals
      case 0x0166:
      case 0x1982:
      case 0x1C0D:
        this.log(`WRITE_SECTOR T${(this.cpu.de >> 8) & 0xFF} S${this.cpu.de & 0xFF}`);
        return this.ddWriteSector();

      // DD_READ_ID — jump table + internal
      case 0x016F:
      case 0x1C36:
        this.log('READ_ID');
        return this.ddReadID();

      // DD_L_SEEK — jump table + internal
      case 0x018D:
      case 0x1F76:
        this.log(`SEEK T${(this.cpu.de >> 8) & 0xFF}`);
        return this.ddSeek();

      // DD_L_ON_MOTOR — jump table + internal
      case 0x0196:
      case 0x212B:
        this.log('MOTOR_ON');
        return this.returnOK(TSTATES_MISC);

      // DD_TEST_UNSUITABLE — jump table + internal
      case 0x0172:
      case 0x1E65:
        this.log('TEST_UNSUITABLE');
        return this.returnOK(TSTATES_MISC);

      // DD_FORMAT — jump table + internal
      case 0x016C:
      case 0x1C24:
        this.log('FORMAT');
        return this.returnOK(TSTATES_MISC);

      // DD_L_OFF_MOTOR — internal
      case 0x2164:
        this.log('MOTOR_OFF');
        return this.returnOK(TSTATES_MISC);

      // Wait FD & Output — skip FDC I/O
      case 0x2114:
        return this.simpleReturn();

      // Wait FDC ready — skip FDC poll
      case 0x206F:
        return this.simpleReturn();

      default:
        // Log un-trapped +3DOS jump table calls (0x0100-0x01FF)
        if (pc >= 0x0100 && pc < 0x0200) {
          this.log(`UNTRAPPED 0x${pc.toString(16).padStart(4, '0')}`);
        }
        return false;
    }
  }

  // ── Sector operations ──────────────────────────────────────────────

  /**
   * DD_READ_SECTOR: Read a sector from disk into the buffer at HL.
   * Entry: B=page for C000-FFFF, C=unit, D=logical track, E=sector R, HL=buffer
   */
  private ddReadSector(): boolean {
    const cpu = this.cpu;
    const b = (cpu.bc >> 8) & 0xFF;    // page for C000-FFFF
    const unit = cpu.bc & 0x03;         // unit (C register, low 2 bits)
    const logTrack = (cpu.de >> 8) & 0xFF; // D = logical track
    const r = cpu.de & 0xFF;            // E = sector R value
    let hl = cpu.hl;

    const disk = this.fdc.diskImage;
    if (!disk) return this.returnError(0x08); // drive not ready

    // Map logical track → cylinder + head (DS disks interleave sides)
    const cylinder = disk.numSides > 1 ? Math.floor(logTrack / disk.numSides) : logTrack;
    const head = disk.numSides > 1 ? logTrack % disk.numSides : 0;

    if (cylinder >= disk.numTracks) return this.returnError(0x03); // seek fail
    const dskTrack = disk.tracks[cylinder]?.[head];
    if (!dskTrack) return this.returnError(0x03);

    const idx = dskTrack.sectorMap.get(r);
    if (idx === undefined) return this.returnError(0x04); // ST1 bit 2 = No Data

    const sector = dskTrack.sectors[idx];

    // Copy sector data to buffer using paged memory helpers
    for (let i = 0; i < sector.data.length; i++) {
      this.pagedWrite(hl, sector.data[i], b);
      hl = (hl + 1) & 0xFFFF;
    }

    // Update FDC UI state
    this.fdc.setTrack(unit, cylinder);
    this.fdc.latchAccess(r, head, false);

    cpu.hl = hl;
    cpu.tStates += TSTATES_READ;
    return this.returnOK(0);
  }

  /**
   * DD_WRITE_SECTOR: Write a sector from the buffer at HL to disk.
   * Entry: B=page for C000-FFFF, C=unit, D=logical track, E=sector R, HL=buffer
   */
  private ddWriteSector(): boolean {
    const cpu = this.cpu;
    const b = (cpu.bc >> 8) & 0xFF;
    const unit = cpu.bc & 0x03;
    const logTrack = (cpu.de >> 8) & 0xFF;
    const r = cpu.de & 0xFF;
    let hl = cpu.hl;

    const disk = this.fdc.diskImage;
    if (!disk) return this.returnError(0x08);

    // Map logical track → cylinder + head (DS disks interleave sides)
    const cylinder = disk.numSides > 1 ? Math.floor(logTrack / disk.numSides) : logTrack;
    const head = disk.numSides > 1 ? logTrack % disk.numSides : 0;

    if (cylinder >= disk.numTracks) return this.returnError(0x03);
    const dskTrack = disk.tracks[cylinder]?.[head];
    if (!dskTrack) return this.returnError(0x03);

    const idx = dskTrack.sectorMap.get(r);
    if (idx === undefined) return this.returnError(0x04);

    const sector = dskTrack.sectors[idx];

    // Copy from buffer to sector data using paged memory helpers
    for (let i = 0; i < sector.data.length; i++) {
      sector.data[i] = this.pagedRead(hl, b);
      hl = (hl + 1) & 0xFFFF;
    }

    // Update FDC UI state
    this.fdc.setTrack(unit, cylinder);
    this.fdc.latchAccess(r, head, true);

    cpu.hl = hl;
    cpu.tStates += TSTATES_WRITE;
    return this.returnOK(0);
  }

  /**
   * DD_READ_ID: Return CHRN of next sector on the current track.
   * Uses the FDC's current head position (set by prior DD_L_SEEK), not D register.
   * Writes CHRN to RAM page 7 at 0xC000, sets HL=0xC000, A=R value.
   */
  private ddReadID(): boolean {
    const cpu = this.cpu;
    const unit = cpu.bc & 0x03;

    const disk = this.fdc.diskImage;
    if (!disk) return this.returnError(0x08);

    // Use the FDC's current cylinder (set by prior seek), not D register
    const cylinder = this.fdc.currentTrack;
    const head = 0; // DD_READ_ID on +3 uses head 0
    if (cylinder >= disk.numTracks) return this.returnError(0x03);
    const dskTrack = disk.tracks[cylinder]?.[head];
    if (!dskTrack || dskTrack.sectors.length === 0) return this.returnError(0x04);

    // Cycle through sectors on repeated calls
    const idx = this.idIndex[unit] % dskTrack.sectors.length;
    this.idIndex[unit] = idx + 1;
    const sector = dskTrack.sectors[idx];

    // Write CHRN to RAM page 7 at 0xC000
    const page7 = this.memory.ramBanks[7];
    page7[0] = sector.c;
    page7[1] = sector.h;
    page7[2] = sector.r;
    page7[3] = sector.n;

    // Also update flat memory if bank 7 is currently paged at C000
    if (this.memory.currentBank === 7) {
      this.memory.flat[0xC000] = sector.c;
      this.memory.flat[0xC001] = sector.h;
      this.memory.flat[0xC002] = sector.r;
      this.memory.flat[0xC003] = sector.n;
    }

    cpu.hl = 0xC000;
    cpu.a = sector.r;

    // cylinder already set by prior seek — no need to update
    cpu.tStates += TSTATES_MISC;
    return this.returnOK(0);
  }

  /**
   * DD_L_SEEK: Seek to a logical track.
   * Entry: C=unit, D=logical track
   */
  private ddSeek(): boolean {
    const cpu = this.cpu;
    const unit = cpu.bc & 0x03;
    const logTrack = (cpu.de >> 8) & 0xFF;

    // Store physical cylinder so DD_READ_ID uses the correct track
    const disk = this.fdc.diskImage;
    const cylinder = (disk && disk.numSides > 1) ? Math.floor(logTrack / disk.numSides) : logTrack;
    this.fdc.setTrack(unit, cylinder);
    cpu.tStates += TSTATES_SEEK;
    return this.returnOK(0);
  }

  // ── Paged memory access ────────────────────────────────────────────

  /**
   * Write a byte to the buffer address using +3DOS page conventions.
   * B register specifies which RAM bank is at C000-FFFF.
   */
  private pagedWrite(addr: number, val: number, pageB: number): void {
    if (addr < 0x4000) {
      // ROM region — discard writes
      return;
    }

    let bank: number;
    if (addr >= 0xC000) {
      bank = pageB & 7;
    } else if (addr >= 0x8000) {
      bank = 2;
    } else {
      bank = 5;
    }

    // Write to the RAM bank
    this.memory.ramBanks[bank][addr & 0x3FFF] = val;

    // Also update flat memory if this bank is currently mapped at this address
    if (addr >= 0xC000) {
      if (bank === this.memory.currentBank) {
        this.memory.flat[addr] = val;
      }
    } else {
      // Banks 5 (0x4000) and 2 (0x8000) are always mapped
      this.memory.flat[addr] = val;
    }
  }

  /**
   * Read a byte from the buffer address using +3DOS page conventions.
   * B register specifies which RAM bank is at C000-FFFF.
   */
  private pagedRead(addr: number, pageB: number): number {
    if (addr < 0x4000) {
      // ROM region — read from flat (ROM data)
      return this.memory.flat[addr];
    }

    let bank: number;
    if (addr >= 0xC000) {
      bank = pageB & 7;
    } else if (addr >= 0x8000) {
      bank = 2;
    } else {
      bank = 5;
    }

    return this.memory.ramBanks[bank][addr & 0x3FFF];
  }

  // ── Return helpers ─────────────────────────────────────────────────

  /** Return with carry set (success). Pops return address. */
  private returnOK(extraTStates: number): boolean {
    const cpu = this.cpu;
    cpu.setFlag(Z80.FLAG_C, true);
    cpu.pc = cpu.pop16();
    cpu.tStates += extraTStates;
    return true;
  }

  /** Return with carry clear (error), A=error code. Pops return address. */
  private returnError(errCode: number): boolean {
    const cpu = this.cpu;
    cpu.a = errCode;
    cpu.setFlag(Z80.FLAG_C, false);
    cpu.pc = cpu.pop16();
    cpu.tStates += TSTATES_MISC;
    return true;
  }

  /** Simple return — just pop PC, no flag changes. */
  private simpleReturn(): boolean {
    this.cpu.pc = this.cpu.pop16();
    this.cpu.tStates += TSTATES_MISC;
    return true;
  }
}
