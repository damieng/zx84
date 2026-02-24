# Action Force (1987, Virgin Games) — +3 Copy Protection Analysis

*Format: ZX Spectrum +3 DSK, 42 tracks, 1 side*
*Disk image: `Action Force (1987)(Virgin Games).dsk`*
*Style: 4AM-style crack notes — document everything, assume nothing*

---

## The Problem

The game crashes on load. After booting and running through three layers of
self-decryption, the loader calls the ROM disk-read routine, 300+ frames pass,
and execution ends up in the 48K BASIC startup (`© 1982 Amstrad`). Display RAM
at 0x4000 is wiped clean. Nothing loaded.

This could be: (a) a protection sector the disk image is missing, (b) a
deliberate tamper-detection crash triggered by bad disk data, or (c) an
emulator bug. We're working to find out which.

---

## Stage 0 — Boot

The disk boots via the standard +3 DOS Loader mechanism:

1. +3 ROM reads the boot sector (track 0, sector 0) into `0xFE00`
2. Execution jumps to `0xFE00`

**Observation:** The bootstrap sector at `FE00` is a repeating-pattern data
block, not obvious code:

```
FE00  CA C8 C6 C4 CA C8 C6 C4 BA B8 B6 B4 BA B8 B6 B4 ...
```

This is obfuscated. By the time the debugger can attach after boot, execution
is already deep in high RAM at `0xE8E1`, running the first decryption pass.
The bootstrap loaded additional code into roughly `0xE000`–`0xFFFF` and
transferred control there.

---

## Stage 1 — Address-Keyed Decryption (`E8D9`–`E8E2`)

### Code

```
E8D9  LD A,(DE)
E8DA  XOR D           ; key high byte
E8DB  SUB E           ; key low byte
E8DC  XOR E           ; key low byte again
E8DD  ADD A,D         ; key high byte again
E8DE  LD (DE),A
E8DF  INC DE
E8E0  LD A,D
E8E1  OR E            ; Z if DE == 0x0000
E8E2  JR NZ,E8D9
```

### Analysis

- **Entry state:** `DE = 0xEDA1`
- **Range:** `0xEDA1` → `0xFFFF` — 4,703 bytes
- **Key:** the current address, split across XOR/SUB/ADD operations
- **Self-modification safe:** loop body at `E8D9`–`E8E2` is below `EDA1`
- Decrypts the entirety of high RAM from `EDA1` to `FFFF`, including the
  bootstrap area at `FE00`–`FEFF`

Falls through to `E8E4` when `DE` wraps to `0x0000`.

---

## Stage 2 — XOR 0x32 Pass (`E8EE`–`E8FB`)

After a short JR chain (`E8E4 → E8EB → E8F4 → E8E6 → E8EE`):

### Code

```
E8E6  LD HL,E8FD      ; start of region
E8EE  LD A,(HL)
E8EF  XOR 32          ; constant XOR key
E8F1  LD (HL),A
E8F2  JR E8F6
E8F6  INC HL
E8F7  LD A,H
E8F8  OR L            ; Z if HL == 0x0000
E8F9  JR Z,E8FD       ; exit
E8FB  JR E8EE
```

### Analysis

- **Range:** `0xE8FD` → `0xFFFF` (~6,915 bytes)
- **Key:** constant `0x32`
- Second pass over the upper memory region. Combined with Stage 1, every byte
  in `EDA1`–`FFFF` has been through both transforms.

Exits at `E8FD` (HL wrapped to 0x0000, JR Z taken).

---

## Stage 3 — Clear BASIC Workspace + RRCA Pass (`E8FD`–`E911`)

After both prior decryptions, fresh code at `E8FD`:

```
; Clear RAM from 5AFF down to 3FFF (wipes BASIC workspace):
E8FD  LD HL,5AFF
E900  LD (HL),00
E902  DEC HL
E903  LD A,H
E904  CP 3F
E906  JR NZ,E900

; Third decryption — RRCA-rotate every byte E913→FFFF:
E908  LD HL,E913
E90B  LD A,(HL)
E90C  RRCA
E90D  LD (HL),A
E90E  INC HL
E90F  LD A,H
E910  OR L
E911  JR NZ,E90B
```

### Analysis

- The `5AFF`→`3FFF` zero-fill destroys the +3 DOS system variables and BASIC
  stack — no going back to the ROM loader once this runs.
