#!/usr/bin/env node
/**
 * DSK Track Examiner - Displays sector CHRN values for a given track
 *
 * Usage: node examine-dsk.js <disk.dsk> [track] [side]
 *
 * Default: track=0, side=0
 */

const fs = require('fs');
const path = require('path');

// ── Helpers ─────────────────────────────────────────────────────────────────

function u16LE(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

function asciiAt(data, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[offset + i]);
  return s;
}

// ── Track parser ────────────────────────────────────────────────────────────

function parseTrack(data, trackOffset, trackSize, isExtended) {
  if (trackSize < 256) return null;

  const magic = asciiAt(data, trackOffset, 12);
  if (!magic.startsWith('Track-Info')) return null;

  const trackNum = data[trackOffset + 0x10];
  const sideNum = data[trackOffset + 0x11];
  const sectorCount = data[trackOffset + 0x15];
  const gap3 = data[trackOffset + 0x16];
  const filler = data[trackOffset + 0x17];

  const sectors = [];

  for (let i = 0; i < sectorCount; i++) {
    const sibOffset = trackOffset + 0x18 + i * 8;
    const c = data[sibOffset];
    const h = data[sibOffset + 1];
    const r = data[sibOffset + 2];
    const n = data[sibOffset + 3];
    const st1 = data[sibOffset + 4];
    const st2 = data[sibOffset + 5];
    const sibDataLen = u16LE(data, sibOffset + 6);

    // Calculate actual size
    let actualSize;
    if (isExtended && sibDataLen > 0) {
      actualSize = sibDataLen;
    } else {
      actualSize = n <= 5 ? (128 << n) : n === 6 ? 6144 : 0;
    }

    sectors.push({ c, h, r, n, st1, st2, actualSize });
  }

  return {
    trackNum,
    sideNum,
    sectors,
    gap3,
    filler,
  };
}

// ── Main parser ─────────────────────────────────────────────────────────────

function parseDSK(data) {
  if (data.length < 256) throw new Error('DSK file too small');

  const magic = asciiAt(data, 0, 8);
  let isExtended;
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
  const trackSizes = [];

  if (isExtended) {
    for (let i = 0; i < totalTracks; i++) {
      trackSizes.push(data[0x34 + i] * 256);
    }
  } else {
    const fixedSize = u16LE(data, 0x32);
    for (let i = 0; i < totalTracks; i++) {
      trackSizes.push(fixedSize);
    }
  }

  // Parse tracks
  const tracks = [];
  let offset = 256;

  for (let t = 0; t < numTracks; t++) {
    tracks[t] = [];
    for (let s = 0; s < numSides; s++) {
      const idx = t * numSides + s;
      const size = trackSizes[idx];
      if (size === 0) {
        tracks[t][s] = null;
        continue;
      }
      tracks[t][s] = parseTrack(data, offset, size, isExtended);
      offset += size;
    }
  }

  return {
    format: isExtended ? 'EXTENDED' : 'MV - CPC',
    numTracks,
    numSides,
    tracks,
  };
}

// ── Display functions ───────────────────────────────────────────────────────

function displayTrack(track, trackNum, sideNum) {
  if (!track) {
    console.log(`\nTrack ${trackNum} Side ${sideNum}: Unformatted`);
    return;
  }

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Track ${trackNum.toString().padStart(2)} / Side ${sideNum}  -  ${track.sectors.length} sectors                       ║`);
  console.log(`╠════╦═══╦═══╦═══╦═══╦═══════╦═══════╦═══════════════════════╣`);
  console.log(`║ ## ║ C ║ H ║ R ║ N ║  ST1  ║  ST2  ║  Size                 ║`);
  console.log(`╠════╬═══╬═══╬═══╬═══╬═══════╬═══════╬═══════════════════════╣`);

  let hasNonStandardR = false;
  let expectedR = 1; // Standard numbering starts at 1

  track.sectors.forEach((s, idx) => {
    const sizeBytes = s.actualSize;
    const sizePart = `${sizeBytes}b`;

    const st1Str = s.st1 === 0 ? '  -   ' : `0x${s.st1.toString(16).padStart(2, '0').toUpperCase()}`;
    const st2Str = s.st2 === 0 ? '  -   ' : `0x${s.st2.toString(16).padStart(2, '0').toUpperCase()}`;

    // Check if R value is non-standard
    const isNonStandard = s.r !== expectedR;
    if (isNonStandard) hasNonStandardR = true;

    const marker = isNonStandard ? ' ← OFFSET' : '';

    console.log(`║ ${idx.toString().padStart(2)} ║ ${s.c.toString().padStart(2)} ║ ${s.h.toString().padStart(2)} ║ ${s.r.toString(16).toUpperCase().padStart(2)} ║ ${s.n.toString().padStart(2)} ║ ${st1Str} ║ ${st2Str} ║  ${sizePart.padEnd(8)} ${marker.padEnd(10)} ║`);

    expectedR++;
  });

  console.log(`╚════╩═══╩═══╩═══╩═══╩═══════╩═══════╩═══════════════════════╝`);
  console.log(`GAP3: ${track.gap3}  Filler: 0x${track.filler.toString(16).toUpperCase().padStart(2, '0')}`);

  if (hasNonStandardR) {
    console.log(`\n⚠️  NON-STANDARD SECTOR IDs DETECTED!`);
    console.log(`    Expected sequential R values (1,2,3...) but found offset values.`);
    console.log(`    This is likely copy protection (e.g., Alkatraz).`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: node examine-dsk.js <disk.dsk> [track] [side]');
    console.log('');
    console.log('Examples:');
    console.log('  node examine-dsk.js game.dsk           # Show track 0, side 0');
    console.log('  node examine-dsk.js game.dsk 1         # Show track 1, side 0');
    console.log('  node examine-dsk.js game.dsk 0 1       # Show track 0, side 1');
    process.exit(0);
  }

  const dskPath = args[0];
  const requestedTrack = args[1] ? parseInt(args[1]) : 0;
  const requestedSide = args[2] ? parseInt(args[2]) : 0;

  if (!fs.existsSync(dskPath)) {
    console.error(`Error: File not found: ${dskPath}`);
    process.exit(1);
  }

  const data = fs.readFileSync(dskPath);

  try {
    const dsk = parseDSK(data);

    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(`  DSK File: ${path.basename(dskPath)}`);
    console.log(`  Format: ${dsk.format}`);
    console.log(`  Tracks: ${dsk.numTracks}  Sides: ${dsk.numSides}`);
    console.log(`═══════════════════════════════════════════════════════════════`);

    if (requestedTrack >= dsk.numTracks) {
      console.error(`\nError: Track ${requestedTrack} out of range (0-${dsk.numTracks - 1})`);
      process.exit(1);
    }

    if (requestedSide >= dsk.numSides) {
      console.error(`\nError: Side ${requestedSide} out of range (0-${dsk.numSides - 1})`);
      process.exit(1);
    }

    const track = dsk.tracks[requestedTrack][requestedSide];
    displayTrack(track, requestedTrack, requestedSide);

  } catch (error) {
    console.error(`Error parsing DSK: ${error.message}`);
    process.exit(1);
  }
}

main();
