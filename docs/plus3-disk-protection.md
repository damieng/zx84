# ZX Spectrum +3 Disk Copy Protection

Notes on protection schemes detected and/or emulated in zx84.

---

## Architecture Overview

There are two layers that together handle protected disks:

**DSK Parser (`src/plus3/dsk.ts`)** — Loads the `.dsk` image and detects the protection scheme. Stores per-sector FDC status bytes (ST1, ST2) from the Extended DSK format, which encode intentional errors. Also detects disk format (`+3DOS`, `CPC System`, etc.) and appends a human-readable protection name to `DskImage.protection`.

**FDC Emulator (`src/cores/upd765a.ts`)** — Emulates the uPD765A. When serving sectors, it preserves ST1/ST2 error flags exactly as stored in the image, implements weak-sector randomisation, and can reconstruct a full raw track (with gaps, sync bytes, address marks, and CRCs) for `READ_TRACK` commands.

A BIOS trap layer (`src/plus3/plus3dos-trap.ts`) intercepts standard `+3DOS` ROM calls for unprotected software to avoid unnecessary FDC overhead, but protected disks go through the full FDC path.

---

## What We Emulate

### 1. ST1/ST2 Error Flags

Extended DSK format stores a `st1` and `st2` byte per sector in the Sector Info Block. These encode the FDC result codes the original disk hardware produced:

| Flag | Meaning |
|------|---------|
| ST1 bit 5 (`0x20`) | CRC error in ID field |
| ST2 bit 5 (`0x20`) | CRC error in data field / weak sector |
| ST2 bit 6 (`0x40`) | Control mark (deleted data address mark) |

We copy these verbatim into the FDC result phase bytes. Protection loaders that probe for specific error codes get the right answer.

### 2. Weak Sectors

When `ST2 & 0x20` is set on a sector, the original disk had a deliberately bad data CRC. Each physical read of such a sector returns different (random) data. Speedlock and similar schemes read the sector twice and verify the two reads differ — a copy would produce identical data.

We implement this by making a copy of the sector buffer and randomising ~10% of bytes at random positions before returning it. Each `READ_DATA` call that hits a weak sector gets a fresh randomisation.

### 3. Raw Track Reconstruction (`READ_TRACK`)

Some protection code uses the `READ_TRACK` FDC command to read the entire physical track and inspect the formatting. We reconstruct it byte-accurately:

- Gap 4a (80 × `0x4E`)
- Sync + Index AM (`0xC2 0xC2 0xC2 0xFC`)
- Gap 1 (50 × `0x4E`)
- For each sector:
  - Sync + ID AM (`0xA1 0xA1 0xA1 0xFE`)
  - CHRN bytes
  - CRC-16-CCITT over preamble + ID field
  - Gap 2 (22 × `0x4E`)
  - Sync + Data AM (`0xA1 0xA1 0xA1` + `0xFB` normal / `0xF8` deleted)
  - Sector data (actual stored length, not `128 << N` — this is what makes overlapping sectors work)
  - CRC-16-CCITT over preamble + data
  - Gap 3 (taken from `track.gap3`, default 24)
- Gap 4b (pad to 6250 bytes)

The deleted-data mark (`0xF8`) is selected when `ST2 & 0x40`. Gap 3 comes from the track metadata in the Extended DSK header, so tracks with unusual inter-sector gaps are reproduced correctly.

### 4. Overlapping Sectors

Some protections store a sector whose physical data is shorter than its N code claims (e.g. N=2 means 512 bytes, but only 256 bytes are stored). When we write this to the raw track, the next sector ID appears earlier than the controller expects. Extended DSK preserves the actual data length; we output it as-is. Standard DSK enforces `128 << N` and cannot represent this.

---

## Protection Detection

`detectProtection()` in `dsk.ts` runs 15 detectors in order. It first skips the whole pass when the disk is uniform (all tracks same structure, no FDC errors) — ordinary commercial software has no protection.

Detection is for display/information only; the emulation works regardless of whether a name is found.

### Detectors (in priority order)

| Name | Key Heuristic |
|------|--------------|
| **Alkatraz** | String `" THE ALKATRAZ PROTECTION SYSTEM"` in T0S0; or 18×256-byte sectors/track (CPC variant) |
| **Frontier** | String `"W DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT."` in T1S0 |
| **Hexagon** | 10 sectors/track; string `"HEXAGON DISK PROTECTION"` or `"HEXAGON Disk Protection"` in first 4 tracks |
| **Paul Owens** | T0=9 sectors, T1 empty; or string `"PAUL OWENS"` in T0S2; or T2 with 6×256-byte sectors |
| **Speedlock** | See below |
| **Three Inch** | String `"Loader Copyright Three Inch Software 1988"` anywhere |
| **W.R.M.** | T8 has >9 sectors; sector 9 starts `"W.R.M Disc"` and contains `"Protection"` |
| **P.M.S.** | T0S0 contains one of: `"[C] P.M.S. 1986"`, `"P.M.S. LOADER [C]1986"`, `"P.M.S.LOADER [C]1987"` |
| **Players** | All tracks have 16 sectors where `sector[i].r == i` and `sector[i].n == i` |
| **Infogrames** | Disk >39 tracks; T39 has 9 sectors, N=2, actual data length = 540 |
| **Rainbow Arts** | Disk >40 tracks; T40 has a sector with R=`0xC6`, ST1=`0x20`, ST2=`0x20` |
| **Herbulot (ERE)** | T0 contains both `"PROTECTION"` and `"Remi HERBULOT"` |
| **KBI** | Any track with 19 sectors → "KBI-19"; T38=9/T39=10 sectors with specific ST flags → "KBI-10" |
| **DiscSYS** | All tracks have 16 sectors where C=H=R=N=track index |
| **ARMOURLOC** | T0S0, offset 2, contains `"0K free"` |

