# California Games / Alkatraz Protection Analysis

## Summary

This document summarizes the findings about Alkatraz copy protection and how to examine disk images for non-standard sector IDs.

## Disk Image Location

**No disk images are stored in this repository.** The emulator loads .dsk files from the user's local filesystem via the file picker in the UI (`src/components/panes/LoadSavePane.tsx` and `DrivePane.tsx`).

You will need to obtain the California Games disk image separately to examine it.

## Analysis Tools Created

### 1. `check-protection.js` - Quick Protection Scanner

A fast tool to identify copy protection schemes:

```bash
node check-protection.js california-games.dsk
```

**Output:**
- DSK format and track/side count
- Sector ID pattern analysis
- Automatic detection of Alkatraz, Speedlock, and unknown protections
- Detailed offset sector mapping

**Use this first** to quickly check if a disk is protected.

### 2. `examine-dsk.js` - Detailed Sector Inspector

A comprehensive tool to examine track sector IDs:

```bash
node examine-dsk.js california-games.dsk        # Track 0, side 0
node examine-dsk.js california-games.dsk 1      # Track 1, side 0
node examine-dsk.js california-games.dsk 0 1    # Track 0, side 1
```

**Output format:**
- Displays all sectors with their **CHRN** values
- Highlights non-standard **R** values (offset sectors)
- Shows ST1/ST2 error flags
- Shows sector sizes and gap parameters

**Use this** for detailed track analysis and debugging.

### 3. `DSK-ANALYSIS.md` - Documentation

Complete guide to:
- Understanding CHRN sector addressing
- Identifying offset sectors
- Common Alkatraz patterns
- How the protection works

## How Alkatraz Protection Works

### Standard Sector Numbering

Normal disks use sequential sector IDs starting from 1:
```
Track 0: R = 1, 2, 3, 4, 5, 6, 7, 8, 9
```

### Alkatraz Offset Sectors

Protected disks use non-standard R values:
```
Track 0: R = 1, 3, 5, 7, 9, 11, 13, 15, 17  (odd numbers)
```

OR arbitrary values:
```
Track 0: R = 0x10, 0x20, 0x30, 0x40, ...
```

### Why This Works as Protection

1. **Simple disk copiers** read sectors sequentially (0,1,2,3...) and write them back with standard IDs (1,2,3,4...)
2. **The loader code** uses FDC READ SECTOR commands with specific R values to read
3. **If R values don't match**, the FDC returns "Sector Not Found" error
4. **Game fails to load** from copied disk

### Detection Signature

The emulator already detects Alkatraz protection in `src/plus3/dsk.ts`:

```typescript
const detectAlkatraz: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0?.sectors[0]) return null;

  // Check for signature string
  if (findPattern(t0.sectors[0].data, ' THE ALKATRAZ PROTECTION SYSTEM') >= 0)
    return 'Alkatraz +3';

  // Check for 18 sectors × 256 bytes (CPC variant)
  for (let t = 0; t < image.numTracks - 1; t++) {
    const track = trk(image, t);
    if (track?.sectors.length === 18 && track.sectors[0].data.length === 256)
      return 'Alkatraz CPC';
  }

  return null;
};
```

## FDC Emulation Analysis

The emulator's FDC implementation (`src/cores/upd765a.ts`) **correctly handles offset sectors**:

### Key Implementation Details

#### 1. Sector Lookup by R Value (Line 514)

```typescript
// Find starting sector by R value
const idx = track.sectorMap.get(r);
if (idx === undefined) {
  // Sector not found — No Data
  this.log(`  ✗ Sector R=${r} not found on track`);
  const st0 = ST0_ABNORMAL | (head << 2) | unit;
  this.result([st0, 0x04, 0x00, c, h, r, n]); // ST1=ND (bit 2)
  return;
}
```

**This is correct!** The FDC uses `track.sectorMap.get(r)` which:
- Maps R values → sector index
- Allows non-sequential R values
- Returns "Sector Not Found" if R doesn't exist

#### 2. Sector Map Creation (dsk.ts line 101)

```typescript
sectorMap.set(r, i);
```

Each sector's R value is mapped to its array index, preserving exact CHRN values from the DSK file.

#### 3. Multi-Sector Transfer (Line 299-324)

```typescript
private advanceSector(): boolean {
  this.exR++;  // Increment R
  if (this.exR > this.exEOT) return false;

  const idx = track.sectorMap.get(this.exR);
  if (idx === undefined) return false;
  // ...
}
```