- The RRCA loop rotates every byte right by 1 over `E913`–`FFFF`. Since
  the XOR 0x32 key was `0x32 = 0011 0010`, and RRCA(XOR(addr_key(x)))
  produces the final plaintext, these three passes together implement a
  three-stage rolling transform.
- After the RRCA pass, `E913` itself decodes to `0x21` (`LD HL,nn`) — the
  start of valid Z80 code.

---

## Stage 4 — Trampoline (`E913`–`E917`)

After the RRCA loop, only 3 bytes remain at `E913`:

```
E913  LD HL,EC62
E916  PUSH HL
E917  RET             ; indirect jump to EC62
```

Classic indirect-jump-via-RET. Execution continues at `EC62`.

---

## Stage 5 — Stack Pivot + Sector List Builder (`EC62`–`ECCB`)

### Code

```
; Stack/IY manipulation — sets up system variables:
EC62  DEC SP
EC63  DEC SP
EC64  EX (SP),IX      ; save IX onto stack
EC66  PUSH IX
EC68  LD A,IYL        ; IY = 5C3A, IYL = 3A
EC6A  XOR IYH         ; 3A XOR 5C = 66
EC6C  SUB 03          ; 66 - 03 = 63
EC6E  LD L,A          ; L = 63
EC6F  LD D,IYH        ; D = 5C
EC71  LD H,D          ; H = 5C → HL = 5C63 (system variables)
EC72  XOR A           ; A = 0
EC73  LD (HL),A       ; [5C63] = 0
EC74  INC HL
EC75  INC HL
EC76  LD (HL),A       ; [5C65] = 0
EC77  SET 6,A         ; A = 0x40
EC79  DEC HL
EC7A  LD (HL),A       ; [5C64] = 0x40
EC7B  INC HL
EC7C  INC HL
EC7D  LD (HL),A       ; [5C66] = 0x40
; → sets [5C64/65] = 0x4000, [5C66] = 0x40
; (5C65) is used as a running "next-free" pointer into a sector list at 0x4000
```

Followed by 5 calls to `ED6D`/`ED69` — a disk sector descriptor builder:

```
EC8A  CALL ED6D       ; BC=EC37 → appends address EC37 to list at 0x4000
EC90  CALL ED6D       ; BC=EC38 → appends EC38
EC9A  CALL ED6D       ; BC=EC3E → appends EC3E
ECB9  CALL ED69       ; BC=01DD → appends 01DD
ECC5  CALL ED69       ; BC=ECD7 → appends ECD7
```

### Sector Descriptor List at 0x4000

After all five calls `(5C65) = 0x4019`, and 0x4000 contains:

```
4000  00 00 37 EC 00 00 00 38 EC 00 00 00 3E EC 00 00
4010  00 DD 01 00 00 00 D7 EC 00 ...
```

Five pointer entries (little-endian, 5 bytes/entry at offsets +2/+3):
| Entry | Offset | Points to |
|-------|--------|-----------|
| 0     | 0x4002 | `EC37`    |
| 1     | 0x4007 | `EC38`    |
| 2     | 0x400C | `EC3E`    |
| 3     | 0x4012 | `01DD`    |
| 4     | 0x4017 | `ECD7`    |

### R-Register Decryption Pass (`ECA4`–`ECB2`)

Between building the sector list and the actual disk read, there is a 4th
decryption layer using the Z80's R register:

```
EC9F  LD A,IYL        ; IYL = 0x3A
ECA1  RLA             ; rotate left through carry → 0x74
ECA2  LD R,A          ; seed R = 0x74
ECA4  LD HL,ECB4      ; target = ECB4
ECA7  LD BC,00B5      ; length = 181 bytes
ECAA  LD A,R          ; read current R (auto-increments each instruction)
ECAC  XOR (HL)
ECAD  LD (HL),A
ECAE  INC HL
ECAF  DEC BC
ECB0  LD A,B
ECB1  OR C
ECB2  JR NZ,ECAA
```

- **Range:** `ECB4`–`ED68` (181 bytes)
- **Key:** R register, seeded to `0x74`, auto-incrementing each instruction
- This is timing-sensitive: the exact number of instructions executed before
  the loop determines every byte's key. Any code inserted before `LD R,A`
  would corrupt the decryption.

After this pass, `ECB4` decodes to clean code (Stage 6).

---

## Stage 6 — Final Disk Load (`ECB4`–`ECCB`)

After the R-register pass, `ECB4` contains:

```
ECB4  EXX
ECB5  XOR A
ECB6  LD BC,01DD
ECB9  CALL ED69       ; load disk sectors
ECBC  LD BC,0075
ECBF  ADD IX,BC       ; IX = ECD7
ECC1  LD B,IXH
ECC3  LD C,IXL
ECC5  CALL ED69       ; load more disk sectors
ECC8  CALL NC,335B    ; if no error: call ROM routine 335B
ECCB  RET
```

`335B` in ROM 3 (48K BASIC) is a sector-list dispatcher. It uses the
`(5C65)` pointer and a complex `EXX`/`EX (SP),HL`/`EXX` stack-pivot trick to
redirect the return address to `ED69`, then processes each entry in the
`0x4000` table using the ROM's disk-read machinery.

---

## Stage 7 — FDC Port Activity (Port I/O Trace)

Tracing port I/O from `ECC8` through ~400 frames:

**OUT to FDC data register (3FFD):** `4A 00 0F 08 4C 82 02 2A FF 79`

Parsed as UPD765A commands:
| Bytes | Command | Parameters |
|-------|---------|-----------|
| `4A 00` | READ_ID (MFM) | HU=0x00 (unit 0, head 0) |
| `0F 08 4C` | **SEEK** | HU=0x08, **NCN=0x4C (track 76)** |
| `82 02 2A FF 79` | READ_TRACK (MT, no-MFM) | HU=0x02, C=0x2A, H=0xFF, R=0x79 |

**Critical observation:** `SEEK` to cylinder **76** on a disk with only **42 tracks**
(0–41). This will always produce a seek error on any normal copy.

**IN from FDC status (2FFD) values:** `80, 90, D0, F0`
- `0x80` = RQM set, FDC idle — waiting for command
- `0xD0` = RQM set, DIO=1 (FDC→CPU), CB=1 — result phase
- `0xF0` = RQM set, DIO=1, CB=1, NDM=1 — data in progress

**IN from FDC data (3FFD) includes:** `0x40`, `0x80` — abnormal ST0 status
codes, confirming FDC errors were returned.

**OUT to ULA border (xxFE) from EDB8:** ~11,000 writes cycling colours
`06,04,02,00,05,03,01,07` — this is the classic loading stripe pattern.
Despite the seek error, a significant byte-by-byte transfer is occurring.

**OUT to 1FFD = 0x0C** (once, from BD15) — enables +3 special paging mode
during the transfer.

**Conclusion:** The loader deliberately seeks past the end of the disk as a
protection probe. On the original master disk, track 76 (or the response to
an out-of-range seek) would return specific data. On a standard image copy,
the seek fails, which triggers the crash. However, the border-stripe activity
shows the loader still attempts a `READ_TRACK` and transfers data regardless —
the protection check and the actual game load happen concurrently or in sequence.

---

## Stage 8 — Sector Reader at EDB8

`EDB8` is the custom sector dispatcher. When first hit: `HL=ECDA`, `DE=EE13`.
`DE` is the **destination address** for loaded sector data — game code lands at
`0xEE13` and above.

```
EDB8  LD A,(HL)          ; read descriptor byte from HL
EDB9  SUB H              ;
EDBA  ADD A,E            ; address-key transform (same as Stage 1)
EDBB  SUB L              ;
EDBC  ADD A,D            ;
EDBD  POP DE             ; restore destination pointer
EDBE  INC HL             ;
EDBF  PUSH HL            ; save updated descriptor pointer
EDC0  AND A              ; test bit 7
EDC1  JP P,EDD3          ; if bit7=0 → branch to sector lookup
; bit7=1 path (EDE2):
EDE2  LD E,D7            ; E = 0xD7
EDE4  LD D,19            ; D = 0x19 → DE = 0x19D7
EDE6  LD H,D             ; H = 0x19
EDE7  ADD HL,DE          ; HL = track/sector table address
EDE8  LD E,(HL)          ; load sector descriptor lo
EDE9  INC HL
EDEA  LD D,(HL)          ; load sector descriptor hi → DE = address
EDEB  LD HL,EDA9         ; push EDA9 as continuation
EDEE  EX (SP),HL         ;
EDEF  PUSH DE            ;
EDF0  EXX                ; switch register banks
EDF1  LD BC,(5C66)       ; load paging register value
EDF5  RET                ; trampoline → DE (sector read routine)
```

Data at `ECDA` (first descriptor block):
```
ECDA  A6 F1 F8 FC 40 B0 00 7F CE D1 F8 71 E0 D2 2E 08
ECEA  40 B0 00 55 BC 0E 40 B0 00 06 EE 0D E2 E4 E4 E6
```