---

## Speedlock

Speedlock is the most common +3 protection and the one we've confirmed working end-to-end.

### Detection

Three strategies, tried in order:

**1. Signature scan** — searches all sectors for ASCII copyright strings:

| Detected Name | Signature |
|---------------|-----------|
| `Speedlock 1985` | `SPEEDLOCK PROTECTION SYSTEM (C) 1985 ` |
| `Speedlock 1986` | `SPEEDLOCK PROTECTION SYSTEM (C) 1986 ` |
| `Speedlock disc 1987` | `SPEEDLOCK DISC PROTECTION SYSTEMS COPYRIGHT 1987 ` |
| `Speedlock 1987 v2.1` | `SPEEDLOCK PROTECTION SYSTEM (C) 1987 D.LOOKER & D.AUBREY JONES : VERSION D/2.1` |
| `Speedlock 1987` | `SPEEDLOCK PROTECTION SYSTEM (C) 1987 ` |
| `Speedlock +3 1987` | `SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1987 SPEEDLOCK ASSOCIATES` |
| `Speedlock +3 1988` | `SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1988 SPEEDLOCK ASSOCIATES` |
| `Speedlock 1988` | `SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1988 SPEEDLOCK ASSOCIATES` |
| `Speedlock 1989` | `SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1989 SPEEDLOCK ASSOCIATES` |
| `Speedlock 1990` | `SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1990 SPEEDLOCK ASSOCIATES` |

Result is reported as `"${name} (T${track}/S${sector} +${offset})"`.

**2. Unsigned Speedlock +3 (no signature stored on disk)**

- T0 has exactly 9 sectors
- T1 has exactly 5 sectors, each N=2 (1024 bytes)
- Sector 6 ST2=`0x40`, Sector 8 ST2=`0x40` → `"Speedlock +3 1988"`
- Sector 6 ST2=`0x40`, Sector 8 ST2=`0x00` → `"Speedlock +3 1987"`

**3. Unsigned Speedlock 1989/1990**

- T0 has >7 sectors
- Disk has >40 tracks
- T1 has exactly 1 sector, R=`0xC1`, ST1=`0x20` (ID Not Found)

### How Speedlock +3 Works

The Speedlock +3 scheme stores the game in normal +3DOS sectors but protects it with a custom boot track and a verification routine that the game loader runs before handing off:

1. **Custom boot track (T0):** Standard 9-sector +3DOS track so the ROM can load the bootstrap. The bootstrap is the Speedlock loader itself.

2. **Protection track (T1):** 5 sectors of 1024 bytes. Some sectors carry the `0x40` ST2 flag (deleted data address mark / control mark). The loader reads these back and checks the control mark is present — a straightforward copy that doesn't preserve `ST2` will fail this.

3. **Weak-sector check:** The protection track also contains at least one weak sector (`ST2 & 0x20`). The loader reads it twice and asserts the two reads differ. Bit-perfect copies have identical reads.

4. **Raw track verification:** The loader issues a `READ_TRACK` command and inspects the raw bytes — gap sizes, sync patterns, CRC values — to confirm the track layout matches the original. Our raw track builder reproduces this faithfully, including the correct Gap 3 size from the DSK metadata.

### Status: Working

Confirmed working for Speedlock +3 1987 and 1988 variants. The combination of correct ST2 flag propagation, weak-sector randomisation, and authentic raw track reconstruction is sufficient for the protection to pass.

---

## Tape Loader Detection (related)

Early Speedlock (tape-based) and other custom loaders are detected in `src/tape/loader-detect.ts` by watching for tight `IN (0xFE)` polling loops (B register changing by ±1 within 500 T-states). This triggers auto-start of the tape, avoiding the need for the user to manually press play.

---

## File Map

| File | Role |
|------|------|
| `src/plus3/dsk.ts` | DSK parser, format detection, 15 protection detectors |
| `src/cores/upd765a.ts` | uPD765A FDC — sector serving, weak sectors, raw track, CRC |
| `src/plus3/plus3dos-trap.ts` | BIOS trap for unprotected +3DOS I/O |
| `src/tape/loader-detect.ts` | Tape custom loader / Speedlock tape detection |
| `src/managers/media-manager.ts` | Disk file loading, IndexedDB persistence |
| `src/components/panes/DrivePane.tsx` | Drive UI, shows format + protection name |
