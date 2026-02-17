# DSK Sector Analysis Tool

This document explains how to examine disk images for copy protection schemes like Alkatraz's "offset sectors".

## What are Offset Sectors?

On a normal disk, sectors on each track are numbered sequentially starting from 1:
- Track 0: Sectors R=1, 2, 3, 4, 5, 6, 7, 8, 9

Copy protection schemes like **Alkatraz** use non-standard sector numbering to prevent simple disk copying:
- Track 0: Sectors R=1, 3, 5, 7, 9, 11, 13, 15, 17 (odd numbers)
- Track 0: Sectors R=0x10, 0x20, 0x30, ... (arbitrary values)

The loader code then reads these sectors using their non-standard R values. If the disk has been copied without preserving the exact CHRN (Cylinder, Head, Record, N-size) values, the loader will fail.

## Understanding CHRN Values

Each sector on a disk has four identification values:

- **C (Cylinder)**: The track number (0-39 or 0-79)
- **H (Head)**: The side number (0 or 1)
- **R (Record)**: The sector ID - this is what protection checks!
- **N (Size code)**: The sector size (0=128b, 1=256b, 2=512b, 3=1024b, etc.)

## Using the Examination Tool

### Examine Track 0 of a Disk

```bash
node examine-dsk.js california-games.dsk
```

This will show you all sectors on track 0, side 0, with their CHRN values.

### Examine Other Tracks

```bash
node examine-dsk.js california-games.dsk 1      # Track 1, side 0
node examine-dsk.js california-games.dsk 0 1    # Track 0, side 1
```

## Example Output

### Standard Disk (No Protection)

```
╔════════════════════════════════════════════════════════════╗
║  Track  0 / Side 0  -  9 sectors                           ║
╠════╦═══╦═══╦═══╦═══╦═══════╦═══════╦═══════════════════════╣
║ ## ║ C ║ H ║ R ║ N ║  ST1  ║  ST2  ║  Size                 ║
╠════╬═══╬═══╬═══╬═══╬═══════╬═══════╬═══════════════════════╣
║  0 ║  0 ║  0 ║ 01 ║  2 ║   -   ║   -   ║  512b                 ║
║  1 ║  0 ║  0 ║ 02 ║  2 ║   -   ║   -   ║  512b                 ║
║  2 ║  0 ║  0 ║ 03 ║  2 ║   -   ║   -   ║  512b                 ║
...
```

### Protected Disk (Alkatraz)

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
    Expected sequential R values (1,2,3...) but found offset values.
    This is likely copy protection (e.g., Alkatraz).
```

## What to Look For

1. **Sequential R values (1,2,3,...)**: Normal disk, no sector-based protection
2. **Non-sequential R values**: Copy protection present
3. **ST1/ST2 error flags**: Additional protection using intentional read errors
4. **Unusual sector counts**: Some tracks may have more or fewer than 9 sectors

## Common Alkatraz Patterns

Based on the detection code in `src/plus3/dsk.ts`, Alkatraz protection typically shows:

1. **String signature**: "THE ALKATRAZ PROTECTION SYSTEM" in track 0, sector 0
2. **Offset sectors**: Non-standard R values on track 0
3. **Standard format**: Still uses 9 sectors × 512 bytes on track 0

## Integration with Emulator

The emulator's DSK parser already includes Alkatraz detection. See the `detectAlkatraz` function in `f:/src/zx84/src/plus3/dsk.ts`:

```typescript
const detectAlkatraz: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0?.sectors[0]) return null;
  if (findPattern(t0.sectors[0].data, ' THE ALKATRAZ PROTECTION SYSTEM') >= 0)
    return 'Alkatraz +3';
  // ... additional checks
};
```

## Next Steps

After examining your California Games disk:

1. Run the examination tool on track 0
2. Note any non-standard R values
3. Check if the signature string is present
4. Compare with the loader code to see which sectors it reads
5. Verify the emulator properly handles these non-standard sectors

The FDC emulation must:
- Preserve exact CHRN values from the DSK file
- Allow READ SECTOR commands to specify the R value to read
- Return the sector data that matches the requested R value, not the sequential position
