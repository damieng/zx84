# ZX Spectrum +3 Disk Copy Protection Reference

---

## FDC Emulation Capabilities

What the uPD765A emulation (`src/cores/upd765a.ts`) implements. These are the building blocks all protections rely on.

| Capability | Status | Notes |
|---|---|---|
| ST1/ST2 error flag preservation | ✅ | Returned verbatim in result phase |
| Weak sector randomisation | ✅ | ST2 & 0x20 → ~10% of bytes randomised per read |
| Deleted data address mark | ✅ | ST2 & 0x40 → 0xF8 DAM in raw track bytes |
| Non-sequential sector R values | ✅ | sectorMap lookup, not array index |
| READ_TRACK reconstruction | ✅ | Full gap/sync/AM/CRC layout |
| Gap 3 from DSK metadata | ✅ | Per-track value, not a fixed default |
| Overlapping sectors | ✅ | Outputs actual data length, not 128<<N |
| READ_ID sector cycling | ✅ | Cycles through sectors, returns real CHRN |
| CRC-16-CCITT in raw track | ✅ | Both ID-field and data-field CRCs |
| Variable per-sector data size | ✅ | Extended DSK format required |
| Multi-sector READ with offset R | ⚠️ | R increments by 1; offset-sector protections must read individually |

---

## Protection Schemes

---

### Speedlock

**Overview.** The most widely used +3 protection. Comes in many variants from 1985–1990. The +3 variants (1987, 1988) are the ones relevant to the Spectrum +3.

#### Recognition

Three detection strategies tried in order:

**1. Copyright string scan** — search every sector on the disk for:

| Name assigned | Signature text |
|---|---|
| Speedlock 1985 | `SPEEDLOCK PROTECTION SYSTEM (C) 1985 ` |
| Speedlock 1986 | `SPEEDLOCK PROTECTION SYSTEM (C) 1986 ` |
| Speedlock disc 1987 | `SPEEDLOCK DISC PROTECTION SYSTEMS COPYRIGHT 1987 ` |
| Speedlock 1987 v2.1 | `SPEEDLOCK PROTECTION SYSTEM (C) 1987 D.LOOKER & D.AUBREY JONES : VERSION D/2.1` |
| Speedlock 1987 | `SPEEDLOCK PROTECTION SYSTEM (C) 1987 ` |
| Speedlock +3 1987 | `SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1987 SPEEDLOCK ASSOCIATES` |
| Speedlock +3 1988 | `SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1988 SPEEDLOCK ASSOCIATES` |
| Speedlock 1988 | `SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1988 SPEEDLOCK ASSOCIATES` |
| Speedlock 1989 | `SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1989 SPEEDLOCK ASSOCIATES` |
| Speedlock 1990 | `SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1990 SPEEDLOCK ASSOCIATES` |

Result includes location: `"Speedlock +3 1988 (T1/S2 +0x1A0)"`.

**2. Unsigned Speedlock +3** (no signature on disk):
- T0: exactly 9 sectors (standard +3DOS boot track)
- T1: exactly 5 sectors, each N=2 (1024 bytes)
- T1 sector[5] ST2=0x40, sector[7] ST2=0x40 → "Speedlock +3 1988"
- T1 sector[5] ST2=0x40, sector[7] ST2=0x00 → "Speedlock +3 1987"

**3. Unsigned Speedlock 1989/1990**:
- T0 has >7 sectors, disk has >40 tracks
- T1 has exactly 1 sector, R=0xC1, ST1=0x20 (ID Not Found)

#### Characteristics

**T0** — Normal 9-sector +3DOS boot track. The +3 ROM loads the Speedlock bootstrap from here using standard BIOS calls.

**T1** — Protection track. 5 sectors of 1024 bytes (N=2). Some sectors have:
- ST2 & 0x40 (deleted data AM) — control mark the loader checks
- ST2 & 0x20 (data CRC error) — weak sector that must read differently each time

**T2 onwards** — Normal game data.

#### Protection Checks Performed by the Loader

1. **Deleted DAM check** — reads T1 sectors, verifies ST2 bit 6 is set on expected sectors
2. **Weak-sector double-read** — reads a weak sector twice, asserts the two buffers differ
3. **Raw track verify** — issues READ_TRACK on T1, inspects gap sizes, sync patterns, and CRC bytes

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_DATA | Normal game data + ST2 flag checks |
| READ_TRACK | Raw track verification of T1 |
| READ_ID | Sector discovery (possibly) |

#### Emulation Status

