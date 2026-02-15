/**
 * uPD765A Floppy Disk Controller emulation.
 *
 * Used in the ZX Spectrum +3/+2A. Two I/O ports:
 *   0x2FFD (read):  Main Status Register
 *   0x3FFD (r/w):   Data Register (command params in, result bytes out)
 *
 * Implements the full command set. Without a loaded disk image,
 * seek/recalibrate succeed but read/write/format return "not ready."
 */

import type { DskImage, DskTrack } from '@/plus3/dsk.ts';

// ── Command codes (lower 5 bits of command byte) ────────────────────────

const CMD_SPECIFY       = 0x03;
const CMD_SENSE_DRIVE   = 0x04;
const CMD_WRITE_DATA    = 0x05;
const CMD_READ_DATA     = 0x06;
const CMD_RECALIBRATE   = 0x07;
const CMD_SENSE_INT     = 0x08;
const CMD_WRITE_DELETED = 0x09;
const CMD_READ_ID       = 0x0A;
const CMD_READ_DELETED  = 0x0C;
const CMD_FORMAT_TRACK  = 0x0D;
const CMD_SEEK          = 0x0F;
const CMD_VERSION       = 0x10;
const CMD_SCAN_EQUAL    = 0x11;
const CMD_SCAN_LOW_EQ   = 0x19;
const CMD_SCAN_HIGH_EQ  = 0x1D;

// ── Status Register 0 bit masks ─────────────────────────────────────────

/** Interrupt code: abnormal termination */
const ST0_ABNORMAL = 0x40;
/** Interrupt code: invalid command */
const ST0_INVALID  = 0x80;
/** Seek completed */
const ST0_SEEK_END = 0x20;
/** Drive not ready */
const ST0_NOT_READY = 0x08;

// ── Phase enum ──────────────────────────────────────────────────────────

const enum Phase { Idle, Command, Execution, Result }

// ── Parameter counts per command (bytes after command byte) ─────────────

function paramCount(cmdByte: number): number {
  switch (cmdByte & 0x1F) {
    case CMD_READ_DATA: case CMD_READ_DELETED:
    case CMD_WRITE_DATA: case CMD_WRITE_DELETED:
    case CMD_SCAN_EQUAL: case CMD_SCAN_LOW_EQ: case CMD_SCAN_HIGH_EQ:
      return 8;
    case CMD_FORMAT_TRACK:
      return 5;
    case CMD_READ_ID: case CMD_RECALIBRATE: case CMD_SENSE_DRIVE:
      return 1;
    case CMD_SPECIFY: case CMD_SEEK:
      return 2;
    case CMD_SENSE_INT: case CMD_VERSION:
      return 0;
    default:
      return 0; // invalid — execute immediately
  }
}

export class UPD765A {
  // ── Phase & buffers ─────────────────────────────────────────────────

  private phase = Phase.Idle;
  private cmdBuf: number[] = [];
  private cmdExpected = 0;
  private resBuf: number[] = [];
  private resPos = 0;

  // ── Interrupt latch (consumed by Sense Interrupt Status) ────────────

  private intPending = false;
  private intST0 = 0;
  private intPCN = 0;

  // ── Per-drive state ─────────────────────────────────────────────────

  private pcn = [0, 0, 0, 0]; // Present Cylinder Number

  // Specify parameters are accepted and discarded (mechanical timing).

  /** Motor on/off — set externally via port 0x1FFD bit 3 */
  motorOn = false;

  // ── Disk image ─────────────────────────────────────────────────────

  private disks: (DskImage | null)[] = [null, null, null, null];

  /** Per-drive Read ID cycling index */
  private idIndex = [0, 0, 0, 0];

  // ── Latched state for UI display (execution completes within one frame) ──

  private latchR = 0;
  private latchHead = 0;
  private latchWriting = false;
  /** Counts down each frame — shows last op briefly after execution ends */
  private latchFrames = 0;

  // ── Execution phase state ──────────────────────────────────────────

  private exBuf: Uint8Array = new Uint8Array(0);
  private exPos = 0;
  private exWriting = false;
  /** Current sector R value being read/written */
  private exR = 0;
  /** End-of-track R value */
  private exEOT = 0;
  /** Command parameters preserved for multi-sector and result phase */
  private exUnit = 0;
  private exHead = 0;
  private exC = 0;
  private exH = 0;
  private exN = 0;
  /** Reference to current track for write-back */
  private exTrack: DskTrack | null = null;