---

## Stage 9 — Sector Load Loop (`EDA9`/`EDB8`)

`EDA9` is the per-sector continuation — called after each ROM disk read returns.

```
EDA9  LD (5C65),DE        ; update sector-list pointer (was 0x4005 after entry 0)
EDAD  EXX
EDAE  PUSH DE
EDAF  LD DE,EE13          ; *** destination: game data loads to 0xEE13 ***
EDB2  LD A,R
EDB4  AND 07
EDB6  OUT (FE),A          ; border stripe from R register (loading effect)
EDB8  LD A,(HL)           ; read next descriptor byte from ECDA table
; ...address-key transform (identical to Stage 1)...
EDC1  JP P,EDD3           ; branch on bit 7 of transformed byte
```

At `EDD3`, if the transformed byte < `0x18`:
- Load `BC` from `(EE15)` — a running block offset
- Compute adjusted destination `HL`
- Continue to `EDE2`

At `EDE2`, the transformed byte is used as an index into a **lookup table at
`0x19D7`** (in ROM 3). This gives a 2-byte ROM address in `DE`. The code then:
- Pushes `EDA9` as continuation
- Pushes the ROM address as the "return" target
- `RET` → trampolines into the ROM routine at that address
- ROM does an `LDIR` block copy of sector data to `DE=0xEE13`

The table at `0x3359` in ROM 3 yields ROM address `0x340F`.
`0x340F` (ROM 3):
```
340F  PUSH DE
3410  LD HL,(5C68)
3413  CALL 3406           ; HL = (5C68) + A*5 (indexed table lookup)
3416  CALL 33C0           ; 33A9 → save regs, CALL 1F05 (block setup), LDIR
3419  POP HL
341A  RET                 ; → returns to EDA9 (next iteration)
```

The crash point `ED88 = RST 0000` exists in the stack-safety check:
```
ED84  SBC HL,SP
ED86  JR C,ED89           ; safe if HL < SP
ED88  RST 0000            ; *** crash if stack too small ***
```

---

## Stage 10 — Final Load Dispatch (`BD60`–`BD9D`)

After the EDB8 sector loop completes, execution reaches `BD60`:

```
BD60  LD HL,C000          ; game entry point
BD63  LD A,03             ; search key
BD65  CALL BD9D           ; scan sector table at BEE3 for entry type 0x03
BD68  LD HL,BD77
BD6B  LD DE,5D00
BD6E  PUSH DE             ; push 5D00 as return target
BD6F  LD BC,0011
BD72  LDIR                ; copy 17-byte trampoline to 0x5D00
BD74  JP BD88             ; set up 48K paging (1FFD/7FFD), RET → 5D00
```

Trampoline at `BD77` (copied to `0x5D00`):
```
LD HL,BBFF
LD DE,BFFF
LD BC,5E00
LDDR                ; move 0x5E00=24,064 bytes from BBFF→5E00 to BFFF→6200
LD SP,62FF
JP C000             ; enter game
```

`BD9D` — Sector Table Scanner:
```
BD9D  LD IX,BEE3          ; sector table base
BDA1  LD C,A              ; C = search key (0x03)
BDA2  LD A,(IX+00)        ; read table entry type byte
BDA5  CP C                ; found?
BDA6  JR Z,BDB2           ; yes → use this entry
BDA8  INC IX ×4           ; no → next 4-byte entry
BDB0  JR BDA2
; BDB2: LD D,(IX+01) / LD E,(IX+02) / LD B,(IX+03) → disk read parameters
```

`0xBD9C = RST 0000` is a one-byte crash guard immediately before `BD9D`.

---

## Root Cause: Missing Protection Track

**`BEE3` is all zeros at the time `BD9D` runs.** The sector table needed for
the final game load was never populated.

The FDC port trace from `ECC8` showed a `SEEK` to **cylinder 76** on a
**42-track disk**. That seek fails — no such track exists on a standard
format copy. The sectors on track 76 should have loaded the `BEE3` table.
Without that data, `BD9D` loops off into ROM, finds a spurious `0x03` byte
at `0x0044`, reads garbage parameters, and the subsequent disk read fails
with `RST 0000` at `BD9C`.

**The copy protection is a hidden track beyond the normal disk boundary.**
Original masters were pressed with extra tracks. Standard copying tools
cannot reproduce tracks 42–76.

