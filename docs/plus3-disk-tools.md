# ZX84 Disk Analysis Tools

Command-line utilities for examining ZX Spectrum +3 disk images. All tools are in the `tools/` directory and require only Node.js — no extra dependencies.

---

## Tools

### `check-dsk-protection.cjs` — Quick protection scanner

Identifies the copy protection scheme on a disk. Checks T0 sector IDs for non-sequential R values, searches for known signatures (Alkatraz, Speedlock), and reports what it finds.

**Usage:**
```
node tools/check-dsk-protection.cjs <disk.dsk>
```

**What it reports:**
- DSK format (EXTENDED or MV-CPC) and geometry (tracks × sides)
- T0 sector ID pattern (sequential or offset)
- Protection name if a known signature is found
- Detailed offset map when R values are non-sequential

**Example output (protected disk):**
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
```

**Limitations:**
- Only looks at T0 for sector ID patterns and T0S0 for signatures
- Does not scan T1+ for Speedlock unsigned variants
- Good for a quick first pass; use `examine-dsk.js` for deeper inspection

---

### `examine-dsk.cjs` — Detailed track inspector

Shows the full CHRN table, ST1/ST2 flags, actual data sizes, and gap parameters for any track on a disk. Use this when you need to understand the exact sector layout.

**Usage:**
```
node tools/examine-dsk.cjs <disk.dsk> [track] [side]
```

| Argument | Default | Description |
|---|---|---|
| `disk.dsk` | required | Path to the DSK file |
| `track` | 0 | Track number to inspect |
| `side` | 0 | Side number (0 or 1) |

**Examples:**
```bash
node tools/examine-dsk.cjs game.dsk          # Track 0, side 0
node tools/examine-dsk.cjs game.dsk 1        # Track 1, side 0
node tools/examine-dsk.cjs game.dsk 1 0      # Track 1, side 0 (explicit)
node tools/examine-dsk.cjs game.dsk 0 1      # Track 0, side 1
```

**Output format:**
```
═══════════════════════════════════════════════════════════════
  DSK File: game.dsk
  Format: EXTENDED
  Tracks: 40  Sides: 1
═══════════════════════════════════════════════════════════════

╔════════════════════════════════════════════════════════════╗
║  Track  1 / Side 0  -  5 sectors                           ║
╠════╦═══╦═══╦═══╦═══╦═══════╦═══════╦═══════════════════════╣
║ ## ║ C ║ H ║ R ║ N ║  ST1  ║  ST2  ║  Size                 ║
╠════╬═══╬═══╬═══╬═══╬═══════╬═══════╬═══════════════════════╣
║  0 ║  1 ║  0 ║ 01 ║  3 ║   -   ║ 0x40  ║  1024b               ║
║  1 ║  1 ║  0 ║ 02 ║  3 ║   -   ║ 0x20  ║  1024b               ║
...
╚════╩═══╩═══╩═══╩═══╩═══════╩═══════╩═══════════════════════╝
GAP3: 24  Filler: 0xE5
```

**Columns:**
- **##** — Sector index within the track (0-based)
- **C / H / R / N** — CHRN values as stored in the DSK
- **ST1 / ST2** — FDC status bytes (`-` means 0x00, i.e. no error)
- **Size** — Actual bytes stored (may differ from 128<<N for overlapping sectors)

Sectors with non-standard R values are flagged with `← OFFSET`.

---

### `disasm-sector.cjs` — Sector Z80 disassembler

Extracts sector data from a DSK image and Z80-disassembles it (or hex-dumps it). Useful for reverse-engineering boot sectors, protection loaders, and game code stored on disk.

**Usage:**
```
node tools/disasm-sector.cjs <disk.dsk> [options]
```

| Option | Default | Description |
|---|---|---|
| `--track N` | 0 | Track number |
| `--side N` | 0 | Side number |
| `--sectors R,...` | all | Hex R values to extract in order (e.g. `02,03,04`) |
| `--org NNNN` | `0000` | Load address (hex, no prefix) for disassembly |
| `--hex` | off | Hex dump instead of Z80 disassembly |
| `--skip N` | 0 | Skip first N bytes of combined sector data |
| `--count N` | all | Disassemble only N bytes |

**Examples:**
```bash
# Disassemble boot sector (T0/S0/R1) loaded at FE00
node tools/disasm-sector.cjs game.dsk --track 0 --sectors 01 --org FE00

# Hex dump the protection track
node tools/disasm-sector.cjs game.dsk --track 33 --hex

# Disassemble specific sectors from a custom track
node tools/disasm-sector.cjs game.dsk --track 1 --sectors 02,03,04 --org 0100
```

---

## Typical Workflows

### Identify protection before loading a disk

```bash
node tools/check-dsk-protection.cjs game.dsk
```

If protection is unknown or surprising, follow up with a track-by-track look.

### Examine the protection track

Speedlock +3 puts its protection on track 1:
```bash
node tools/examine-dsk.cjs game.dsk 1
```
Look for: 5 sectors, N=3 (1024 bytes), ST2=0x40 or ST2=0x20 flags.

### Check for extra tracks

Rainbow Arts and Infogrames use tracks beyond 39:
```bash
node tools/examine-dsk.cjs game.dsk 39
node tools/examine-dsk.cjs game.dsk 40
```

### Inspect both sides of a double-sided disk

```bash
node tools/examine-dsk.cjs game.dsk 0 0   # T0S0
node tools/examine-dsk.cjs game.dsk 0 1   # T0S1
```

---

## Reading the Output

### ST1 / ST2 flags

| Value | Meaning |
|---|---|
| `-` (0x00) | No error |
| `0x20` | CRC error (ST1: in ID field; ST2: in data field) |
| `0x40` | ST2 only — deleted data address mark (control mark) |
| `0x04` | ST1 — No Data (Sector Not Found) |

ST2=0x20 is the weak-sector marker: each real read of that sector returns different data.
ST2=0x40 means the sector was written with the deleted-DAM signal — some loaders check for this explicitly.

### Size vs N code

Normal sectors: `128 << N` bytes (N=2 → 512, N=3 → 1024).
If Size differs from `128 << N`, the DSK uses the Extended format's per-sector length field — this is an overlapping sector or Infogrames-style oversized sector.

### GAP3 / Filler

GAP3 is the inter-sector gap in bytes on the physical track. Standard +3DOS uses 82. Unusual values (e.g. 24 on Speedlock protection tracks) are significant: Speedlock's raw-track verification checks gap sizes. The emulator reads GAP3 from the DSK metadata and uses it when reconstructing tracks for READ_TRACK commands.

---

## DSK Format Notes

| Format | Header magic | Sector sizes | Use |
|---|---|---|---|
| Standard (MV-CPC) | `MV - CPC` | Fixed: `128 << N` | Unprotected disks |
| Extended | `EXTENDED` | Per-sector, arbitrary | Required for most protections |

Always use Extended DSK for protected disks. Standard DSK cannot represent overlapping sectors, weak sectors, or unusual data lengths.
