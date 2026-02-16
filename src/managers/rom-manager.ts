/**
 * ROM Manager - handles ROM loading, caching, and persistence.
 *
 * Responsibilities:
 * - Cache ROM images per model (48K, 128K, +2, +2A, +3)
 * - Persist ROMs to IndexedDB for offline use
 * - Fetch default ROMs from CDN when needed
 * - Manage ROM labels and metadata
 */

import type { SpectrumModel } from '@/spectrum.ts';
import { dbSave, dbLoad } from '@/store/persistence.ts';

export interface ROMEntry {
  data: Uint8Array;
  label: string;
}

const DEFAULT_ROM_URLS: Record<SpectrumModel, string> = {
  '48k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '128k': 'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/128/spec128uk.rom',
  '+2':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/plus2/plus2uk.rom',
  '+2a':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus2a/plus2a.rom',
  '+3':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus3/plus3.rom',
};

export class ROMManager {
  private cache: Record<string, ROMEntry> = {};

  /**
   * Persist a ROM image to cache and IndexedDB.
   */
  async persistROM(model: SpectrumModel, data: Uint8Array, label: string): Promise<void> {
    this.cache[model] = { data, label };
    await dbSave(`rom-${model}`, data);
    try {
      localStorage.setItem(`zx84-rom-label-${model}`, label);
    } catch { /* */ }
  }

  /**
   * Restore a ROM from cache or IndexedDB.
   * Returns null if no ROM is stored for this model.
   */
  async restoreROM(model: SpectrumModel): Promise<ROMEntry | null> {
    if (this.cache[model]) return this.cache[model];

    const data = await dbLoad(`rom-${model}`);
    if (!data) return null;

    const label = localStorage.getItem(`zx84-rom-label-${model}`) || 'saved ROM';
    this.cache[model] = { data, label };
    return this.cache[model];
  }

  /**
   * Fetch default ROM from CDN and cache it.
   * Returns null if fetch fails.
   */
  async fetchDefaultROM(
    model: SpectrumModel,
    onStatus?: (msg: string) => void
  ): Promise<ROMEntry | null> {
    const url = DEFAULT_ROM_URLS[model];
    if (!url) return null;

    onStatus?.(`Downloading ${model.toUpperCase()} ROM…`);

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = new Uint8Array(await resp.arrayBuffer());
      const name = url.split('/').pop()!;

      await this.persistROM(model, data, name);
      onStatus?.(`${model.toUpperCase()} ROM loaded`);

      return { data, label: name };
    } catch (err) {
      onStatus?.(`Failed to download ROM: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Load a ROM and return it, trying cache first, then fetching if needed.
   */
  async loadROM(
    model: SpectrumModel,
    onStatus?: (msg: string) => void
  ): Promise<ROMEntry | null> {
    let entry = await this.restoreROM(model);
    if (!entry) entry = await this.fetchDefaultROM(model, onStatus);
    return entry;
  }

  /**
   * Get cached ROM without triggering a fetch.
   */
  getCached(model: SpectrumModel): ROMEntry | null {
    return this.cache[model] || null;
  }
}
