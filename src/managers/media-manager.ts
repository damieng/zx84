/**
 * Media Manager - handles tape and disk loading, routing, and persistence.
 *
 * Responsibilities:
 * - Load and route TAP, TZX, DSK, SNA, Z80, SZX, SP files
 * - Handle ZIP file unpacking and file selection
 * - Persist last-loaded file and media state
 * - Coordinate with Spectrum instance for media operations
 */

import type { Spectrum } from '@/spectrum.ts';
import { type SpectrumModel, is128kClass, isPlus2AClass } from '@/models.ts';
import type { TapeBlock } from '@/tape/tap.ts';
import { parseTZX } from '@/tape/tzx.ts';
import { parseDSK, type DskImage } from '@/plus3/dsk.ts';
import { unzip } from '@/snapshot/zip.ts';
import { showFilePicker } from '@/ui/zip-picker.ts';
import { loadSNA } from '@/snapshot/sna.ts';
import { loadZ80 } from '@/snapshot/z80format.ts';
import { loadSZX } from '@/snapshot/szx.ts';
import { loadSP } from '@/snapshot/sp.ts';
import { persistLastFile, persistTape, clearTape, persistDisk, clearDisk } from '@/store/persistence.ts';

export interface MediaLoadCallbacks {
  onStatus: (msg: string) => void;
  onTapeLoaded: (blocks: TapeBlock[], filename: string) => void;
  onDiskLoaded: (image: DskImage, filename: string, unit: number) => void;
  onSnapshotLoaded: (filename: string) => void;
  unpause: () => void;
  ensure128kROM: () => Promise<boolean>;
}

export class MediaManager {
  /**
   * Load tape (TAP or TZX) into the spectrum instance.
   */
  applyTape(
    spectrum: Spectrum,
    data: Uint8Array,
    filename: string,
    callbacks: Pick<MediaLoadCallbacks, 'onStatus' | 'onTapeLoaded' | 'unpause'>
  ): void {
    // Stop the machine first to prevent the frame loop from interfering
    spectrum.stop();

    const ext = filename.toLowerCase().split('.').pop();
    let blocks: TapeBlock[];

    try {
      if (ext === 'tzx') {
        blocks = parseTZX(data);
      } else {
        blocks = spectrum.tape.parseTAP(data);
      }
    } catch (e) {
      spectrum.start();
      callbacks.onStatus(`Error: ${(e as Error).message}`);
      return;
    }

    // Set tape state on the deck in play mode but paused —
    // like pressing PLAY on a real cassette deck but with the pause button held.
    spectrum.tape.blocks = blocks;
    spectrum.tape.position = 0;
    spectrum.tape.paused = true;
    spectrum.tape.startPlayback();

    // Reset machine (preserves tape) and restart
    spectrum.reset();
    spectrum.start();

    // Update UI via callback
    callbacks.onTapeLoaded(blocks, filename);
    callbacks.unpause();
    callbacks.onStatus(`Tape loaded: ${filename}`);

    // Persist for next session
    persistLastFile(data, filename);
    persistTape(data, filename);
  }

  /**
   * Eject tape from the spectrum instance.
   */
  ejectTape(
    spectrum: Spectrum,
    onTapeEjected: () => void,
    onStatus: (msg: string) => void
  ): void {
    spectrum.tape.stopPlayback();
    spectrum.tape.blocks = [];
    spectrum.tape.position = 0;
    spectrum.tape.paused = true;

    onTapeEjected();
    clearTape();
    onStatus('Tape ejected');
  }