**Potential Issue:** Multi-sector reads increment R by 1 (standard behavior), but Alkatraz may use non-sequential increments (1→3→5→7...). The loader probably reads sectors individually to avoid this.

#### 4. READ ID Command (Line 762-785)

```typescript
private cmdReadID(): void {
  // Cycle through sectors on repeated calls
  const idx = this.idIndex[unit] % track.sectors.length;
  this.idIndex[unit] = idx + 1;
  const sector = track.sectors[idx];

  this.log(`  → Returning sector ID: C=${sector.c} H=${sector.h} R=${sector.r} N=${sector.n}`);
  this.result([st0, 0x00, 0x00, sector.c, sector.h, sector.r, sector.n]);
}
```

**This is correct!** Returns actual CHRN values from the disk, allowing the loader to discover the non-standard sector numbering.

## What to Look For in California Games

When you examine the disk with `examine-dsk.js`, check for:

### 1. Sector ID Pattern (Track 0)

Expected for Alkatraz +3:
```
║ ## ║ C ║ H ║ R ║ N ║  ST1  ║  ST2  ║
║  0 ║  0 ║  0 ║ 01 ║  2 ║   -   ║   -   ║  ← Standard
║  1 ║  0 ║  0 ║ 03 ║  2 ║   -   ║   -   ║  ← OFFSET (skipped 2)
║  2 ║  0 ║  0 ║ 05 ║  2 ║   -   ║   -   ║  ← OFFSET
║  3 ║  0 ║  0 ║ 07 ║  2 ║   -   ║   -   ║  ← OFFSET
...
```

### 2. Signature String

First sector should contain:
```
" THE ALKATRAZ PROTECTION SYSTEM"
```

### 3. Track Layout

- **9 sectors per track** (standard +3DOS format)
- **512 bytes per sector** (N=2)
- **No ST1/ST2 error flags** (unlike Speedlock which uses intentional errors)

## Loader Behavior

The loader will:
1. Use **READ ID** commands to discover sector layout
2. Use **READ SECTOR** with explicit R values (e.g., R=1, then R=3, then R=5...)
3. **Verify** the signature string in the first sector
4. **Fail** if sectors don't match expected R values

## Emulator Compatibility

The emulator **should work correctly** with Alkatraz-protected disks because:

✅ **Sector lookup by R value** - Uses `sectorMap.get(r)` not array index
✅ **CHRN preservation** - DSK parser stores exact CHRN from file
✅ **READ ID support** - Returns actual sector IDs for discovery
✅ **Protection detection** - Identifies and logs Alkatraz disks

⚠️ **Potential limitation:** Multi-sector transfers increment R by 1, which won't work with offset sectors. Loader must read sectors individually.

## Next Steps

1. **Obtain California Games DSK file**

2. **Quick check for protection:**
   ```bash
   node check-protection.js california-games.dsk
   ```

3. **Detailed sector analysis:**
   ```bash
   node examine-dsk.js california-games.dsk
   ```

4. **Check output for:**
   - Non-sequential R values (e.g., 1, 3, 5, 7... instead of 1, 2, 3, 4...)
   - Alkatraz signature string presence
   - Sector count (should be 9) and sizes (should be 512 bytes)

5. **Test in emulator:**
   - Load the disk image via the UI
   - Check browser console for protection detection message
   - Verify game loads correctly

6. **If issues occur:**
   - Enable FDC debug logs in `src/cores/upd765a.ts` (line 73: `enableLogging = true`)
   - Look for "Sector not found" errors
   - Verify R values requested vs. available in the disk
   - Compare loader code disassembly with actual sector layout

## Files Created

- **`f:/src/zx84/check-protection.js`** - Quick protection identification tool
- **`f:/src/zx84/examine-dsk.js`** - Detailed sector examination tool
- **`f:/src/zx84/DSK-ANALYSIS.md`** - User guide for disk analysis
- **`f:/src/zx84/FINDINGS.md`** - This comprehensive summary document

## Relevant Source Files

- **`f:/src/zx84/src/plus3/dsk.ts`** - DSK parser with protection detection
- **`f:/src/zx84/src/cores/upd765a.ts`** - FDC emulation with sector handling
- **`f:/src/zx84/src/components/panes/DrivePane.tsx`** - Drive UI with disk info display
