/**
 * VTX-5000 peripheral — Prism Microelectronics Viewdata/Prestel modem for 48K Spectrum.
 *
 * The VTX-5000 replaces the bottom of the Spectrum ROM with its own viewdata
 * terminal ROM.  ROM images may be 8KB (0x0000-0x1FFF) or 16KB (full slot 0);
 * applyROM() copies only as many bytes as the loaded image contains, leaving
 * the remainder of slot 0 unchanged (i.e. the Spectrum ROM second half stays
 * visible at 0x2000-0x3FFF for an 8KB VTX ROM).
 *
 * The modem hardware uses an Intel 8251 USART for serial communication.
 * The 8251's RTS output controls ROMCS:
 *   RTS=0 (command bit5 clear): VTX-5000 ROM paged in
 *   RTS=1 (command bit5 set):   Spectrum ROM paged in
 *
 * I/O ports (active when VTX-5000 is enabled):
 *   Port $FF (A7=1): 8251 Control/Status register
 *   Port $7F (A7=0): 8251 Data register
 *
 * Only valid for the 48K model.
 */

// ── 8251 Status register bits ───────────────────────────────────────────
const TXRDY   = 0x01;  // Bit 0: Transmit buffer empty
const RXRDY   = 0x02;  // Bit 1: Receive data available
const TXEMPTY = 0x04;  // Bit 2: Transmitter completely empty
// Bit 3: PE (parity error)
// Bit 4: OE (overrun error)
// Bit 5: FE (framing error)
// Bit 6: SYNDET (break detected)
const DSR     = 0x80;  // Bit 7: Data Set Ready

// ── 8251 Command register bits ──────────────────────────────────────────
// Bit 0: TxEN (transmit enable)
// Bit 1: DTR
// Bit 2: RxEN (receive enable)
// Bit 3: SBRK (send break)
// Bit 4: ER (error reset)
const CMD_RTS  = 0x20;  // Bit 5: RTS — controls ROMCS
const CMD_IR   = 0x40;  // Bit 6: Internal reset

import type { SpectrumMemory } from '@/memory.ts';

export class VTX5000 {
  enabled = false;
  romLoaded = false;

  /** ROM image as loaded (8KB) */
  vtxRom = new Uint8Array(8192);
  /** Number of valid bytes in vtxRom */
  romSize = 0;

  /** VTX-5000 on-board RAM at 0x2000-0x3FFF (preserved across ROM switches) */
  vtxRam = new Uint8Array(8192);

  /** 16KB overlay placed in slot 0 when VTX ROM is paged in: [vtxRom | vtxRam]. */
  private vtxOverlay = new Uint8Array(16384);

  /** Whether VTX ROM is currently paged in (RTS=0) vs Spectrum ROM (RTS=1) */
  vtxRomPaged = true;

  // ── 8251 USART state ────────────────────────────────────────────────
  /** True when the next control write is the mode register (after reset) */
  private expectMode = true;
  /** Mode register value (set by first write after reset; unused in emulation) */
  modeReg = 0;
  /** Command register value */
  private commandReg = 0;

  /** Receive FIFO — bytes sent to the VTX-5000 from outside */
  private rxFifo: number[] = [];

  /** Whether DSR (Data Set Ready) is asserted by the remote end */
  dsr = false;

  /**
   * Callback invoked when the 8251 command register changes the RTS bit,
   * triggering a ROM page switch.  Set by the IO wiring code.
   *   rts=false → page in VTX ROM;  rts=true → page in Spectrum ROM.
   */
  onRomPage: ((rts: boolean) => void) | null = null;

  reset(): void {
    this.expectMode = true;
    this.modeReg = 0;
    this.commandReg = 0;
    this.rxFifo.length = 0;
    this.dsr = false;
    this.vtxRomPaged = true;
    this.vtxRam.fill(0);
  }

  loadROM(data: Uint8Array): void {
    // Accept 8KB or 16KB images (only first 8K is ROM; rest is ignored)
    const size = Math.min(data.length, 8192);
    this.romSize = size;
    this.vtxRom.fill(0);
    this.vtxRom.set(data.subarray(0, size));
    this.romLoaded = true;
  }

  /**
   * Place VTX-5000 ROM and RAM into slot 0 via an overlay buffer.
   * Call after SpectrumMemory.applyBanking() so paging state is settled.
   */
  applyROM(memory: SpectrumMemory): void {
    this.vtxOverlay.set(this.vtxRom.subarray(0, this.romSize), 0);
    this.vtxOverlay.set(this.vtxRam, 0x2000);
    memory.setSlot0(this.vtxOverlay);
    this.vtxRomPaged = true;
  }

  /** Save VTX RAM from the overlay (call before restoring slot 0). */
  saveRAMFromOverlay(): void {
    this.vtxRam.set(this.vtxOverlay.subarray(0x2000, 0x4000));
  }

  // ── 8251 port handlers ──────────────────────────────────────────────

  /** Read 8251 status register (port $FF) */
  readStatus(): number {
    let status = TXRDY | TXEMPTY;  // Always ready to transmit (no real serial line)
    if (this.rxFifo.length > 0) status |= RXRDY;
    if (this.dsr) status |= DSR;
    return status;
  }

  /** Write 8251 control register (port $FF) — mode or command depending on state */
  writeControl(val: number): void {
    if (this.expectMode) {
      // First write after reset: mode register
      this.modeReg = val;
      this.expectMode = false;
      return;
    }

    // Command register write
    if (val & CMD_IR) {
      // Internal reset — next write will be mode register
      this.expectMode = true;
      this.commandReg = 0;
      return;
    }

    const prevRTS = this.commandReg & CMD_RTS;
    this.commandReg = val;
    const newRTS = val & CMD_RTS;

    // RTS change → ROM page switch
    if (newRTS !== prevRTS && this.onRomPage) {
      this.onRomPage(newRTS !== 0);
    }
  }

  /** Read 8251 data register (port $7F) — returns next RX byte or 0 */
  readData(): number {
    return this.rxFifo.length > 0 ? this.rxFifo.shift()! : 0;
  }

  /** Write 8251 data register (port $7F) — transmit byte (currently discarded) */
  writeData(_val: number): void {
    // No remote end connected — TX data is discarded
  }

  // ── External interface (for MCP server / future network) ────────────

  /** Queue a byte into the receive FIFO (as if received from the modem) */
  receivebyte(val: number): void {
    this.rxFifo.push(val & 0xFF);
  }
}