  /**
   * Load disk image into the FDC.
   */
  loadDisk(
    spectrum: Spectrum,
    data: Uint8Array,
    filename: string,
    unit: number,
    callbacks: Pick<MediaLoadCallbacks, 'onStatus' | 'onDiskLoaded'>
  ): void {
    try {
      const image = parseDSK(data);
      callbacks.onDiskLoaded(image, filename, unit);

      spectrum.loadDisk(image, unit);
      callbacks.onStatus(`Disk ${unit === 0 ? 'A' : 'B'}: loaded: ${filename}`);

      if (unit === 0) persistLastFile(data, filename);
      persistDisk(unit, data, filename);
    } catch (e) {
      callbacks.onStatus(`DSK error: ${(e as Error).message}`);
    }
  }

  /**
   * Eject disk from the FDC.
   */
  ejectDisk(
    spectrum: Spectrum,
    unit: number,
    onDiskEjected: (unit: number) => void,
    onStatus: (msg: string) => void
  ): void {
    if (spectrum.fdc) spectrum.fdc.ejectDisk(unit);
    clearDisk(unit);
    onDiskEjected(unit);
    onStatus(`Disk ${unit === 0 ? 'A' : 'B'}: ejected`);
  }

  /**
   * Load snapshot (SNA, Z80, SZX, SP).
   */
  async applySnapshot(
    spectrum: Spectrum,
    data: Uint8Array,
    filename: string,
    currentModel: SpectrumModel,
    callbacks: Pick<MediaLoadCallbacks, 'onStatus' | 'onSnapshotLoaded' | 'unpause' | 'ensure128kROM'>
  ): Promise<boolean> {
    const ext = filename.toLowerCase().split('.').pop();

    try {
      if (ext === 'sna') {
        if (data.length > 49179 && !is128kClass(currentModel)) {
          if (!await callbacks.ensure128kROM()) {
            callbacks.onStatus('128K SNA requires a 128K ROM — load one first');
            return false;
          }
        }

        spectrum.stop();
        spectrum.reset();
        const result = loadSNA(data, spectrum.cpu, spectrum.memory);
        spectrum.ula.borderColor = result.borderColor;
        spectrum.cpu.memory = spectrum.memory.flat;
        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} SNA: ${filename}`);

      } else if (ext === 'z80') {
        spectrum.stop();
        spectrum.reset();
        const result = loadZ80(data, spectrum.cpu, spectrum.memory);

        if (result.is128K && !is128kClass(currentModel)) {
          if (!await callbacks.ensure128kROM()) {
            callbacks.onStatus('128K .z80 snapshot requires a 128K ROM — load one first');
            return false;
          }
          spectrum.stop();
          spectrum.reset();
          loadZ80(data, spectrum.cpu, spectrum.memory);
        }

        spectrum.ula.borderColor = result.borderColor;
        spectrum.cpu.memory = spectrum.memory.flat;
        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} .z80: ${filename}`);

      } else if (ext === 'szx') {
        spectrum.stop();
        spectrum.reset();
        const result = await loadSZX(data, spectrum.cpu, spectrum.memory);

        if (result.is128K && !is128kClass(currentModel)) {
          if (!await callbacks.ensure128kROM()) {
            callbacks.onStatus('128K .szx snapshot requires a 128K ROM — load one first');
            return false;
          }
          spectrum.stop();
          spectrum.reset();
          await loadSZX(data, spectrum.cpu, spectrum.memory);
        }

        // Apply paging state for 128K
        if (result.is128K) {
          spectrum.memory.port7FFD = result.port7FFD;
          spectrum.memory.currentBank = result.port7FFD & 0x07;
          spectrum.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
          if (isPlus2AClass(currentModel)) {
            spectrum.memory.port1FFD = result.port1FFD;
            spectrum.memory.specialPaging = (result.port1FFD & 1) !== 0;
            // +2A/+3: ROM = bit 2 of 1FFD (high) | bit 4 of 7FFD (low)
            spectrum.memory.currentROM =
              (((result.port1FFD >> 2) & 1) << 1) | ((result.port7FFD >> 4) & 1);
          } else {
            spectrum.memory.currentROM = (result.port7FFD >> 4) & 1;
          }
          spectrum.memory.applyBanking();
        }

        spectrum.ula.borderColor = result.borderColor;
        spectrum.cpu.memory = spectrum.memory.flat;

        // Restore AY state if present
        if (result.ayRegs) {
          spectrum.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) {
            spectrum.ay.selectedReg = result.ayCurrentReg;
          }
        }

        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} .szx: ${filename}`);

      } else if (ext === 'sp') {
        spectrum.stop();
        spectrum.reset();
        const result = loadSP(data, spectrum.cpu, spectrum.memory);

        if (result.is128K && !is128kClass(currentModel)) {
          if (!await callbacks.ensure128kROM()) {
            callbacks.onStatus('128K .sp snapshot requires a 128K ROM — load one first');
            return false;
          }
          spectrum.stop();
          spectrum.reset();
          loadSP(data, spectrum.cpu, spectrum.memory);
        }

        // Apply paging state for 128K
        if (result.is128K) {
          spectrum.memory.port7FFD = result.port7FFD;
          spectrum.memory.currentBank = result.port7FFD & 0x07;
          spectrum.memory.currentROM = (result.port7FFD >> 4) & 1;
          spectrum.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
          spectrum.memory.applyBanking();
        }

        spectrum.ula.borderColor = result.borderColor;
        spectrum.cpu.memory = spectrum.memory.flat;
        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} .sp: ${filename}`);

      } else {
        callbacks.onStatus(`Unknown format: .${ext}`);
        return false;
      }
    } catch (e) {
      callbacks.onStatus(`Error: ${(e as Error).message}`);
      return false;
    }

    callbacks.unpause();
    return true;
  }

  /**
   * Route file load based on extension.
   */
  async loadFile(
    spectrum: Spectrum | null,
    data: Uint8Array,
    filename: string,
    currentModel: SpectrumModel,
    callbacks: MediaLoadCallbacks,
    unit?: number
  ): Promise<void> {
    if (!spectrum) {
      callbacks.onStatus('Load a ROM first');
      return;
    }

    const ext = filename.toLowerCase().split('.').pop();

    if (ext === 'zip') {
      await this.handleZipFile(spectrum, data, currentModel, callbacks, unit);
      return;
    }

    if (ext === 'tap' || ext === 'tzx') {
      this.applyTape(spectrum, data, filename, callbacks);
      return;
    }

    if (ext === 'dsk') {
      const diskUnit = unit ?? 0;
      this.loadDisk(spectrum, data, filename, diskUnit, callbacks);
      return;
    }

    if (ext === 'sna' || ext === 'z80' || ext === 'szx' || ext === 'sp') {
      if (await this.applySnapshot(spectrum, data, filename, currentModel, callbacks)) {
        persistLastFile(data, filename);
      }
      return;
    }

    callbacks.onStatus(`Unknown file type: .${ext}`);
  }

  /**
   * Handle ZIP file unpacking and file selection.
   */
  private async handleZipFile(
    spectrum: Spectrum,
    data: Uint8Array,
    currentModel: SpectrumModel,
    callbacks: MediaLoadCallbacks,
    unit?: number
  ): Promise<void> {
    let entries;
    try {
      entries = await unzip(data);
    } catch (e) {
      callbacks.onStatus(`ZIP error: ${(e as Error).message}`);
      return;
    }

    if (entries.length === 0) {
      callbacks.onStatus('ZIP is empty');
      return;
    }

    if (entries.length === 1) {
      const { name, data: fileData } = entries[0];
      await this.loadFile(spectrum, fileData, name, currentModel, callbacks, unit);
      return;
    }

    // Multiple files: show picker
    const names = entries.map(e => e.name);
    const pickedName = await showFilePicker(names);
    if (!pickedName) {
      callbacks.onStatus('No file selected');
      return;
    }

    const picked = entries.find(e => e.name === pickedName)!;
    await this.loadFile(spectrum, picked.data, picked.name, currentModel, callbacks, unit);
  }
}