  // ── Public API ─────────────────────────────────────────────────────

  /** Expose disk image for BIOS trap handler (drive A: only for compatibility). */
  get diskImage(): DskImage | null { return this.disks[0]; }

  /** Get disk image for a specific drive unit. */
  getDiskImage(unit: number): DskImage | null {
    return this.disks[unit & 3];
  }

  /** Set the Present Cylinder Number for a drive (used by BIOS trap seek). */
  setTrack(unit: number, cyl: number): void { this.pcn[unit & 3] = cyl; }

  /** Latch sector access info for UI display (used by BIOS trap read/write). */
  latchAccess(r: number, head: number, writing: boolean): void {
    this.latchR = r;
    this.latchHead = head;
    this.latchWriting = writing;
    this.latchFrames = 25;
  }

  insertDisk(image: DskImage, unit: number = 0): void {
    this.disks[unit & 3] = image;
    this.idIndex[unit & 3] = 0;
  }

  ejectDisk(unit: number = 0): void {
    this.disks[unit & 3] = null;
  }

  // ── State getters (for UI) ──────────────────────────────────────────

  get currentUnit(): number { return this.exUnit; }

  get currentTrack(): number { return this.pcn[this.exUnit]; }

  get currentSector(): number {
    if (this.phase === Phase.Execution) return this.exR;
    return this.latchFrames > 0 ? this.latchR : 0;
  }

  get currentHead(): number {
    if (this.phase === Phase.Execution) return this.exHead;
    return this.latchFrames > 0 ? this.latchHead : 0;
  }

  get isExecuting(): boolean {
    return this.phase === Phase.Execution || this.latchFrames > 0;
  }

  get isWriting(): boolean {
    if (this.phase === Phase.Execution) return this.exWriting;
    return this.latchFrames > 0 ? this.latchWriting : false;
  }

  /** Call once per frame to decay the latched display state. */
  tickFrame(): void {
    if (this.latchFrames > 0) this.latchFrames--;
  }

  // ── Main Status Register (port 0x2FFD read) ────────────────────────

  /**
   * MSR bits:
   *   7  RQM   — 1 = data register ready for CPU access
   *   6  DIO   — 0 = CPU→FDC (write), 1 = FDC→CPU (read)
   *   5  EXM   — 1 = execution phase in progress
   *   4  CB    — 1 = command in progress
   *  3-0 D0–D3 — individual drive seek-in-progress flags
   */
  readStatus(): number {
    switch (this.phase) {
      case Phase.Idle:      return 0x80; // RQM
      case Phase.Command:   return 0x90; // RQM + CB
      case Phase.Execution:
        // RQM + EXM + CB, DIO depends on read vs write
        return this.exWriting ? 0xB0 : 0xF0; // write: RQM+EXM+CB, read: RQM+DIO+EXM+CB
      case Phase.Result:    return 0xD0; // RQM + DIO + CB
    }
  }

  // ── Data Register (port 0x3FFD) ────────────────────────────────────

  /** Read data register — returns next result byte or execution data. */
  readData(): number {
    if (this.phase === Phase.Execution && !this.exWriting) {
      return this.readExecution();
    }
    if (this.phase !== Phase.Result) return 0xFF;
    const val = this.resBuf[this.resPos++];
    if (this.resPos >= this.resBuf.length) this.phase = Phase.Idle;
    return val;
  }

  /** Write data register — feeds command/parameter bytes or execution data. */
  writeData(val: number): void {
    if (this.phase === Phase.Execution && this.exWriting) {
      this.writeExecution(val);
      return;
    }
    if (this.phase === Phase.Result || this.phase === Phase.Execution) return;

    if (this.phase === Phase.Idle) {
      this.cmdBuf = [val];
      this.cmdExpected = paramCount(val);
      if (this.cmdExpected === 0) {
        this.exec();
      } else {
        this.phase = Phase.Command;
      }
    } else {
      this.cmdBuf.push(val);
      if (this.cmdBuf.length > this.cmdExpected) this.exec();
    }
  }

  // ── Execution phase data transfer ─────────────────────────────────