| Check | Status |
|---|---|
| ST2 control mark (0x40) returned correctly | ✅ |
| Weak sector randomisation (ST2 & 0x20) | ✅ |
| READ_TRACK with correct Gap 3 and DAM bytes | ✅ |
| End-to-end: Speedlock +3 1987 | ✅ Confirmed working |
| End-to-end: Speedlock +3 1988 | ✅ Confirmed working |
| Speedlock 1989/1990 (T1 single-sector variant) | 🔲 Not tested |
| Tape-era Speedlock | n/a (tape path, not disk) |

---

### Alkatraz

**Overview.** Protection by The Assembly Line. Uses non-sequential sector R values (offset sectors) as its primary trick. A naïve copier renumbers sectors 1–9 sequentially; the loader then asks for the original R values and gets Sector Not Found errors.

#### Recognition

- String `" THE ALKATRAZ PROTECTION SYSTEM"` in T0S0 data → "Alkatraz +3"
- 18 sectors × 256 bytes per track across the disk → "Alkatraz CPC"

#### Characteristics

Confirmed from California Games (Side A) — 42 tracks, single-sided:

- **T0–T32**: Standard 9-sector +3DOS tracks, R=1–9, no error flags. The Alkatraz signature string is embedded in T0S0 data at offset 0x140 (inside the +3DOS directory).
- **T33**: The protection track. 18 sectors, N=1 (256 bytes each). Every sector has **C=233 (0xE9)** in its ID — a value impossible on a real 40-track disk (physical cylinder ≤ 41). H values are also arbitrary non-standard values (0x00–0xF8). R values are unique per sector. No error flags.
- The loader seeks to T33 and issues READ_DATA with C=233, H=h, R=r matching the actual sector IDs. A copier that renormalises CHRN to C=33, H=0, R=1..9 will produce "sector not found" errors.
- Tracks T34–T41: Further game data (42 tracks total).
- **No intentional CRC errors** — the trick is the phantom CHRN values, not error flags.

#### Protection Checks Performed by the Loader

1. Uses READ_ID to discover the current sector R values on the track.
2. Issues READ_DATA with those specific R values.
3. If the R values have been renumbered by a copier, READ_DATA returns ST1 bit 2 (No Data / Sector Not Found) and loading fails.

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Discover the real R values on the track |
| READ_DATA | Load data using the discovered R values |

#### Emulation Status

| Check | Status |
|---|---|
| sectorMap lookup by R value (not array index) | ✅ |
| READ_ID returns actual CHRN from DSK | ✅ |
| Physical head taken from HU byte, not CHRN H field | ✅ Fixed — Alkatraz T33 uses H=24–240 in sector IDs on a 1-sided disk |
| Multi-sector transfers with offset R | ⚠️ R increments by 1; loader must read sectors individually |
| T33 sectors found and read (post head-fix) | ✅ Returns correct data, ST0/1/2=0, C=0xe9, H in result |
| Protection check passes end-to-end | 🔲 Loader loops 3× then fails — requires disassembly of T0 R=2–4 to understand verification logic |

#### T33 Sector Data Format

Each of the 18 sectors on T33 contains 256 bytes of a uniform single-byte value, different per sector. This is deliberate Alkatraz formatting:

| Sector | R | H | Fill byte |
|---|---|---|---|
| 0 | 0xF6 | 24 (0x18) | 0x51 |
| 1 | 0x3D | 104 (0x68) | 0xFF |
| 2 | 0x2B | 240 (0xF0) | 0x31 |
| 3 | 0x65 | 32 (0x20) | 0x0E |
| 4 | 0x0C | 144 (0x90) | 0xF1 |
| 5 | 0x64 | 72 (0x48) | 0x2A |
| 6 | 0x3A | 0 | 0x32 |
| 7 | 0x46 | 0 | 0x4E |
| 8 | 0x06 | 32 | 0x16 |
| 9 | 0x12 | 232 (0xE8) | 0x02 |
| 10 | 0x56 | 144 | 0xE4 |
| 11 | 0xC0 | 56 | 0x6D |
| 12 | 0x30 | 248 | 0x2E |
| 13 | 0x7A | 152 | 0xCC |
| 14 | 0xBC | 104 | 0xAF |
| 15 | 0xFB | 112 | 0x89 |
| 16 | 0xCD | 200 | 0x7C |
| 17 | 0x60 | 104 | 0xDB |

The protection loader (T0 R=2–4, encrypted) uses these values in its verification. **Needs disassembly** to determine exactly which sectors are read and what check is applied.

---

### Hexagon

**Overview.** Structured disk format with a distinctive sector count used as the protection signature.

#### Recognition

- 10 sectors per track (not the standard 9)
- One of these strings in the first 4 tracks: `"HEXAGON DISK PROTECTION"` or `"HEXAGON Disk Protection"`

#### Characteristics

