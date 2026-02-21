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
  /** Detected disk format name (e.g. "+3DOS", "CPC System") */
  diskFormat: string;
  /** Detected copy protection scheme, or empty string */
  protection: string;
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

  const image: DskImage = {
    format: isExtended ? 'extended' : 'standard',
    numTracks,
    numSides,
    tracks,
    diskFormat: '',
    protection: '',
  };

  image.diskFormat = detectDiskFormat(image);
  image.protection = detectProtection(image);
  return image;
}

// ── Blank disk creation ─────────────────────────────────────────────────────

export interface DiskFormat {
  label: string;
  sides: number;
  tracks: number;
  sectors: number;
  sectorSize: number;
  gap3: number;
  filler: number;
  firstSector: number;
}

function formatCapacityKB(fmt: DiskFormat): number {
  return (fmt.sides * fmt.tracks * fmt.sectors * fmt.sectorSize) / 1024;
}

export const DISK_FORMATS: DiskFormat[] = [
  {
    label: '+3DOS / PCW CF2',
    sides: 1, tracks: 40, sectors: 9, sectorSize: 512,
    gap3: 82, filler: 0xE5, firstSector: 1,
  },
  {
    label: 'PCW CF2DD',
    sides: 2, tracks: 80, sectors: 9, sectorSize: 512,
    gap3: 82, filler: 0xE5, firstSector: 1,
  },
];

/** Label with capacity, e.g. "+3DOS / PCW CF2 (180K)" */
export function formatLabel(fmt: DiskFormat): string {
  return `${fmt.label} (${formatCapacityKB(fmt)}K)`;
}

export function createBlankDisk(fmt: DiskFormat): DskImage {
  const sizeCode = Math.log2(fmt.sectorSize / 128); // N value: 512 → 2
  const tracks: (DskTrack | null)[][] = [];

  for (let cyl = 0; cyl < fmt.tracks; cyl++) {
    const sides: (DskTrack | null)[] = [];
    for (let head = 0; head < fmt.sides; head++) {
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let i = 0; i < fmt.sectors; i++) {
        const r = fmt.firstSector + i;
        const data = new Uint8Array(fmt.sectorSize);
        data.fill(fmt.filler);
        sectors.push({ c: cyl, h: head, r, n: sizeCode, st1: 0, st2: 0, data });
        sectorMap.set(r, i);
      }
      sides.push({ sectors, sectorMap, gap3: fmt.gap3, filler: fmt.filler });
    }
    tracks.push(sides);
  }

  const image: DskImage = {
    format: 'standard',
    numTracks: fmt.tracks,
    numSides: fmt.sides,
    tracks,
    diskFormat: '',
    protection: '',
  };
  image.diskFormat = detectDiskFormat(image);
  return image;
}

// ── Format detection ────────────────────────────────────────────────────────

function detectDiskFormat(image: DskImage): string {
  const t0 = image.tracks[0]?.[0];
  if (!t0 || t0.sectors.length === 0) return 'Empty';

  const count = t0.sectors.length;
  const n = t0.sectors[0].n;
  const minR = Math.min(...t0.sectors.map(s => s.r));
  const ds = image.numSides === 2 ? ' DS' : '';

  if (count === 9 && n === 2) {
    if (minR === 0x01) return '+3DOS' + ds;
    if (minR === 0xC1) return 'CPC System' + ds;
    if (minR === 0x41) return 'CPC Data' + ds;
  }

  const bytes = n <= 8 ? 128 << n : 0;
  return `${count}×${bytes}b` + ds;
}

// ── Protection detection (ported from dskmanager-rust) ──────────────────────

/** Get track from side 0 by cylinder index. */
function trk(image: DskImage, cyl: number): DskTrack | null {
  return image.tracks[cyl]?.[0] ?? null;
}

