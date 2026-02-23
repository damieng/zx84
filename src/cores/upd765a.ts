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

import type { DskImage, DskSector, DskTrack } from '@/plus3/dsk.ts';

// ── Command codes (lower 5 bits of command byte) ────────────────────────

const CMD_READ_TRACK    = 0x02;
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
    case CMD_READ_TRACK:
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
  // ── Debug logging ───────────────────────────────────────────────────

  private enableLogging = true; // Set to false to disable FDC logging

  private log(...args: any[]): void {
    if (this.enableLogging) {
      console.log('[FDC]', ...args);
    }
  }

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

  /** Per-drive write-protect flag (software-controlled, like a physical tab) */
  writeProtect = [false, false, false, false];

  /**
   * Per-drive "force ready" flag.  When set, Sense Drive Status always
   * reports the drive as ready (ST3 bit 5 = 1) even with no disk inserted.
   * Used to keep the +3 ROM from remapping B: to a swap-A on boot.
   */
  forceReady = [false, false, false, false];

  /**
   * Set to the unit number (0/1) when FORMAT_TRACK finishes; cleared by the
   * UI layer after it refreshes disk metadata.  -1 = no pending refresh.
   */
  formattedUnit = -1;

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
  /** True if executing Read Track (read entire track, don't advance sectors) */
  private exReadTrack = false;
  /** Current sector R value being read/written */
  private exR = 0;
  /** End-of-track R value */
  private exEOT = 0;
  private exHitEOT = false;
  /** Command parameters preserved for multi-sector and result phase */
  private exUnit = 0;
  private exHead = 0;
  private exC = 0;
  private exH = 0;
  private exN = 0;
  /** Reference to current track for write-back */
  private exTrack: DskTrack | null = null;
  /** Status registers from sector (for CRC error reporting) */
  private exST1 = 0;
  private exST2 = 0;
  /**
   * True when the starting sector's C field doesn't match the physical cylinder.
   * These are copy-protection tracks — real hardware can't find sector R+1 after
   * reading R because disk rotation timing prevents it. Limit to one sector/command.
   */
  private exSingleSector = false;
  /**
   * Consecutive MSR reads while in execution phase without a data read.
   * The real uPD765A triggers OVERRUN (ST1 bit 4) when the CPU doesn't read
   * data fast enough. Protection code deliberately breaks the INI loop mid-sector
   * then polls MSR waiting for execution phase to end — overrun makes it end.
   * ~32 consecutive status polls without a data read is a safe threshold.
   */
  private exOverrunPolls = 0;
  private static readonly OVERRUN_THRESHOLD = 32;

  // ── Format-track execution state ────────────────────────────────────

  /** True when executing FORMAT_TRACK (CPU feeds sector IDs, not data) */
  private exFormatting = false;
  /** Sectors per cylinder received in FORMAT_TRACK command */
  private exSC = 0;
  /** Gap 3 length from FORMAT_TRACK command */
  private exGPL = 0;
  /** Filler byte from FORMAT_TRACK command */
  private exFiller = 0;

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
    this.log(`🎮 Disk inserted in unit ${unit}: ${image.numTracks} tracks, ${image.numSides} sides, ${image.format} format`);
    if (image.protection && image.protection !== 'None') {
      this.log(`   🔒 Copy protection detected: ${image.protection}`);
    }
    if (image.diskFormat) {
      this.log(`   📀 Disk format: ${image.diskFormat}`);
    }
  }

  ejectDisk(unit: number = 0): void {
    this.log(`📤 Disk ejected from unit ${unit}`);
    this.disks[unit & 3] = null;
  }

  // ── State getters (for UI) ──────────────────────────────────────────

  get currentUnit(): number { return this.exUnit; }

  get currentTrack(): number { return this.pcn[this.physUnit(this.exUnit)]; }

  getUnitTrack(unit: number): number { return this.pcn[this.physUnit(unit)]; }

  /**
   * Resolve logical drive unit to physical drive index.
   * On the +3 only 2 drive-select lines are wired: units 2/3 alias to 0/1.
   * This matches FUSE's specplus3.c: drive[2]=drive[0], drive[3]=drive[1].
   */
  private physUnit(unit: number): number { return unit & 1; }

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
      case Phase.Execution: {
        // Overrun detection: real uPD765A terminates execution phase (ST1.OR)
        // when the CPU stops reading data and only polls status instead.
        // Protection code intentionally breaks its INI loop mid-sector, then
        // polls MSR waiting for execution phase to end — overrun ends it.
        if (++this.exOverrunPolls >= UPD765A.OVERRUN_THRESHOLD) {
          this.exOverrunPolls = 0;
          this.exST1 |= 0x10; // ST1 bit 4 = OR (Over Run)
          this.finishExecution();
          return 0xD0; // now in result phase
        }
        // RQM + EXM + CB, DIO depends on read vs write
        return this.exWriting ? 0xB0 : 0xF0; // write: RQM+EXM+CB, read: RQM+DIO+EXM+CB
      }
      case Phase.Result:    return 0xD0; // RQM + DIO + CB
    }
  }

  // ── Data Register (port 0x3FFD) ────────────────────────────────────

  /** Read data register — returns next result byte or execution data. */
  readData(): number {
    if (this.phase === Phase.Execution && !this.exWriting) {
      this.exOverrunPolls = 0; // CPU is still reading — reset overrun counter
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
      if (this.exReadTrack) {
        // Read Track: entire track buffer exhausted, finish
        this.finishExecution();
      } else {
        // Read Data: current sector exhausted, try next sector
        if (!this.advanceSector()) {
          this.finishExecution();
        }
      }
    }
    return val;
  }

  private writeExecution(val: number): void {
    if (this.exPos >= this.exBuf.length) return;
    this.exBuf[this.exPos++] = val;
    if (this.exPos >= this.exBuf.length) {
      if (this.exFormatting) {
        this.finishFormat();
      } else {
        // Write buffer back to disk image
        this.writeBackSector();
        if (!this.advanceSector()) {
          this.finishExecution();
        }
      }
    }
  }

  /**
   * Try to advance to the next sector (R+1). Returns false if at EOT or
   * if the next sector can't be found. Sets exHitEOT so finishExecution()
   * can report the correct ST0/ST1 flags.
   */
  private advanceSector(): boolean {
    // Copy-protection tracks: sector.c ≠ physical cylinder. Real hardware can't
    // find the next sector due to rotation timing — stop after one sector.
    if (this.exSingleSector) {
      this.exHitEOT = true;
      return false;
    }

    this.exR++;
    if (this.exR > this.exEOT) {
      this.exHitEOT = true;
      return false;
    }

    const track = this.exTrack;
    if (!track) return false;

    const idx = track.sectorMap.get(this.exR);
    if (idx === undefined) {
      return false;
    }

    const sector = track.sectors[idx];
    if (this.exWriting) {
      this.exBuf = new Uint8Array(sector.data.length);
      this.exPos = 0;
    } else {
      this.exBuf = this.prepareReadBuffer(sector);
      this.exPos = 0;
    }

    // Update CHRN and status registers from the new sector's ID field
    this.exC = sector.c;
    this.exH = sector.h;
    this.exST1 = sector.st1;
    this.exST2 = sector.st2;

    return true;
  }

  /**
   * Prepare sector data for reading. For weak sectors (st2 & 0x20) or
   * uniform-fill sectors (Alkatraz protection), return randomized data.
   */
  private prepareReadBuffer(sector: DskSector): Uint8Array {
    // Method 1: Explicit weak flag (ST2 bit 5 = Data CRC error).
    // Used by Speedlock disks. Note: ST2 bit 6 (0x40) is Control Mark
    // (deleted data), NOT a weak sector!
    if (sector.st2 & 0x20) {
      return this.randomizeSector(sector.data);
    }

    // Normal sector — return original data
    return sector.data;
  }

  /** Create a copy of sector data with ~10% random byte variations. */
  private randomizeSector(data: Uint8Array): Uint8Array {
    const buf = new Uint8Array(data.length);
    buf.set(data);
    const numToRandomize = Math.max(1, Math.floor(buf.length * 0.1));
    for (let i = 0; i < numToRandomize; i++) {
      const pos = Math.floor(Math.random() * buf.length);
      buf[pos] = Math.floor(Math.random() * 256);
    }
    return buf;
  }

  /** Write the execution buffer back into the current sector's data. */
  private writeBackSector(): void {
    const track = this.exTrack;
    if (!track) return;
    const idx = track.sectorMap.get(this.exR);
    if (idx === undefined) return;
    track.sectors[idx].data.set(this.exBuf);
  }

  /** End execution phase with result. Sets EN + abnormal termination if EOT was reached. */
  private finishExecution(): void {
    let st0 = (this.exHead << 2) | this.exUnit;
    let st1 = this.exST1;
    if (this.exHitEOT) {
      // Real uPD765A signals abnormal termination + End of Cylinder when
      // the sector counter passes EOT. The data was read/written fine —
      // this just means "no more sectors". Many protection schemes
      // (Alkatraz, Speedlock) check for exactly ST0=0x40 / ST1=0x80.
      st0 |= ST0_ABNORMAL;
      st1 |= 0x80;  // EN (End of Cylinder)
    }
    // Return actual ST1 and ST2 from the sector (preserves CRC errors!)
    // Speedlock checks for intentional CRC errors - must not "fix" them!
    this.log(`  ← Result: ST0=0x${st0.toString(16).padStart(2, '0')} ST1=0x${st1.toString(16).padStart(2, '0')} ST2=0x${this.exST2.toString(16).padStart(2, '0')} C=${this.exC} H=${this.exH} R=${this.exR} N=${this.exN}`);
    if ((st1 & ~0x80) || this.exST2) {
      this.log(`  ⚠ CRC/Error flags present in result!`);
    }
    this.result([st0, st1, this.exST2, this.exC, this.exH, this.exR, this.exN]);
  }

  // ── Command dispatch ───────────────────────────────────────────────

  private exec(): void {
    const cmd = this.cmdBuf[0] & 0x1F;
    const cmdName = this.getCommandName(cmd);
    this.log(`CMD: ${cmdName} (0x${cmd.toString(16).padStart(2, '0').toUpperCase()})`,
             `params=[${this.cmdBuf.slice(1).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);

    switch (cmd) {
      case CMD_SPECIFY:       this.cmdSpecify(); break;
      case CMD_SENSE_DRIVE:   this.cmdSenseDrive(); break;
      case CMD_SENSE_INT:     this.cmdSenseInt(); break;
      case CMD_RECALIBRATE:   this.cmdRecalibrate(); break;
      case CMD_SEEK:          this.cmdSeek(); break;
      case CMD_READ_TRACK:    this.cmdReadTrack(); break;
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

  private getCommandName(cmd: number): string {
    switch (cmd) {
      case CMD_READ_TRACK: return 'READ_TRACK';
      case CMD_SPECIFY: return 'SPECIFY';
      case CMD_SENSE_DRIVE: return 'SENSE_DRIVE';
      case CMD_WRITE_DATA: return 'WRITE_DATA';
      case CMD_READ_DATA: return 'READ_DATA';
      case CMD_RECALIBRATE: return 'RECALIBRATE';
      case CMD_SENSE_INT: return 'SENSE_INT';
      case CMD_WRITE_DELETED: return 'WRITE_DELETED';
      case CMD_READ_ID: return 'READ_ID';
      case CMD_READ_DELETED: return 'READ_DELETED';
      case CMD_FORMAT_TRACK: return 'FORMAT_TRACK';
      case CMD_SEEK: return 'SEEK';
      case CMD_VERSION: return 'VERSION';
      case CMD_SCAN_EQUAL: return 'SCAN_EQUAL';
      case CMD_SCAN_LOW_EQ: return 'SCAN_LOW_EQ';
      case CMD_SCAN_HIGH_EQ: return 'SCAN_HIGH_EQ';
      default: return 'UNKNOWN';
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
    const phys = this.physUnit(unit);
    let st3 = unit | (head << 2) | 0x08; // bit 3 = two-side (unit kept for ST3 drive bits)
    if (this.pcn[phys] === 0) st3 |= 0x10; // Track 0
    if (this.disks[phys] || this.forceReady[phys]) st3 |= 0x20; // bit 5 = ready
    if (this.writeProtect[phys]) st3 |= 0x40; // bit 6 = write protected
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
    this.log(`  → Unit=${unit} recalibrating to track 0`);
    this.pcn[this.physUnit(unit)] = 0;
    this.intPending = true;
    this.intST0 = ST0_SEEK_END | unit;
    this.intPCN = 0;
    this.phase = Phase.Idle;
  }

  /** Seek — move to specified cylinder. Generates interrupt. */
  private cmdSeek(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const ncn = this.cmdBuf[2];
    this.log(`  → Unit=${unit} seeking to cylinder ${ncn}`);
    this.pcn[this.physUnit(unit)] = ncn;
    this.intPending = true;
    this.intST0 = ST0_SEEK_END | unit;
    this.intPCN = ncn;
    this.phase = Phase.Idle;
  }

  /** Look up the track at the current head position. */
  private getTrack(unit: number, head: number): DskTrack | null {
    const phys = this.physUnit(unit);
    const disk = this.disks[phys];
    if (!disk) return null;
    const cyl = this.pcn[phys];
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

    this.log(`  → Unit=${unit} Head=${head} C=${c} H=${h} R=${r} N=${n} (${128 << n} bytes) EOT=${eot}`);

    const track = this.getTrack(unit, head);

    if (!track) {
      // No disk or no track — abnormal termination (NR detected before execution,
      // so ST1/ST2 must be 0x00; MA flag only valid after attempting a read)
      this.log(`  ✗ No disk or track not found (C=${c}, H=${h})`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, c, h, r, n]);
      return;
    }

    // Find starting sector by R value
    const idx = track.sectorMap.get(r);
    if (idx === undefined) {
      // Sector not found — No Data
      this.log(`  ✗ Sector R=${r} not found on track`);
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x04, 0x00, c, h, r, n]); // ST1=ND (bit 2)
      return;
    }

    const sector = track.sectors[idx];
    this.log(`  ✓ Found sector: actual size=${sector.data.length} bytes, ST1=0x${sector.st1.toString(16).padStart(2, '0')} ST2=0x${sector.st2.toString(16).padStart(2, '0')}`);
    const isWrite = cmd === CMD_WRITE_DATA || cmd === CMD_WRITE_DELETED;

    // Write-protected disk — reject with ST1 NW (Not Writeable)
    if (isWrite && this.writeProtect[this.physUnit(unit)]) {
      this.log(`  ✗ Write rejected — drive ${unit} is write-protected`);
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x02, 0x00, c, h, r, n]); // ST1=NW (bit 1)
      return;
    }

    // Save execution state — C, H, N come from the sector's own ID field,
    // not the command parameters. The real uPD765A reports the last sector's
    // actual CHRN in its result bytes, which may differ from the command's
    // CHRN (e.g. copy-protection sectors with mismatched cylinder fields).
    this.exUnit = unit;
    this.exHead = head;
    this.exC = sector.c;
    this.exH = sector.h;
    this.exN = sector.n;  // From sector ID (may differ from command N)
    this.exR = r;
    this.exEOT = eot;
    this.exHitEOT = false;
    this.exTrack = track;
    this.exWriting = isWrite;
    this.exReadTrack = false; // Reading individual sectors, not raw track
    this.exOverrunPolls = 0;

    // Latch for UI display (execution completes within one frame)
    this.latchR = r;
    this.latchHead = head;
    this.latchWriting = isWrite;
    this.latchFrames = 25; // ~0.5s at 50fps

    // OVERLAPPING SECTOR SUPPORT:
    // We use sector.data.length, which may NOT match the size claimed by
    // the N parameter (from command or sector ID). Speedlock protection
    // uses sectors where the ID claims 512 bytes (N=2) but only 256 bytes
    // of physical data exist. We read what's actually there and move on.
    // No validation, no errors - just like real hardware.
    if (isWrite) {
      this.exBuf = new Uint8Array(sector.data.length);
      this.exPos = 0;
    } else {
      this.exBuf = this.prepareReadBuffer(sector);
      this.exPos = 0;
    }

    // CRC ERROR SUPPORT: Capture sector error flags (critical for Speedlock!)
    // Speedlock checks that sectors with intentional CRC errors return the
    // proper error status. If we "fix" errors or return ST1/ST2=0, it fails.
    this.exST1 = sector.st1;
    this.exST2 = sector.st2;

    // COPY-PROTECTION SINGLE-SECTOR MODE:
    // If the sector's C field doesn't match the physical cylinder, this is a
    // copy-protection track. On real hardware, disk rotation timing prevents the
    // FDC from finding sector R+1 after reading R on such tracks — the head is
    // positioned at the wrong cylinder. We simulate this by stopping after one
    // sector, matching the single-sector-per-command behaviour real hardware gives.
    const physCyl = this.pcn[this.physUnit(unit)];
    this.exSingleSector = (sector.c !== physCyl);

    // DELETED DATA ADDRESS MARK (DDAM) SUPPORT:
    // ST2 bit 6 (CM) in the DSK means the sector has a Deleted Data Address Mark.
    // - READ_DATA: CM is set in result if sector has DDAM (mismatch)
    // - READ_DELETED_DATA: CM is set if sector has normal DAM (mismatch)
    // The DSK stores the absolute flag, but the FDC result is relative to
    // the command type. For READ_DELETED_DATA, a sector WITH DDAM is the
    // expected type, so CM should be clear. A sector WITHOUT DDAM is a
    // mismatch, so CM should be set.
    const sectorHasDDAM = !!(sector.st2 & 0x40);
    const cmdExpectsDDAM = (cmd === CMD_READ_DELETED || cmd === CMD_WRITE_DELETED);
    if (sectorHasDDAM === cmdExpectsDDAM) {
      // Address mark matches command type — clear CM
      this.exST2 &= ~0x40;
    } else {
      // Address mark mismatch — set CM
      this.exST2 |= 0x40;
    }

    this.phase = Phase.Execution;
  }

  /**
   * Read Track — return entire raw track data including gaps and IDs.
   * Critical for Speedlock protection which checks gap sizes and timing.
   */
  private cmdReadTrack(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const c = this.cmdBuf[2], h = this.cmdBuf[3];
    const r = this.cmdBuf[4], n = this.cmdBuf[5];
    const eot = this.cmdBuf[6];

    this.log(`  → Unit=${unit} Head=${head} C=${c} H=${h} - Reading entire raw track`);

    const track = this.getTrack(unit, head);

    if (!track || track.sectors.length === 0) {
      // No disk or empty track — NR before execution, ST1/ST2=0
      this.log(`  ✗ No disk or empty track`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, c, h, r, n]);
      return;
    }

    this.log(`  ✓ Track has ${track.sectors.length} sectors, Gap3=${track.gap3}, Filler=0x${(track.filler || 0x4E).toString(16).padStart(2, '0')}`);

    // Build raw track data with proper gaps and formatting
    const trackData = this.buildRawTrack(track);
    this.log(`  → Built raw track data: ${trackData.length} bytes`);

    // Save execution state
    this.exUnit = unit;
    this.exHead = head;
    this.exC = c;
    this.exH = h;
    this.exN = n;
    this.exR = r;
    this.exEOT = eot;
    this.exHitEOT = false;
    this.exTrack = track;
    this.exWriting = false;
    this.exReadTrack = true; // Flag: reading entire raw track

    // Read Track returns raw data, ST1/ST2 typically 0 (no errors at track level)
    this.exST1 = 0;
    this.exST2 = 0;

    // Latch for UI display
    this.latchR = r;
    this.latchHead = head;
    this.latchWriting = false;
    this.latchFrames = 25;

    this.exBuf = trackData;
    this.exPos = 0;
    this.phase = Phase.Execution;
  }

  /**
   * Build raw track data including gaps, sync, address marks, and CRCs.
   * This is what Speedlock reads to verify genuine disk timing/structure.
   */
  private buildRawTrack(track: DskTrack): Uint8Array {
    const parts: Uint8Array[] = [];

    // Gap 4a (post-index gap) — 80 bytes of 0x4E
    parts.push(new Uint8Array(80).fill(0x4E));

    // Sync — 12 bytes of 0x00
    parts.push(new Uint8Array(12).fill(0x00));

    // Index Address Mark — 3×0xC2 (with missing clock) + 0xFC
    // Simplified: just use 0xC2 bytes (real hardware needs special encoding)
    parts.push(new Uint8Array([0xC2, 0xC2, 0xC2, 0xFC]));

    // Gap 1 — 50 bytes of 0x4E
    parts.push(new Uint8Array(50).fill(0x4E));

    // For each sector in the track
    for (const sector of track.sectors) {
      // Sync — 12 bytes of 0x00
      parts.push(new Uint8Array(12).fill(0x00));

      // ID Address Mark — 3×0xA1 (with missing clock) + 0xFE
      parts.push(new Uint8Array([0xA1, 0xA1, 0xA1, 0xFE]));

      // ID Field — C, H, R, N
      const idField = new Uint8Array([sector.c, sector.h, sector.r, sector.n]);
      parts.push(idField);

      // CRC for ID field (simplified — calculate proper CRC)
      const idCrc = this.calcCrc([0xA1, 0xA1, 0xA1, 0xFE, sector.c, sector.h, sector.r, sector.n]);
      parts.push(idCrc);

      // Gap 2 — 22 bytes of 0x4E
      parts.push(new Uint8Array(22).fill(0x4E));

      // Sync — 12 bytes of 0x00
      parts.push(new Uint8Array(12).fill(0x00));

      // Data Address Mark — 3×0xA1 + 0xFB (or 0xF8 for deleted data)
      // ST2 bit 6 (0x40) = Control Mark = Deleted Data Mark
      const dam = (sector.st2 & 0x40) ? 0xF8 : 0xFB;
      parts.push(new Uint8Array([0xA1, 0xA1, 0xA1, dam]));

      // Data Field — the actual sector data
      // CRITICAL: We output sector.data.length bytes, which may NOT match
      // the size claimed by sector.n in the ID field. This is intentional!
      // Speedlock uses "overlapping sectors" where N=2 (512 bytes) but the
      // physical data is only 256 bytes, causing the next sector ID to
      // appear "early". Extended DSK format preserves this; standard DSK
      // enforces 128<<N and will break these protections.
      parts.push(sector.data);

      // CRC for data field
      const dataCrc = this.calcCrcData([0xA1, 0xA1, 0xA1, dam], sector.data);
      parts.push(dataCrc);

      // Gap 3 — from track metadata (critical for Speedlock!)
      const gap3Size = track.gap3 > 0 ? track.gap3 : 24; // default 24 if not specified
      parts.push(new Uint8Array(gap3Size).fill(track.filler || 0x4E));
    }

    // Gap 4b — fill remainder to standard track size (~6250 bytes for DD)
    // This ensures consistent track length
    const currentSize = parts.reduce((sum, p) => sum + p.length, 0);
    const targetSize = 6250; // Standard double-density track
    if (currentSize < targetSize) {
      parts.push(new Uint8Array(targetSize - currentSize).fill(track.filler || 0x4E));
    }

    // Concatenate all parts
    const total = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      total.set(part, offset);
      offset += part.length;
    }

    return total;
  }

  /**
   * Calculate CRC-16-CCITT for ID field.
   * Polynomial: 0x1021, initial: 0xFFFF
   */
  private calcCrc(data: number[]): Uint8Array {
    let crc = 0xFFFF;
    for (const byte of data) {
      crc ^= (byte << 8);
      for (let i = 0; i < 8; i++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc = crc << 1;
        }
      }
    }
    crc &= 0xFFFF;
    return new Uint8Array([crc >> 8, crc & 0xFF]);
  }

  /**
   * Calculate CRC for data field (address mark + data).
   */
  private calcCrcData(header: number[], data: Uint8Array): Uint8Array {
    let crc = 0xFFFF;

    // Process header bytes
    for (const byte of header) {
      crc ^= (byte << 8);
      for (let i = 0; i < 8; i++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc = crc << 1;
        }
      }
    }

    // Process data bytes
    for (const byte of data) {
      crc ^= (byte << 8);
      for (let i = 0; i < 8; i++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc = crc << 1;
        }
      }
    }

    crc &= 0xFFFF;
    return new Uint8Array([crc >> 8, crc & 0xFF]);
  }

  /** Read ID — return CHRN of current sector under the head. */
  private cmdReadID(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;

    const track = this.getTrack(unit, head);

    if (!track || track.sectors.length === 0) {
      // No disk or empty track — NR before execution, ST1/ST2=0
      this.log(`  ✗ No disk or empty track for Read ID`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, 0, 0, 0, 0]);
      return;
    }

    // Cycle through sectors on repeated calls (ROM uses this to discover layout)
    const physU = this.physUnit(unit);
    const idx = this.idIndex[physU] % track.sectors.length;
    this.idIndex[physU] = idx + 1;
    const sector = track.sectors[idx];

    this.log(`  → Unit=${unit} Head=${head} returning sector ID: C=${sector.c} H=${sector.h} R=${sector.r} N=${sector.n}`);
    const st0 = (head << 2) | unit; // normal termination
    this.result([st0, 0x00, 0x00, sector.c, sector.h, sector.r, sector.n]);
  }

  /**
   * Format Track.
   * cmdBuf: [cmd, HDS, N, SC, GPL, D]
   *   N   = sector size code (128 << N bytes per sector)
   *   SC  = sectors per cylinder
   *   GPL = gap 3 length
   *   D   = filler byte
   *
   * Execution phase: CPU writes SC×4 bytes (C, H, R, N per sector).
   * On completion the track in the disk image is rebuilt from those IDs,
   * each sector filled with D, then normal termination is returned.
   */
  private cmdFormat(): void {
    const unit = this.cmdBuf[1] & 0x03;
    const head = (this.cmdBuf[1] >> 2) & 1;
    const n   = this.cmdBuf[2];
    const sc  = this.cmdBuf[3];
    const gpl = this.cmdBuf[4];
    const d   = this.cmdBuf[5];

    const physU = this.physUnit(unit);
    if (!this.disks[physU]) {
      this.log(`  ✗ No disk in unit ${unit}`);
      const st0 = ST0_ABNORMAL | ST0_NOT_READY | (head << 2) | unit;
      this.result([st0, 0x00, 0x00, 0, head, 0, n]);
      return;
    }
    if (this.writeProtect[physU]) {
      this.log(`  ✗ Drive ${unit} write-protected`);
      const st0 = ST0_ABNORMAL | (head << 2) | unit;
      this.result([st0, 0x02, 0x00, 0, head, 0, n]); // ST1 bit 1 = NW
      return;
    }

    this.log(`  → Unit=${unit} Head=${head} N=${n} SC=${sc} GPL=${gpl} Fill=0x${d.toString(16).padStart(2, '0')}`);

    this.exUnit      = unit;
    this.exHead      = head;
    this.exN         = n;
    this.exSC        = sc;
    this.exGPL       = gpl;
    this.exFiller    = d;
    this.exFormatting = true;
    this.exWriting   = true;
    this.exHitEOT    = false;
    this.exST1       = 0;
    this.exST2       = 0;
    // Receive SC×4 bytes from CPU: one (C, H, R, N) tuple per sector
    this.exBuf = new Uint8Array(sc * 4);
    this.exPos = 0;

    this.latchWriting = true;
    this.latchFrames  = 25;

    this.phase = Phase.Execution;
  }

  /** Rebuild the current track from received sector IDs, then finish. */
  private finishFormat(): void {
    const physU = this.physUnit(this.exUnit);
    const disk = this.disks[physU];
    if (!disk) { this.finishExecution(); return; }

    const cyl    = this.pcn[physU];
    const head   = this.exHead;
    const sc     = this.exSC;
    const filler = this.exFiller;
    const gpl    = this.exGPL;
    const buf    = this.exBuf;

    // Build sector list from the CPU-supplied (C, H, R, N) tuples
    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();
    let lastR = 0;
    for (let i = 0; i < sc; i++) {
      const c = buf[i * 4];
      const h = buf[i * 4 + 1];
      const r = buf[i * 4 + 2];
      const n = buf[i * 4 + 3];
      const data = new Uint8Array(128 << n).fill(filler);
      sectors.push({ c, h, r, n, st1: 0, st2: 0, data });
      sectorMap.set(r, i);
      lastR = r;
    }

    // Extend tracks array if this cylinder is beyond what the image has
    while (disk.tracks.length <= cyl) {
      disk.tracks.push(Array.from({ length: disk.numSides }, () => null));
    }
    disk.tracks[cyl][head] = { sectors, sectorMap, gap3: gpl, filler };

    this.log(`  ✓ Formatted cyl=${cyl} head=${head}: ${sc} sectors, last R=${lastR}`);

    // Signal to the UI layer that metadata needs refreshing
    this.formattedUnit = this.exUnit;

    // Set result fields for finishExecution()
    this.exC   = cyl;
    this.exH   = head;
    this.exR   = lastR;
    this.exST1 = 0;
    this.exST2 = 0;
    this.exFormatting = false;

    this.finishExecution();
  }

  /** Version — 0x80 = enhanced controller (uPD765A compatible). */
  private cmdVersion(): void {
    this.result([0x80]);
  }

  /** Invalid/unrecognised command — return ST0 with invalid-command code. */
  private cmdInvalid(): void {
    this.log(`  ✗✗✗ INVALID/UNIMPLEMENTED COMMAND! Command byte: 0x${this.cmdBuf[0].toString(16).padStart(2, '0').toUpperCase()}`);
    this.log(`      Full command buffer: [${this.cmdBuf.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
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
    this.exReadTrack = false;
    this.exTrack = null;
    this.exST1 = 0;
    this.exST2 = 0;
    this.latchR = 0;
    this.latchHead = 0;
    this.latchWriting = false;
    this.latchFrames = 0;
    // Note: disk image and idIndex intentionally preserved across reset
  }
}