  private readExecution(): number {
    if (this.exPos >= this.exBuf.length) return 0xFF;
    const val = this.exBuf[this.exPos++];
    if (this.exPos >= this.exBuf.length) {
      // Current sector exhausted — try next sector
      if (!this.advanceSector()) {
        this.finishExecution();
      }
    }
    return val;
  }

  private writeExecution(val: number): void {
    if (this.exPos >= this.exBuf.length) return;
    this.exBuf[this.exPos++] = val;
    if (this.exPos >= this.exBuf.length) {
      // Write buffer back to disk image
      this.writeBackSector();
      if (!this.advanceSector()) {
        this.finishExecution();
      }
    }
  }

  /** Try to advance to the next sector (R+1). Returns false if at EOT. */
  private advanceSector(): boolean {
    this.exR++;
    if (this.exR > this.exEOT) return false;

    const track = this.exTrack;
    if (!track) return false;

    const idx = track.sectorMap.get(this.exR);
    if (idx === undefined) return false;

    const sector = track.sectors[idx];
    if (this.exWriting) {
      this.exBuf = new Uint8Array(sector.data.length);
      this.exPos = 0;
    } else {
      this.exBuf = sector.data;
      this.exPos = 0;
    }
    return true;
  }

  /** Write the execution buffer back into the current sector's data. */
  private writeBackSector(): void {
    const track = this.exTrack;
    if (!track) return;
    const idx = track.sectorMap.get(this.exR);
    if (idx === undefined) return;
    track.sectors[idx].data.set(this.exBuf);
  }

  /** End execution phase with success result. */
  private finishExecution(): void {
    const st0 = (this.exHead << 2) | this.exUnit;
    this.result([st0, 0x00, 0x00, this.exC, this.exH, this.exR, this.exN]);
  }

  // ── Command dispatch ───────────────────────────────────────────────

  private exec(): void {
    switch (this.cmdBuf[0] & 0x1F) {
      case CMD_SPECIFY:       this.cmdSpecify(); break;
      case CMD_SENSE_DRIVE:   this.cmdSenseDrive(); break;
      case CMD_SENSE_INT:     this.cmdSenseInt(); break;
      case CMD_RECALIBRATE:   this.cmdRecalibrate(); break;
      case CMD_SEEK:          this.cmdSeek(); break;
      case CMD_READ_DATA:     // fall through
      case CMD_READ_DELETED:  this.cmdReadWrite(); break;
      case CMD_WRITE_DATA:    // fall through
      case CMD_WRITE_DELETED: this.cmdReadWrite(); break;
      case CMD_READ_ID:       this.cmdReadID(); break;
      case CMD_FORMAT_TRACK:  this.cmdFormat(); break;
      case CMD_SCAN_EQUAL:    // fall through
      case CMD_SCAN_LOW_EQ:   // fall through
      case CMD_SCAN_HIGH_EQ:  this.cmdReadWrite(); break;
      case CMD_VERSION:       this.cmdVersion(); break;
      default:                this.cmdInvalid(); break;
    }
  }

  // ── Command implementations ────────────────────────────────────────

  /** Specify — set mechanical timing. No result phase. */
  private cmdSpecify(): void {
    // Parameters accepted and discarded — we don't model mechanical timing
    this.phase = Phase.Idle;
  }

  /** Sense Drive Status — report ST3. */
  private cmdSenseDrive(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    // ST3: track 0 if pcn==0, two-side=1
    let st3 = unit | (head << 2) | 0x08; // bit 3 = two-side
    if (this.pcn[unit] === 0) st3 |= 0x10; // Track 0
    if (this.disks[unit]) st3 |= 0x20; // bit 5 = ready
    this.result([st3]);
  }

  /** Sense Interrupt Status — return latched interrupt info. */
  private cmdSenseInt(): void {
    if (this.intPending) {
      this.intPending = false;
      this.result([this.intST0, this.intPCN]);
    } else {
      this.result([ST0_INVALID]);
    }
  }

  /** Recalibrate — seek to track 0. Generates interrupt. */
  private cmdRecalibrate(): void {
    const unit = this.cmdBuf[1] & 0x03;
    this.pcn[unit] = 0;
    this.intPending = true;
    this.intST0 = ST0_SEEK_END | unit;
    this.intPCN = 0;
    this.phase = Phase.Idle;
  }