/** Search for an ASCII pattern in a Uint8Array. */
function findPattern(data: Uint8Array, pattern: string): number {
  const pLen = pattern.length;
  if (pLen === 0 || data.length < pLen) return -1;
  outer: for (let i = 0; i <= data.length - pLen; i++) {
    for (let j = 0; j < pLen; j++) {
      if (data[i + j] !== pattern.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Search for a pattern across all sectors on side 0. */
function findSignatureInDisk(image: DskImage, pattern: string): string | null {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (let s = 0; s < track.sectors.length; s++) {
      const off = findPattern(track.sectors[s].data, pattern);
      if (off >= 0) return `T${t}/S${s} +${off}`;
    }
  }
  return null;
}

function isUniform(image: DskImage): boolean {
  const t0 = trk(image, 0);
  if (!t0) return true;
  const count = t0.sectors.length;
  const size = t0.sectors[0]?.data.length ?? 0;
  for (let t = 1; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    if (track.sectors.length !== count) return false;
    if (track.sectors[0]?.data.length !== size) return false;
  }
  return true;
}

function hasFdcErrors(image: DskImage): boolean {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (const s of track.sectors) {
      if (s.st1 !== 0 || s.st2 !== 0) return true;
    }
  }
  return false;
}

type Detector = (image: DskImage) => string | null;

const detectSpeedlock: Detector = (image) => {
  const sigs: [string, string][] = [
    ['Speedlock 1985', 'SPEEDLOCK PROTECTION SYSTEM (C) 1985 '],
    ['Speedlock 1986', 'SPEEDLOCK PROTECTION SYSTEM (C) 1986 '],
    ['Speedlock disc 1987', 'SPEEDLOCK DISC PROTECTION SYSTEMS COPYRIGHT 1987 '],
    ['Speedlock 1987 v2.1', 'SPEEDLOCK PROTECTION SYSTEM (C) 1987 D.LOOKER & D.AUBREY JONES : VERSION D/2.1'],
    ['Speedlock 1987', 'SPEEDLOCK PROTECTION SYSTEM (C) 1987 '],
    ['Speedlock +3 1987', 'SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1987 SPEEDLOCK ASSOCIATES'],
    ['Speedlock +3 1988', 'SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1988 SPEEDLOCK ASSOCIATES'],
    ['Speedlock 1988', 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1988 SPEEDLOCK ASSOCIATES'],
    ['Speedlock 1989', 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1989 SPEEDLOCK ASSOCIATES'],
    ['Speedlock 1990', 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1990 SPEEDLOCK ASSOCIATES'],
  ];
  for (const [name, pat] of sigs) {
    const loc = findSignatureInDisk(image, pat);
    if (loc) return `${name} (${loc})`;
  }
  // Unsigned Speedlock +3: T0=9 sectors, T1=5×1024b
  const t0 = trk(image, 0), t1 = trk(image, 1);
  if (t0?.sectors.length === 9 && t1?.sectors.length === 5 && t1.sectors[0]?.data.length === 1024) {
    const s6 = t0.sectors[6], s8 = t0.sectors[8];
    if (s6?.st2 === 0x40 && s8?.st2 === 0) return 'Speedlock +3 1987';
    if (s6?.st2 === 0x40 && s8?.st2 === 0x40) return 'Speedlock +3 1988';
  }
  // Unsigned Speedlock 1989/1990
  if (t0 && t0.sectors.length > 7 && image.numTracks > 40 && t1?.sectors.length === 1) {
    const s = t1.sectors[0];
    if (s.r === 0xC1 && s.st1 === 0x20) return 'Speedlock 1989/1990';
  }
  return null;
};

const detectAlkatraz: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0?.sectors[0]) return null;
  if (findPattern(t0.sectors[0].data, ' THE ALKATRAZ PROTECTION SYSTEM') >= 0) return 'Alkatraz +3';
  for (let t = 0; t < image.numTracks - 1; t++) {
    const track = trk(image, t);
    if (track?.sectors.length === 18 && track.sectors[0].data.length === 256) return 'Alkatraz CPC';
  }
  return null;
};

const detectHexagon: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0 || t0.sectors.length !== 10) return null;
  for (let t = 0; t < Math.min(4, image.numTracks); t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (const s of track.sectors) {
      if (findPattern(s.data, 'HEXAGON DISK PROTECTION') >= 0) return 'Hexagon';
      if (findPattern(s.data, 'HEXAGON Disk Protection') >= 0) return 'Hexagon';
    }
  }
  return null;
};

const detectPaulOwens: Detector = (image) => {
  const t0 = trk(image, 0), t1 = trk(image, 1);
  if (!t0 || t0.sectors.length !== 9 || !t1 || t1.sectors.length !== 0) return null;
  if (t0.sectors[2] && findPattern(t0.sectors[2].data, 'PAUL OWENS') >= 0) return 'Paul Owens';
  const t2 = trk(image, 2);
  if (t2?.sectors.length === 6 && t2.sectors[0]?.data.length === 256) return 'Paul Owens';
  return null;
};

const detectThreeInch: Detector = (image) => {
  const sig = 'Loader Copyright Three Inch Software 1988';
  const loc = findSignatureInDisk(image, sig);
  if (loc) return `Three Inch Loader (${loc})`;
  return null;
};

const detectFrontier: Detector = (image) => {
  const t1 = trk(image, 1);
  if (!t1 || t1.sectors.length === 0) return null;
  if (t1.sectors[0] && findPattern(t1.sectors[0].data, 'W DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT.') >= 0) return 'Frontier';
  return null;
};

const detectPms: Detector = (image) => {
  const t0s0 = trk(image, 0)?.sectors[0];
  if (!t0s0) return null;
  const sigs: [string, string][] = [
    ['P.M.S. 1986', '[C] P.M.S. 1986'],
    ['P.M.S. Loader 1986', 'P.M.S. LOADER [C]1986'],
    ['P.M.S. 1987', 'P.M.S.LOADER [C]1987'],
  ];
  for (const [name, pat] of sigs) {
    if (findPattern(t0s0.data, pat) >= 0) return name;
  }
  return null;
};

const detectWrm: Detector = (image) => {
  const t8 = trk(image, 8);
  if (!t8 || t8.sectors.length <= 9) return null;
  const s9 = t8.sectors[9];
  if (!s9 || s9.data.length <= 128) return null;
  if (findPattern(s9.data, 'W.R.M Disc') === 0 && findPattern(s9.data, 'Protection') >= 0) return 'W.R.M Disc Protection';
  return null;
};

const detectHerbulot: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0) return null;
  for (const s of t0.sectors) {
    if (findPattern(s.data, 'PROTECTION') >= 0 && findPattern(s.data, 'Remi HERBULOT') >= 0) return 'ERE/Remi HERBULOT';
  }
  return null;
};

