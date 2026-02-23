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

const ROM_BASE = 'https://zx84files.bitsparse.com/roms/';

// Each model lists its ROM pages in order; they are fetched and concatenated.
const DEFAULT_ROM_URLS: Record<SpectrumModel, string[]> = {
  '48k':  [`${ROM_BASE}48.rom`],
  '128k': [`${ROM_BASE}128-0.rom`, `${ROM_BASE}128-1.rom`],
  '+2':   [`${ROM_BASE}plus2-0.rom`, `${ROM_BASE}plus2-1.rom`],
  '+2a':  [`${ROM_BASE}plus3-41-0.rom`, `${ROM_BASE}plus3-41-1.rom`, `${ROM_BASE}plus3-41-2.rom`, `${ROM_BASE}plus3-41-3.rom`],
  '+3':   [`${ROM_BASE}plus3-0.rom`, `${ROM_BASE}plus3-1.rom`, `${ROM_BASE}plus3-2.rom`, `${ROM_BASE}plus3-3.rom`],
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
    const urls = DEFAULT_ROM_URLS[model];
    if (!urls?.length) return null;

    onStatus?.(`Downloading ${model.toUpperCase()} ROM…`);

    try {
      const pages = await Promise.all(urls.map(async url => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url.split('/').pop()}`);
        return new Uint8Array(await resp.arrayBuffer());
      }));

      // Concatenate pages into a single ROM image
      const totalLength = pages.reduce((n, p) => n + p.length, 0);
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const page of pages) { data.set(page, offset); offset += page.length; }

      const label = urls[0].split('/').pop()!;
      await this.persistROM(model, data, label);
      onStatus?.(`${model.toUpperCase()} ROM loaded`);

      return { data, label };
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
