# Disk Analysis Tools

Command-line utilities for examining ZX Spectrum +3 disk images and identifying copy protection schemes.

## Quick Start

### Check if a disk is protected

```bash
node tools/check-dsk-protection.js game.dsk
```

Example output:
```
📀 DSK File: california-games.dsk
   Format: EXTENDED
   Tracks: 40  Sides: 1

🔍 Track 0 Analysis:
   Sectors: 9
   Sector IDs: 1, 3, 5, 7, 9, B, D, F, 11
   ⚠️  NON-SEQUENTIAL sector IDs detected!

🔒 Protection Detected: ALKATRAZ +3
   Signature found at offset 0x1A
   This disk uses offset sectors for copy protection.
```

### Examine track details

```bash
node examine-dsk.js game.dsk
```

Example output:
```
╔════════════════════════════════════════════════════════════╗
║  Track  0 / Side 0  -  9 sectors                           ║
╠════╦═══╦═══╦═══╦═══╦═══════╦═══════╦═══════════════════════╣
║ ## ║ C ║ H ║ R ║ N ║  ST1  ║  ST2  ║  Size                 ║
╠════╬═══╬═══╬═══╬═══╬═══════╬═══════╬═══════════════════════╣
║  0 ║  0 ║  0 ║ 01 ║  2 ║   -   ║   -   ║  512b                 ║
║  1 ║  0 ║  0 ║ 03 ║  2 ║   -   ║   -   ║  512b      ← OFFSET ║
║  2 ║  0 ║  0 ║ 05 ║  2 ║   -   ║   -   ║  512b      ← OFFSET ║
...

⚠️  NON-STANDARD SECTOR IDs DETECTED!
```

## Tools

### 1. `check-protection.js`

**Purpose:** Quickly identify copy protection schemes

**Usage:**
```bash
node check-protection.js <disk.dsk>
```

**Detects:**
- Alkatraz +3 (signature + offset sectors)
- Speedlock (signature variants)
- Unknown protections (non-standard sector numbering)

**Output:**
- Disk format and geometry
- Sector ID pattern
- Protection scheme name (if recognized)
- Detailed sector mapping for non-standard layouts

---

### 2. `examine-dsk.js`

**Purpose:** Detailed sector-level examination

**Usage:**
```bash
node examine-dsk.js <disk.dsk> [track] [side]
```

**Parameters:**
- `track` - Track number to examine (default: 0)
- `side` - Side number to examine (default: 0)

**Examples:**
```bash
node examine-dsk.js game.dsk        # Track 0, side 0
node examine-dsk.js game.dsk 1      # Track 1, side 0
node examine-dsk.js game.dsk 0 1    # Track 0, side 1
```

**Output:**
- Complete CHRN values for each sector
- Sector sizes (actual bytes stored)
- ST1/ST2 error flags (for weak sectors, CRC errors)
- Gap3 and filler byte values
- Highlights offset sectors

---

## Understanding Sector IDs

### CHRN Values

Each sector has four identification values:

- **C** (Cylinder) - Track number (0-79)
- **H** (Head) - Side number (0-1)
- **R** (Record) - Sector ID number
- **N** (Size code) - 0=128b, 1=256b, 2=512b, 3=1024b

### Normal Disks

Standard +3DOS disks have sequential sector IDs:

| Sector # | C | H | R | N |
|----------|---|---|---|---|
| 0        | 0 | 0 | 1 | 2 |
| 1        | 0 | 0 | 2 | 2 |
| 2        | 0 | 0 | 3 | 2 |
| ...      |...|...|...|...|
| 8        | 0 | 0 | 9 | 2 |

### Protected Disks (Alkatraz)

Protected disks use non-sequential R values:

| Sector # | C | H | R  | N |
|----------|---|---|----|---|
| 0        | 0 | 0 | 1  | 2 |
| 1        | 0 | 0 | 3  | 2 | ← Skipped R=2
| 2        | 0 | 0 | 5  | 2 | ← Skipped R=4
| 3        | 0 | 0 | 7  | 2 | ← Skipped R=6
| ...      |...|...| ...|...|

### Why This Works as Protection

1. **Simple copiers** read sectors 0-8 sequentially
2. **Simple copiers** write them back with R=1,2,3,4,5,6,7,8,9
3. **Loader code** tries to read R=1,3,5,7,9,11,13,15,17
4. **FDC returns error** "Sector Not Found" for R=3,5,7...
5. **Game fails to load**

### How Emulator Handles This

The FDC emulation (`src/cores/upd765a.ts`) uses a **sector map** to look up sectors by R value:

```typescript
const idx = track.sectorMap.get(r);  // Look up by R, not array index
```

This preserves the exact CHRN values from the DSK file, allowing protected disks to work correctly.

## Copy Protection Schemes

### Alkatraz +3

**Characteristics:**
- Signature string in sector 0: `" THE ALKATRAZ PROTECTION SYSTEM"`
- Offset sectors (non-sequential R values)
- Standard 9 sectors × 512 bytes
- No intentional read errors

**Detection:** Automatic in emulator

### Speedlock

**Characteristics:**
- Multiple signature variants (1985-1990)
- Weak sectors (ST2 bit 5 set)
- Variable sector counts per track
- Intentional CRC errors

**Detection:** Automatic in emulator

### Other Protections

The emulator also detects:
- Paul Owens
- Hexagon
- KBI-19/KBI-10
- Players
- Infogrames
- Rainbow Arts
- And more...

See `src/plus3/dsk.ts` for full list.

## File Formats

### Standard DSK

- Fixed sector sizes (128 << N bytes)
- May break protections using overlapping sectors
- Header: `"MV - CPC"`

### Extended DSK

- Variable sector sizes (preserves overlapping sectors)
- **Required** for most copy protection schemes
- Header: `"EXTENDED"`

**Always use Extended DSK format for protected disks!**

## Documentation

- **`DSK-ANALYSIS.md`** - In-depth guide to disk structure and protection
- **`FINDINGS.md`** - Complete analysis of California Games / Alkatraz protection
- **`src/plus3/dsk.ts`** - DSK parser source code with protection detection
- **`src/cores/upd765a.ts`** - FDC emulation source code

## Requirements

- Node.js (any recent version)
- No dependencies - uses only built-in modules

## License

These tools are part of the ZX84 emulator project. See main project README for license details.