---

## What We Need to Fix It

`BD9D` needs `[BEE3] = 0x03` followed by valid sector parameters at
`BEE3+1`, `BEE3+2`, `BEE3+3`. These come from track 76 on the original
disk. Without a working image or a dump of the protected track, the correct
values must be determined by reversing `BDB2`–`BDE3`.

**Options:**
1. Reverse `BDB2` onwards to understand what valid `BEE3` entries look like
   and deduce values from the game's final memory requirements
2. Find another disk image that preserves the extra tracks
3. Patch `BD9D` to hard-code working parameters once known

---

## Stage 11 — FDC Dispatch Reversed (`BDE3`/`BE10`)

`BDE3` patches four self-modifying locations from the `BEE3` entry, then
calls `BE10`:

```
BDE3  DI
BDE4  LD A,D
BDE5  LD (BECB),A         ; patch SEEK command's NCN = track
BDE8  LD (BED4),A         ; patch READ_DELETED_DATA's C field = track
BDEB  LD (BE2C),HL        ; patch LD HL,(BE2C) → destination address = 0xC000
BDEE  LD A,E
BDF1  LD (BED6),A         ; patch R field (start sector)
BDF4  LD A,C
BDF7  LD (BED8),A         ; patch EOT field (last sector)
BDFA  JR BE10
```

`BE10` loop: SEEK to track → wait → READ_DELETED_DATA → verify result →
load to `(BE2C)` via LDIR.

FDC command bytes at `BEC8` (SEEK, 3 bytes):
```
BEC9  0F      SEEK command
BECA  00      HU = unit 0, head 0
BECB  xx      NCN = track (patched from BEE3+1)
```

FDC command bytes at `BED1` (READ_DELETED_DATA, 9 bytes):
```
BED2  4C      READ_DELETED_DATA (MFM)
BED3  00      HU = 0
BED4  xx      C = track (patched)
BED5  00      H = 0
BED6  xx      R = start sector (patched from BEE3+2)
BED7  02      N = 512 bytes/sector
BED8  xx      EOT = last sector (patched)
BED9  2A      GPL = 0x2A
BDDA  FF      DTL = no limit
```

**Destination: `0xC000`** (game entry point, set at BD60 via `LD HL,C000`
→ patched into `BE2C`).

The multi-track read loop (`BDC8`–`BDE1`) handles loading runs that span
more than one track: reads first track (sector 1→9), increments track `D`,
reduces remaining count, loops back until all sectors are read.

---

## Conclusion

The copy protection scheme uses a **hidden track (cylinder 76)** beyond the
physical 42-track boundary of the disk image. The sequence is:

1. Loader decrypts itself via three nested passes (address-key, XOR 0x32, RRCA)
2. Builds a sector descriptor table at `0x4000`
3. Loads game data via the 48K ROM's disk machinery (`EDB8` loop)
4. The protected sectors on track 76 should populate `BEE3` with final-load
   parameters: `[0x03, track, start_sector, sector_count]`
5. `BD9D` scans `BEE3` for the `0x03` key, extracts parameters
6. `BDE3` issues `SEEK + READ_DELETED_DATA` to load game code to `0xC000`
7. LDDR block-moves all loaded data into final position, then `JP C000`

**On this disk image** (42 tracks), the track 76 seek fails, `BEE3` is never
populated, and `BD9D` loops off into ROM, picks up spurious `0x03` at
`0x0044`, and the resulting bad disk read crashes via `RST 0000` at `BD9C`.

### To Fix

Two approaches:

**A — Patch `BD9D`:** Replace the scan with hardcoded parameters. Once the
correct `[track, start_sector, sector_count]` values are known (e.g. by
running on real hardware or finding a different image), write them directly:
```
BD9D  LD D,nn      ; track
      LD E,01      ; start sector
      LD B,nn      ; sector count
      JP BDB2
```

**B — Add the missing track:** Re-create the `BEE3` table data and inject it
into the disk image as a synthetic track 76 with the expected sector content.
This requires knowing the correct parameters from option A first.

The correct `BEE3` values are: `[0x03, <track>, 0x01, <count>]` where
`<track>` is the first track of game code and `<count>` is the total number
of 512-byte sectors to load to `0xC000`. Given the disk layout (42 tracks,
9 sectors each), the game code likely spans roughly tracks 4–8 or similar —
but the exact values require a working disk image or real-hardware dump to
confirm.

---

*End of analysis.*
