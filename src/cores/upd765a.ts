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
      case Phase.Execution: return 0x30; // EXM + CB (non-DMA would add RQM)
      case Phase.Result:    return 0xD0; // RQM + DIO + CB
    }
  }

  // ── Data Register (port 0x3FFD) ────────────────────────────────────

  /** Read data register — returns next result byte. */
  readData(): number {
    if (this.phase !== Phase.Result) return 0xFF;
    const val = this.resBuf[this.resPos++];
    if (this.resPos >= this.resBuf.length) this.phase = Phase.Idle;
    return val;
  }

  /** Write data register — feeds command/parameter bytes. */
  writeData(val: number): void {
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
    // ST3: no ready signal, track 0 if pcn==0, two-side=1
    let st3 = unit | (head << 2) | 0x08; // bit 3 = two-side
    if (this.pcn[unit] === 0) st3 |= 0x10; // Track 0
    // bit 5 (ready) stays 0 — drive not ready (no disk)
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

  /**
   * Read Data / Write Data / Read Deleted / Write Deleted / Scan.
   * No disk → abnormal termination + missing address mark.
   */
  private cmdReadWrite(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const c = this.cmdBuf[2], h = this.cmdBuf[3];
    const r = this.cmdBuf[4], n = this.cmdBuf[5];
    const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
    this.result([st0, 0x01, 0x00, c, h, r, n]); // ST1=MA, ST2=0
  }

  /** Read ID — no disk → same error. */
  private cmdReadID(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
    this.result([st0, 0x01, 0x00, 0, 0, 0, 0]);
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
  }
}
