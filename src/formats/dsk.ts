/**
 * DSK disk image parser for ZX Spectrum +3.
 *
 * Supports both standard ("MV - CPC") and extended ("EXTENDED") DSK formats
 * as used by the Amstrad CPC / ZX Spectrum +3.
 */

// ── Data structures ─────────────────────────────────────────────────────────

export interface DskSector {
  c: number;           // Cylinder (track) from CHRN
  h: number;           // Head (side) from CHRN
  r: number;           // Record (sector ID) from CHRN
  n: number;           // Size code from CHRN
  st1: number;         // FDC status register 1
  st2: number;         // FDC status register 2
  data: Uint8Array;    // Sector data
}

export interface DskTrack {
  sectors: DskSector[];
  /** Map from sector R value → index into sectors[] for O(1) lookup */
  sectorMap: Map<number, number>;
  gap3: number;
  filler: number;
}

export interface DskImage {
  format: 'standard' | 'extended';
  numTracks: number;
  numSides: number;
  /** tracks[cylinder][side] */
  tracks: (DskTrack | null)[][];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function u16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function asciiAt(data: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[offset + i]);
  return s;
}

// ── Track parser ────────────────────────────────────────────────────────────

function parseTrack(data: Uint8Array, trackOffset: number, trackSize: number, isExtended: boolean): DskTrack | null {
  if (trackSize < 256) return null;

  const magic = asciiAt(data, trackOffset, 12);
  if (!magic.startsWith('Track-Info')) return null;

  const sectorCount = data[trackOffset + 0x15];
  const gap3 = data[trackOffset + 0x16];
  const filler = data[trackOffset + 0x17];

  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();

  let dataOffset = trackOffset + 0x100; // sector data starts after 256-byte header

  for (let i = 0; i < sectorCount; i++) {
    const sibOffset = trackOffset + 0x18 + i * 8;
    const c = data[sibOffset];
    const h = data[sibOffset + 1];
    const r = data[sibOffset + 2];
    const n = data[sibOffset + 3];
    const st1 = data[sibOffset + 4];
    const st2 = data[sibOffset + 5];
    const sibDataLen = u16LE(data, sibOffset + 6);

    // Actual stored size: extended format uses SIB dataLen, standard uses 128 << N
    let actualSize: number;
    if (isExtended && sibDataLen > 0) {
      actualSize = sibDataLen;
    } else {
      actualSize = n <= 5 ? (128 << n) : n === 6 ? 6144 : 0;
    }

    // Extract sector data, handling truncated files gracefully
    let sectorData: Uint8Array;
    if (dataOffset + actualSize <= data.length) {
      sectorData = data.slice(dataOffset, dataOffset + actualSize);
    } else if (dataOffset < data.length) {
      sectorData = new Uint8Array(actualSize);
      sectorData.set(data.subarray(dataOffset, data.length));
      sectorData.fill(filler, data.length - dataOffset);
    } else {
      sectorData = new Uint8Array(actualSize);
      sectorData.fill(filler);
    }

    sectors.push({ c, h, r, n, st1, st2, data: sectorData });
    sectorMap.set(r, i);
    dataOffset += actualSize;
  }

  return { sectors, sectorMap, gap3, filler };
}

// ── Main parser ─────────────────────────────────────────────────────────────

export function parseDSK(data: Uint8Array): DskImage {
  if (data.length < 256) throw new Error('DSK file too small');

  const magic = asciiAt(data, 0, 8);
  let isExtended: boolean;
  if (magic === 'EXTENDED') {
    isExtended = true;
  } else if (magic === 'MV - CPC') {
    isExtended = false;
  } else {
    throw new Error('Not a valid DSK file');
  }

  const numTracks = data[0x30];
  const numSides = data[0x31];

  if (numTracks === 0 || numSides === 0) throw new Error('DSK has no tracks');

  // Build track size table
  const totalTracks = numTracks * numSides;
  const trackSizes: number[] = [];

  if (isExtended) {
    // Extended: per-track sizes at 0x34, each byte × 256
    for (let i = 0; i < totalTracks; i++) {
      trackSizes.push(data[0x34 + i] * 256);
    }
  } else {
    // Standard: fixed track size from u16LE at 0x32
    const fixedSize = u16LE(data, 0x32);
    for (let i = 0; i < totalTracks; i++) {
      trackSizes.push(fixedSize);
    }
  }

  // Allocate tracks[cylinder][side]
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    tracks.push(new Array(numSides).fill(null));
  }

  // Parse each track
  let offset = 256; // skip disk info block
  for (let t = 0; t < numTracks; t++) {
    for (let s = 0; s < numSides; s++) {
      const idx = t * numSides + s;
      const size = trackSizes[idx];
      if (size === 0) {
        // Unformatted track
        continue;
      }
      tracks[t][s] = parseTrack(data, offset, size, isExtended);
      offset += size;
    }
  }

  return {
    format: isExtended ? 'extended' : 'standard',
    numTracks,
    numSides,
    tracks,
  };
}