- 10 sectors/track, otherwise standard geometry
- No CRC errors reported in the detection logic

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Discover 10-sector layout |
| READ_DATA | Load game data |

#### Emulation Status

| Check | Status |
|---|---|
| 10-sector tracks parsed correctly | ✅ |
| End-to-end tested | 🔲 Not confirmed |

---

### Paul Owens

**Overview.** Protection with a deliberately empty track 1 and/or a reduced-sector track 2.

#### Recognition

Any one of:
- T0=9 sectors, T1 is empty (0 sectors or unformatted)
- String `"PAUL OWENS"` in T0S2 data
- T2 has exactly 6 sectors of 256 bytes each (N=1)

#### Characteristics

- T1 is intentionally unformatted or absent. READ_DATA or READ_ID on T1 should yield no sectors / error.
- T2 may have non-standard sector count.

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Probe T1 for expected empty response |
| READ_DATA | Load data from T0 and T2+ |

#### Emulation Status

| Check | Status |
|---|---|
| Empty / unformatted tracks handled | ✅ (null track returns Sector Not Found) |
| End-to-end tested | 🔲 Not confirmed |

---

### Three Inch Software

**Overview.** Simple signature-based protection with no structural tricks beyond the loader code itself.

#### Recognition

- String `"Loader Copyright Three Inch Software 1988"` anywhere on the disk

#### Characteristics

- No unusual sector geometry or error flags identified in detection code.
- Likely uses a custom loader routine that checks for the signature.

#### FDC Commands Used

Unknown — needs disassembly.

#### Emulation Status

| Check | Status |
|---|---|
| Detected | ✅ |
| Mechanism understood | 🔲 |
| End-to-end tested | 🔲 |

---

### Frontier

**Overview.** Simple string-signature protection from New Frontier Software (1990).

#### Recognition

- String `"W DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT."` in T1S0 data

#### Characteristics

Unknown beyond the signature location. Needs examination.

#### FDC Commands Used

Unknown — needs disassembly.

#### Emulation Status

| Check | Status |
|---|---|
| Detected | ✅ |
| Mechanism understood | 🔲 |
| End-to-end tested | 🔲 |

---

### W.R.M.

**Overview.** Protection that exploits a track with more sectors than standard.

#### Recognition

- T8 has >9 sectors
- Sector at index 9 is >128 bytes
- That sector's data starts with `"W.R.M Disc"` and contains `"Protection"`

#### Characteristics

- Track 8 has at least 10 sectors — beyond the standard 9
- Sector 9 contains the identification string

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Detect extra sector on T8 |
| READ_DATA | Load the oversized track |

#### Emulation Status

| Check | Status |
|---|---|
| >9 sector tracks parsed | ✅ |
| End-to-end tested | 🔲 |

---

### P.M.S.

**Overview.** French protection from P.M.S. (1986–1987).

#### Recognition

T0S0 data contains one of:
- `"[C] P.M.S. 1986"`
- `"P.M.S. LOADER [C]1986"`
- `"P.M.S.LOADER [C]1987"`

#### Characteristics

Unknown beyond signature. Needs examination.

#### FDC Commands Used

Unknown — needs disassembly.

#### Emulation Status

| Check | Status |
|---|---|
| Detected | ✅ |
| Mechanism understood | 🔲 |
| End-to-end tested | 🔲 |

---

### Players

**Overview.** Unusual sector addressing scheme where R and N values match the sector index.

#### Recognition

- All tracks have 16 sectors
- `sector[i].r == i` and `sector[i].n == i` for each i

#### Characteristics

- 16 sectors per track
- R and N values are the track index — highly non-standard
- N values vary per sector, so sector sizes vary within a track

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Discover variable CHRN layout |
| READ_DATA | Read variable-size sectors |

#### Emulation Status

| Check | Status |
|---|---|
| Variable N per sector supported | ✅ (via Extended DSK data length field) |
| End-to-end tested | 🔲 |

---

### Infogrames / Logiciel

**Overview.** Protection using a sector with a deliberately over-size data field.

#### Recognition

- Disk has >39 tracks
- T39 has 9 sectors, N=2, but actual stored data length per sector = 540 bytes (28 bytes over the standard 512)

#### Characteristics

- Standard track geometry except for the oversized sector data on T39
- The extra bytes are only representable in Extended DSK format

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_DATA | Read oversized sector on T39 |

#### Emulation Status

| Check | Status |
|---|---|
| Extended DSK data length preserved | ✅ |
| Oversized sector returned correctly | ✅ (outputs actual stored length) |
| End-to-end tested | 🔲 |

---

### Rainbow Arts

**Overview.** Protection on a track beyond the normal 40-track boundary.