const detectKbi: Detector = (image) => {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track?.sectors.length === 19) return 'KBI-19';
  }
  if (image.numTracks >= 40) {
    const t38 = trk(image, 38), t39 = trk(image, 39);
    if (t38?.sectors.length === 9 && t39?.sectors.length === 10) {
      const s9 = t39.sectors[9];
      if (s9?.st1 === 0x20 && s9.st2 === 0x20) return 'KBI-10';
    }
  }
  return null;
};

const detectPlayers: Detector = (image) => {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track?.sectors.length !== 16) continue;
    if (track.sectors.every((s, i) => s.r === i && s.n === i)) return 'Players';
  }
  return null;
};

const detectInfogrames: Detector = (image) => {
  if (image.numTracks <= 39) return null;
  const t39 = trk(image, 39);
  if (t39?.sectors.length !== 9) return null;
  for (const s of t39.sectors) {
    if (s.n === 2 && s.data.length === 540) return 'Infogrames/Logiciel';
  }
  return null;
};

const detectRainbowArts: Detector = (image) => {
  if (image.numTracks <= 40) return null;
  const t40 = trk(image, 40);
  if (t40?.sectors.length !== 9) return null;
  for (const s of t40.sectors) {
    if (s.r === 0xC6 && s.st1 === 0x20 && s.st2 === 0x20) return 'Rainbow Arts';
  }
  return null;
};

const detectDiscsys: Detector = (image) => {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track?.sectors.length !== 16) continue;
    if (track.sectors.every((s, i) => s.c === i && s.h === i && s.r === i && s.n === i)) return 'DiscSYS';
  }
  return null;
};

const detectArmourloc: Detector = (image) => {
  const t0 = trk(image, 0);
  if (t0?.sectors.length !== 9) return null;
  if (t0.sectors[0] && findPattern(t0.sectors[0].data, '0K free') === 2) return 'ARMOURLOC';
  return null;
};

const DETECTORS: Detector[] = [
  detectAlkatraz, detectFrontier, detectHexagon, detectPaulOwens,
  detectSpeedlock, detectThreeInch, detectWrm, detectPms,
  detectPlayers, detectInfogrames, detectRainbowArts, detectHerbulot,
  detectKbi, detectDiscsys, detectArmourloc,
];

function detectProtection(image: DskImage): string {
  if (image.numTracks < 2) return '';
  const t0 = trk(image, 0);
  if (!t0 || t0.sectors.length < 1 || t0.sectors[0].data.length < 128) return '';

  const uniform = isUniform(image);
  const errors = hasFdcErrors(image);
  if (uniform && !errors) return '';

  for (const detect of DETECTORS) {
    const result = detect(image);
    if (result) return result;
  }

  if (!uniform && errors) return 'Unknown';
  return '';
}