  /** Seek — move to specified cylinder. Generates interrupt. */
  private cmdSeek(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const ncn = this.cmdBuf[2];
    this.pcn[unit] = ncn;
    this.intPending = true;
    this.intST0 = ST0_SEEK_END | unit;
    this.intPCN = ncn;
    this.phase = Phase.Idle;
  }

  /** Look up the track at the current head position. */
  private getTrack(unit: number, head: number): DskTrack | null {
    const disk = this.disks[unit];
    if (!disk) return null;
    const cyl = this.pcn[unit];
    if (cyl >= disk.numTracks) return null;
    if (head >= disk.numSides) return null;
    return disk.tracks[cyl][head];
  }

  /**
   * Read Data / Write Data / Read Deleted / Write Deleted / Scan.
   * No disk → abnormal termination + not ready.
   * With disk → enter execution phase for data transfer.
   */
  private cmdReadWrite(): void {
    const cmd = this.cmdBuf[0] & 0x1F;
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const c = this.cmdBuf[2], h = this.cmdBuf[3];
    const r = this.cmdBuf[4], n = this.cmdBuf[5];
    const eot = this.cmdBuf[6];

    const track = this.getTrack(unit, h);

    if (!track) {
      // No disk or no track — abnormal termination
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x01, 0x00, c, h, r, n]); // ST1=MA
      return;
    }

    // Find starting sector by R value
    const idx = track.sectorMap.get(r);
    if (idx === undefined) {
      // Sector not found — No Data
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x04, 0x00, c, h, r, n]); // ST1=ND (bit 2)
      return;
    }

    const sector = track.sectors[idx];
    const isWrite = cmd === CMD_WRITE_DATA || cmd === CMD_WRITE_DELETED;

    // Save execution state
    this.exUnit = unit;
    this.exHead = head;
    this.exC = c;
    this.exH = h;
    this.exN = n;
    this.exR = r;
    this.exEOT = eot;
    this.exTrack = track;
    this.exWriting = isWrite;

    // Latch for UI display (execution completes within one frame)
    this.latchR = r;
    this.latchHead = head;
    this.latchWriting = isWrite;
    this.latchFrames = 25; // ~0.5s at 50fps

    if (isWrite) {
      this.exBuf = new Uint8Array(sector.data.length);
      this.exPos = 0;
    } else {
      this.exBuf = sector.data;
      this.exPos = 0;
    }

    this.phase = Phase.Execution;
  }

  /** Read ID — return CHRN of current sector under the head. */
  private cmdReadID(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;

    const track = this.getTrack(unit, head);

    if (!track || track.sectors.length === 0) {
      // No disk or empty track
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x01, 0x00, 0, 0, 0, 0]);
      return;
    }

    // Cycle through sectors on repeated calls (ROM uses this to discover layout)
    const idx = this.idIndex[unit] % track.sectors.length;
    this.idIndex[unit] = idx + 1;
    const sector = track.sectors[idx];

    const st0 = (head << 2) | unit; // normal termination
    this.result([st0, 0x00, 0x00, sector.c, sector.h, sector.r, sector.n]);
  }

  /** Format Track — no disk → error. */
  private cmdFormat(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const n = this.cmdBuf[2];
    const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
    this.result([st0, 0x01, 0x00, 0, 0, 0, n]);
  }

  /** Version — 0x80 = enhanced controller (uPD765A compatible). */
  private cmdVersion(): void {
    this.result([0x80]);
  }

  /** Invalid/unrecognised command — return ST0 with invalid-command code. */
  private cmdInvalid(): void {
    this.result([ST0_INVALID]);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private result(bytes: number[]): void {
    this.resBuf = bytes;
    this.resPos = 0;
    this.phase = bytes.length > 0 ? Phase.Result : Phase.Idle;
  }

  reset(): void {
    this.phase = Phase.Idle;
    this.cmdBuf = [];
    this.cmdExpected = 0;
    this.resBuf = [];
    this.resPos = 0;
    this.intPending = false;
    this.intST0 = 0;
    this.intPCN = 0;
    this.pcn = [0, 0, 0, 0];
    this.motorOn = false;
    this.exBuf = new Uint8Array(0);
    this.exPos = 0;
    this.exWriting = false;
    this.exTrack = null;
    this.latchR = 0;
    this.latchHead = 0;
    this.latchWriting = false;
    this.latchFrames = 0;
    // Note: disk image and idIndex intentionally preserved across reset
  }
}