#### Recognition

- Disk has >40 tracks
- T40 has a sector with R=0xC6, ST1=0x20, ST2=0x20

#### Characteristics

- Uses track 40+ (extra tracks that simple copiers don't copy)
- ST1=0x20 (CRC error in ID field) and ST2=0x20 (CRC error in data) on that sector

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_DATA | Read T40 sector and verify error codes |

#### Emulation Status

| Check | Status |
|---|---|
| ST1=0x20 returned correctly | ✅ |
| ST2=0x20 returned correctly | ✅ |
| Track 40+ in Extended DSK parsed | ✅ |
| End-to-end tested | 🔲 |

---

### ERE / Remi Herbulot

**Overview.** French protection from ERE Informatique, authored by Remi Herbulot.

#### Recognition

- T0 data contains both `"PROTECTION"` and `"Remi HERBULOT"`

#### Characteristics

Unknown beyond signature. Needs examination.

#### FDC Commands Used

Unknown — needs disassembly.

#### Emulation Status

| Check | Status |
|---|---|
| Detected | ✅ |
| Mechanism understood | 🔲 |
| End-to-end tested | 🔲 |

---

### KBI

**Overview.** Two variants of a protection with very high sector counts.

#### Recognition

- Any track with 19 sectors → "KBI-19"
- T38=9 sectors, T39=10 sectors, T39 sector[9] has ST1=0x20, ST2=0x20 → "KBI-10"

#### Characteristics

**KBI-19**: 19 sectors per track — nearly double the standard count. Requires the FDC to handle densely packed tracks.

**KBI-10**: Uses the final tracks of the disk (38, 39) with an error-flagged extra sector on T39.

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Discover high sector count |
| READ_DATA | Load densely packed tracks |

#### Emulation Status

| Check | Status |
|---|---|
| 19-sector tracks parsed | ✅ |
| ST1/ST2 flags on extra sector | ✅ |
| End-to-end tested | 🔲 |

---

### DiscSYS

**Overview.** Protection where CHRN values all equal the track index — an unusual self-referential pattern.

#### Recognition

- All tracks have 16 sectors
- For track i: `c == i`, `h == i`, `r == i`, `n == i`

#### Characteristics

- Both C and H are set to the track number, not the usual 0/1 values
- N (size code) also equals the track index — sector sizes change per track
- Highly non-standard; any copier that normalises CHRN will break it

#### FDC Commands Used

| Command | Purpose |
|---|---|
| READ_ID | Discover self-referential CHRN values |
| READ_DATA | Load with unusual C/H/N values |

#### Emulation Status

| Check | Status |
|---|---|
| Arbitrary C, H values in DSK preserved | ✅ |
| End-to-end tested | 🔲 |

---

### ARMOURLOC

**Overview.** Protection identified by a distinctive string in the boot sector.

#### Recognition

- T0 has 9 sectors
- T0S0 data at offset 2 contains `"0K free"`

#### Characteristics

Unknown beyond signature. Needs examination.

#### FDC Commands Used

Unknown — needs disassembly.

#### Emulation Status

| Check | Status |
|---|---|
| Detected | ✅ |
| Mechanism understood | 🔲 |
| End-to-end tested | 🔲 |

---

## Detection Flow

`detectProtection()` in `src/plus3/dsk.ts`:

1. Returns immediately if disk has <2 tracks or T0 is empty/short.
2. Checks `isUniform()` (all tracks same structure) and `hasFdcErrors()` (any non-zero ST1/ST2).
3. If uniform **and** no errors → returns `""` (no protection, skip all detectors).
4. Runs all 15 detectors in the order shown below; returns the first non-null result.
5. If no detector matched but disk is non-uniform or has errors → returns `"Unknown"`.

**Detector order:** Alkatraz → Frontier → Hexagon → Paul Owens → Speedlock → Three Inch → W.R.M. → P.M.S. → Players → Infogrames → Rainbow Arts → Herbulot → KBI → DiscSYS → ARMOURLOC

Detection result is display-only; emulation does not branch on it.

---

## Source File Map

| File | Role |
|---|---|
| `src/plus3/dsk.ts` | DSK parser, format detection, all 15 detectors |
| `src/cores/upd765a.ts` | uPD765A FDC — sector serving, weak sectors, raw track, CRC |
| `src/plus3/plus3dos-trap.ts` | BIOS trap for unprotected +3DOS I/O |
| `src/tape/loader-detect.ts` | Tape custom loader auto-detection (Speedlock tape etc.) |
| `src/managers/media-manager.ts` | Disk file loading and IndexedDB persistence |
| `src/components/panes/DrivePane.tsx` | Drive UI — shows format and protection name |
