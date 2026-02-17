#!/usr/bin/env node
/**
 * Quick Protection Check - Identifies copy protection schemes in DSK files
 *
 * Usage: node check-protection.js <disk.dsk>
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

function findPattern(data, pattern) {
  const pLen = pattern.length;
  if (pLen === 0 || data.length < pLen) return -1;
  for (let i = 0; i <= data.length - pLen; i++) {
    let match = true;
    for (let j = 0; j < pLen; j++) {
      if (data[i + j] !== pattern.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// ── Minimal Track Parser ───────────────────────────────────────────────────

function parseTrack(data, trackOffset, trackSize, isExtended) {
  if (trackSize < 256) return null;

  const magic = asciiAt(data, trackOffset, 12);
  if (!magic.startsWith('Track-Info')) return null;

  const sectorCount = data[trackOffset + 0x15];
  const sectors = [];

  for (let i = 0; i < sectorCount; i++) {
    const sibOffset = trackOffset + 0x18 + i * 8;
    const r = data[sibOffset + 2];
    sectors.push({ r });
  }

  return { sectors };
}

function getSector0Data(data, trackOffset, trackSize, isExtended) {
  if (trackSize < 256) return null;

  const magic = asciiAt(data, trackOffset, 12);
  if (!magic.startsWith('Track-Info')) return null;

  const sectorCount = data[trackOffset + 0x15];
  if (sectorCount === 0) return null;

  const sibOffset = trackOffset + 0x18; // First sector
  const n = data[sibOffset + 3];
  const sibDataLen = u16LE(data, sibOffset + 6);

  let actualSize;
  if (isExtended && sibDataLen > 0) {
    actualSize = sibDataLen;
  } else {
    actualSize = n <= 5 ? (128 << n) : n === 6 ? 6144 : 0;
  }

  const dataOffset = trackOffset + 0x100;
  if (dataOffset + actualSize > data.length) return null;

  return data.slice(dataOffset, dataOffset + actualSize);
}

// ── Main ────────────────────────────────────────────────────────────────────

function checkProtection(dskPath) {
  if (!fs.existsSync(dskPath)) {
    console.error(`❌ File not found: ${dskPath}`);
    process.exit(1);
  }

  const data = fs.readFileSync(dskPath);

  if (data.length < 256) {
    console.error('❌ DSK file too small');
    process.exit(1);
  }

  const magic = asciiAt(data, 0, 8);
  let isExtended;
  if (magic === 'EXTENDED') {
    isExtended = true;
  } else if (magic === 'MV - CPC') {
    isExtended = false;
  } else {
    console.error('❌ Not a valid DSK file');
    process.exit(1);
  }

  const numTracks = data[0x30];
  const numSides = data[0x31];

  console.log(`\n📀 DSK File: ${path.basename(dskPath)}`);
  console.log(`   Format: ${magic}`);
  console.log(`   Tracks: ${numTracks}  Sides: ${numSides}`);

  // Get track 0 size
  let trackSize;
  if (isExtended) {
    trackSize = data[0x34] * 256;
  } else {
    trackSize = u16LE(data, 0x32);
  }

  // Parse track 0
  const track0 = parseTrack(data, 256, trackSize, isExtended);
  const sector0Data = getSector0Data(data, 256, trackSize, isExtended);

  if (!track0 || !sector0Data) {
    console.log('\n⚠️  Cannot read track 0');
    process.exit(0);
  }

  console.log(`\n🔍 Track 0 Analysis:`);
  console.log(`   Sectors: ${track0.sectors.length}`);

  // Check sector ID pattern
  const rValues = track0.sectors.map(s => s.r);
  const isSequential = rValues.every((r, i) => r === i + 1);

  console.log(`   Sector IDs: ${rValues.map(r => r.toString(16).toUpperCase()).join(', ')}`);

  if (!isSequential) {
    console.log(`   ⚠️  NON-SEQUENTIAL sector IDs detected!`);
  }

  // Check for Alkatraz signature
  const alkatrazSig = ' THE ALKATRAZ PROTECTION SYSTEM';
  const alkatrazPos = findPattern(sector0Data, alkatrazSig);

  if (alkatrazPos >= 0) {
    console.log(`\n🔒 Protection Detected: ALKATRAZ +3`);
    console.log(`   Signature found at offset 0x${alkatrazPos.toString(16).toUpperCase()}`);
    console.log(`   This disk uses offset sectors for copy protection.`);
  } else {
    // Check for other common protections
    const speedlockSigs = [
      'SPEEDLOCK PROTECTION SYSTEM',
      'SPEEDLOCK DISC PROTECTION',
      'SPEEDLOCK +3 DISC PROTECTION',
    ];

    let foundProtection = false;
    for (const sig of speedlockSigs) {
      if (findPattern(sector0Data, sig) >= 0) {
        console.log(`\n🔒 Protection Detected: SPEEDLOCK`);
        foundProtection = true;
        break;
      }
    }

    if (!foundProtection) {
      if (!isSequential) {
        console.log(`\n🔒 Protection Detected: UNKNOWN (offset sectors)`);
        console.log(`   Non-standard sector numbering suggests copy protection.`);
      } else {
        console.log(`\n✅ No obvious copy protection detected`);
        console.log(`   (This doesn't rule out other protection methods)`);
      }
    }
  }

  // Show detailed sector info if non-standard
  if (!isSequential) {
    console.log(`\n📊 Detailed Sector Map:`);
    track0.sectors.forEach((s, idx) => {
      const expected = idx + 1;
      const marker = s.r !== expected ? ' ← OFFSET' : '';
      console.log(`   [${idx}] R=${s.r.toString().padStart(2)} (expected ${expected})${marker}`);
    });
  }

  console.log('');
}

// ── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.length < 3 || process.argv[2] === '--help' || process.argv[2] === '-h') {
  console.log('Usage: node check-protection.js <disk.dsk>');
  console.log('');
  console.log('Quickly identifies copy protection schemes in DSK files.');
  console.log('');
  console.log('Example:');
  console.log('  node check-protection.js california-games.dsk');
  process.exit(0);
}

checkProtection(process.argv[2]);
