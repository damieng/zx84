# Barbarian 2: Axe of Rage (1989, Palace Software) — +3 Copy Protection Analysis

*Format: ZX Spectrum +3 DSK, 42 tracks, 1 side*
*Disk image: `Barbarian 2.dsk`*
*Protection: Speedlock 1989 (variant)*
*Style: 4AM-style crack notes — document everything, assume nothing*

---

## Stage 0 — Boot

Standard +3 Loader boot. ROM reads the boot sector (track 0, sector 1, 512 bytes)
into `0xFE00`. Execution jumps to `0xFE00`. The first 16 bytes of the boot sector
are the standard +3 DOS header; actual bootstrap code starts at `0xFE10`.

```
FE00  00 00 28 09 02 01 03 02 2A 52 00 00 00 00 00 2E   DOS header
FE10  F3 01 FD 7F 3E 13 ED 79 ...                      bootstrap entry
```

---

## Stage 1 — Bootstrap (`FE10`)

Entry: `DI`. Immediate hardware setup.

```
FE10  F3           DI
FE11  01 FD 7F     LD BC,7FFD
FE14  3E 13        LD A,13          ; bank 3, ROM low-bit=1
FE16  ED 79        OUT (C),A
FE18  01 FD 1F     LD BC,1FFD
FE1B  3E 0C        LD A,0C          ; ROM high-bit=1, motor ON
FE1D  ED 79        OUT (C),A
```

**Paging state:** 7FFD=0x13, 1FFD=0x0C → ROM 3 (48K BASIC), RAM bank 3 at
0xC000, disk motor on.

```
FE1F  AF           XOR A
FE20  D3 FE        OUT (FE),A       ; border = black
FE22  21 00 58     LD HL,5800
FE25  11 01 58     LD DE,5801
FE28  01 FF 02     LD BC,02FF
FE2B  77           LD (HL),A
FE2C  ED B0        LDIR             ; clear attributes 5800–5AFF
FE2E  67           LD H,A
FE2F  6C           LD L,H
FE30  22 B0 5C     LD (5CB0),HL     ; FRAMES = 0
```

---

## Stage 2 — FDC Subroutine (`FE59`)

The bootstrap uses a single FDC send/receive subroutine at `FE59` for all disk
commands.

```
FE59  21 00 40     LD HL,4000       ; receive buffer = screen RAM
FE5C  1A           LD A,(DE)        ; read byte count from table at DE
FE5D  E5           PUSH HL          ; save buffer start (returned to caller)
FE5E  08           EX AF,AF'        ; stash count in A'
FE5F  13           INC DE
FE60  01 FD 2F     LD BC,2FFD       ; FDC status port
FE63  ED 78        IN A,(C)         ; poll RQM
FE65  87           ADD A,A          ; bit7 → carry
FE66  30 FB        JR NC,FE63       ; wait for RQM=1
FE68  FA 63 FE     JP M,FE63        ; wait for DIO=0 (CPU→FDC direction)
FE6B  1A           LD A,(DE)        ; read command byte
FE6C  06 3F        LD B,3F          ; BC = 3FFD (FDC data port)
FE6E  ED 79        OUT (C),A        ; send byte to FDC   ← watchpoint fires here
FE70  06 08        LD B,08          ; short delay
FE72  08           EX AF,AF'        ; restore count
FE73  10 FE        DJNZ FE73        ; delay 8 iterations
FE75  3D           DEC A            ; decrement count
FE76  20 E6        JR NZ,FE5E       ; loop for next byte
```

After command bytes sent — falls through to result/execution reader:

```
FE78  01 FD 2F     LD BC,2FFD
FE7B  11 10 20     LD DE,2010       ; E=0x10 (CB flag mask), D=0x20 (EXM flag mask)
FE7E  C3 92 FE     JP FE92          ; initially → result-only reader
                                    ; self-modified to FE8A for execution-phase reads
```

**JP target is self-modified** at `FE43` before the second call, changing it
from `FE92` (result-phase only) to `FE8A` (execution + result phases).

**Execution-phase reader (`FE8A`)** — used for READ_DELETED_DATA:

```
FE8A  ED 78        IN A,(C)         ; read FDC status (BC=2FFD)
FE8C  F2 8A FE     JP P,FE8A        ; wait for RQM=1 (sign set)
FE8F  A2           AND D            ; test bit5 = EXM (execution-mode)
FE90  20 F2        JR NZ,FE84       ; if EXM=1, read a data byte:
  FE84  06 3F      LD B,3F          ;   BC = 3FFD
  FE86  ED A2      INI              ;   read byte from FDC into (HL++), B--
  FE88  06 2F      LD B,2F          ;   BC = 2FFD
                                    ;   loop back to FE8A
; EXM=0 → fall through into result reader:
```

**Result-phase reader (`FE92`)** — used for both commands:

```
FE92  ED 78        IN A,(C)         ; poll FDC status
FE94  FE C0        CP C0            ; wait for RQM=1 AND DIO=1 (result byte ready)
FE96  38 FA        JR C,FE92
FE98  06 3F        LD B,3F          ; BC = 3FFD
FE9A  ED A2        INI              ; read result byte into (HL++)
FE9C  06 2F        LD B,2F          ; BC = 2FFD
FE9E  3E 05        LD A,05          ; inter-byte delay
FEA0  3D           DEC A
FEA1  20 FD        JR NZ,FEA0
FEA3  ED 78        IN A,(C)         ; read status
FEA5  A3           AND E            ; test bit4 = CB (controller busy = more results)
FEA6  20 EA        JR NZ,FE92       ; loop if CB=1
FEA8  D6 CE        SUB CE           ; (discarded — status sanity)
FEAA  E1           POP HL           ; restore HL = 4000 (buffer start)
FEAB  01 80 08     LD BC,0880       ; return value: 2176 bytes
FEAE  C9           RET
```

---

## Stage 3 — FDC Command 1: READ_ID

```
FE33  11 81 FE     LD DE,FE81       ; point to command table at FE81
FE36  CD 59 FE     CALL FE59        ; issue command
FE39  7E           LD A,(HL)        ; HL=4000: read ST0 result byte
FE3A  B7           OR A
FE3B  20 F6        JR NZ,FE33       ; retry until ST0=0 (head positioned OK)
```

Command table at `FE81`:

```
FE81  02           count = 2 bytes
FE82  4A           READ_ID | MFM  (0x4A)
FE83  00           HDS+US = drive A, side 0
```

**READ_ID** (0x4A): asks the FDC to read the next sector ID from the disk
surface. Used here purely to confirm the head is positioned and the drive is
spinning. Retries until ST0=0 (no error). The 7 result bytes (ST0–N) land at
`0x4000–0x4006`.

---

## Stage 4 — FDC Command 2: READ_DELETED_DATA (self-modify + sector load)

Before the second call, the JP target inside `FE59` is patched:

```
FE3D  11 4F FE     LD DE,FE4F       ; second command table
FE40  21 8A FE     LD HL,FE8A       ; execution-phase reader address
FE43  22 7F FE     LD (FE7F),HL     ; self-modify: JP FE92 → JP FE8A
FE46  CD 59 FE     CALL FE59        ; issue command
```

Command table at `FE4F`:

```
FE4F  09           count = 9 bytes
FE50  4C           READ_DELETED_DATA | MFM  (0x4C)
FE51  E0           HDS+US = drive A, side 0
FE52  00           C = 0  (cylinder 0)
FE53  00           H = 0  (head 0)
FE54  02           R = 2  (sector number 2)
FE55  02           N = 2  (512 bytes per sector)
FE56  07           EOT = 7  (sectors 2–7 on track: reads until EOT)
FE57  2A           GPL = 42
FE58  FF           DTL = 0xFF (ignored, N>0)
```

**READ_DELETED_DATA** (0x4C): reads sectors with the *deleted-data* address mark.
With EOT=7, the FDC reads sectors 2→7 sequentially (6 × 512 = 3072 bytes) into
memory starting at `0x4000`. The subroutine then reads the 7 result bytes
(ST0–N) into `0x4B80–0x4B86`. Returns `HL=0x4000`, `BC=0x0880`.

**Key observation:** the protection uses READ_DELETED_DATA (not READ_DATA).
Sectors on track 0 carry the deleted-data address mark deliberately. A standard
copier that uses READ_DATA would get a DE (Deleted-data Error) flag in ST2 and
might abort or misread the data.

---

## Stage 5 — Copy to B5AB and Jump

```
FE49  11 AB B5     LD DE,B5AB       ; destination
FE4C  D5           PUSH DE          ; push B5AB as return address
FE4D  ED B0        LDIR             ; copy 0x880 bytes: 4000→B5AB
; After LDIR: BC=0, P/V=0
FE4F  09           ADD HL,BC        ; HL unchanged (BC=0)
FE50  4C           LD C,H
FE51  E0           RET PO           ; P/V=0 → PO → RET → jumps to B5AB
```

0x880 = 2176 bytes of the sector payload are copied from `0x4000` to
`0xB5AB–0xBE2A`. `RET PO` pops `B5AB` from the stack and jumps there.

---

## Stage 6 — Second-Stage Loader at `B5AB`

Execution arrives at `B5AB`. This is the Speedlock 1989 second stage.

```
B5AB  ED 4F        LD R,A           ; seed R register with A=0x32 (current value)
B5AD  21 AD B5     LD HL,B5AD       ; HL = self (start of data to fill)
B5B0  11 AC B5     LD DE,B5AC       ; DE = HL-1
B5B3  01 64 00     LD BC,0064       ; 100 bytes
B5B6  ED B8        LDDR             ; fill 100 bytes at B5AC–B548 with byte at B5AD
```

**Self-modifying fill:** overwrites 100 bytes below `B5AD` with the byte
currently at `B5AD` (`0x21`). This is a junk-fill to obscure the copy-protection
data in memory after use.

```
B5B8  01 4E 08     LD BC,084E       ; 0x084E = 2126 bytes to decrypt
B5BB  21 DD B5     LD HL,B5DD       ; HL → start of encrypted payload
B5BE  CD C1 B5     CALL B5C1        ; call decryptor (actually: PUSH return addr)
```

The `CALL B5C1` is a trick — `B5C1` immediately pops the return address into IX:

```
B5C1  DD E1        POP IX           ; IX = B5C1 (address of this instruction + 2...
                                    ; actually IX = B5C1: addr pushed by CALL was B5C1)
```

Wait — `CALL B5C1` pushes `B5C1` (next instr after CALL) but actually CALL
pushes `B5C1` because it's `CD C1 B5 CALL B5C1` so return addr = B5C1. Then
`POP IX` gets IX=B5C1. Then:

```
B5C3  11 1C 00     LD DE,001C       ; offset = 28
B5C6  DD 19        ADD IX,DE        ; IX = B5C1 + 0x1C = B5DD  (start of payload)
B5C8  ED 5F        LD A,R           ; read R register (increments each M1 fetch)
```

**R-register decryption loop:**

```
B5CA  DD AC        XOR IXH          ; XOR with high byte of IX
B5CC  96           SUB (HL)         ; subtract encrypted byte
B5CD  DD AD        XOR IXL          ; XOR with low byte of IX
B5CF  77           LD (HL),A        ; write decrypted byte in-place
B5D0  0B           DEC BC
B5D1  79           LD A,C
B5D2  23           INC HL
B5D3  B0           OR B
B5D4  C2 DA B5     JP NZ,B5DA       ; if BC≠0, read next R
B5D7  C3 DD B5     JP B5DD          ; BC=0 → jump into decrypted payload
```

At `B5DA`:

```
B5DA  ED 5F        LD A,R           ; fetch fresh R for next byte
B5DC  18 EC        JR B5CA          ; back to XOR/SUB/XOR
```

**Decryption algorithm per byte:**
1. `A = R` (CPU R register — increments by 1 per M1 fetch, non-deterministic)
2. `A ^= IXH` (high byte of current IX — starts at `0xB5`)
3. `A -= (HL)` (subtract encrypted byte)
4. `A ^= IXL` (low byte of IX — starts at `0xDD`, ticks up with IX?)

Wait — IX is never incremented in the loop. IX stays at `B5DD` throughout.
So the XOR masks are constant: `IXH=0xB5`, `IXL=0xDD`. The only varying
component is `R`.

The decryption key is purely the R register — a hardware timing lock. The R
register increments once per M1 (opcode fetch) cycle. Because the decryptor runs
a fixed sequence of M1 fetches between `LD R,A` (which seeds R) and each
byte's `LD A,R`, the total M1 count is deterministic on real hardware. On an
emulator with wrong M1 timing or a debugger that pauses mid-loop, R drifts and
decryption fails.

BC=0x084E = 2126 bytes. The payload at `B5DD` decrypts in-place to the
third-stage loader.

---

## Stage 7 — Speedlock Onion: Layers 2–N

After `JP B5DD`, execution enters an onion of nested R-register decrypt stages.
Each layer decrypts a shorter window of bytes in-place, then falls through into
the next. Every layer uses the same self-modifying jump trick: the *first byte*
decrypted by the loop is the high byte of the loop's own `JP NZ` back-jump,
which must decrypt to `0xB6` (the high byte of the current code address). If R
is wrong the jump goes to garbage and the machine crashes.

**Layer 2 — XOR only (`B5EE`)**

```
B5EE  ED 5F        LD A,R
B5F0  AE           XOR (HL)          ; A = R ^ encrypted
B5F1  77           LD (HL),A
B5F2  23           INC HL
B5F3  0B           DEC BC
B5F5  B0           OR B ; test BC
B5F6  C2 EE AD     JP NZ,ADEE        ← encrypted; first XOR patches high byte:
                                        (B5F8) 0xAD → 0xB5, making JP NZ,B5EE
```

- BC = 0x0833 (2099 bytes), HL starts at B5F8
- R = **0x18** at first XOR (0xAD ^ 0x18 = 0xB5 ✓)

**Layer 3 — XOR + running-key chain (`B604`)**

```
B604  ED 5F        LD A,R
B606  AE           XOR (HL)          ; A = R ^ encrypted
B607  AA           XOR D             ; A ^= D  (D = prev plaintext byte, then +1)
B608  77           LD (HL),A
B609  57           LD D,A            ; D = this plaintext byte
B60A  23           INC HL
B60B  0B           DEC BC
B60C  14           INC D             ; D++
B60F  CA 17 B6     JP Z,B617         ; BC=0 → done
B612  C3 04 CC     JP CC04           ← encrypted; first decrypt patches (B614):
                                        0xCC → 0xB6, making JP B604
```

- BC = 0x0817 (2071 bytes), HL starts at B614, D starts at 0x1D
- R = **0x67** at first iteration (0x67 + 0x7F − 0x28... wait, this is XOR; 0x67 ^ 0x7F ^ 0x1D = 0xB6 ✓)

**Layer 4 — ADD/SUB (`B62A`)**

```
B62A  ED 5F        LD A,R
B62C  86           ADD A,(HL)        ; A = R + encrypted
B62D  92           SUB D             ; A -= D  (D = 0x28, constant)
B62E  77           LD (HL),A
B62F  23           INC HL
B630  0B           DEC BC
B633  C2 2A 7F     JP NZ,7F2A        ← encrypted; first decrypt patches (B635):
                                        0x7F → 0xB6, making JP NZ,B62A
```

- BC = 0x07F6 (2038 bytes), HL starts at B635, D = 0x28 (constant)
- R = **0x5F** at first iteration (0x5F + 0x7F − 0x28 = 0xB6 ✓)

**Layers 5–N — further nested stages (`B7BB`, `B7E3`, ...)**

The pattern continues with more decrypt loops, each with different algorithms
(ADD+R, XOR+LDI copy, etc.) at progressively higher addresses (B7xx, BAxx, BCxx).
Each uses the same self-patching JP trick with R as timing lock.

After ~70 frames the onion is fully peeled and execution reaches the actual disk
loader at **BDA0**.

---

## Stage 8 — Disk Loader (`BDA0`)

After all Speedlock layers, execution is at `BDA0`. This is the real
multi-track disk reader. ROM 3 (48K BASIC) remains paged in; bank 3 at
0xC000.

The loader issues FDC commands via `RST 30h` (which in context jumps to
a stub that issues a SEEK + READ_DELETED_DATA), then drains sector data
via a direct PIO loop:

```
BD90  F7           RST 0030          ; issue SEEK + READ_DELETED_DATA
BD91  01 FD 2F     LD BC,2FFD        ; FDC status port

BDA1  ED 78        IN A,(C)          ; poll RQM
BDA3  JP P,BDA1                      ; wait for RQM=1

BDAB  LD DE,1800                     ; 0x1800 = 6144 bytes to consume
BDAE  LD B,3F                        ; BC=3FFD (FDC data port)
BDB0  INI                            ; read byte → (HL++), B--
BDB2  LD B,2F                        ; BC=2FFD (status)
BDB4  DEC DE
BDB7  JP Z,BDCD                      ; consumed 6144 → result phase
BDBA  ED 78        IN A,(C)          ; check FDC status
BDBF  AND 20                         ; test EXM (still in execution?)
BDC1  JP NZ,BDAE                     ; loop if more data

BDCD  ...                            ; drain result bytes into BE2B+
BDF1  RET
```

**The N=6 short-sector protection covers every data track.** Tracks 1–20
each carry one sector with ID field `N=6` (8192 bytes declared) but only
6144 bytes of actual data in the DSK image. On real hardware the FDC reads
the 6144 available bytes, then overruns past the sector's CRC marker,
returning garbage for the remaining 2048 bytes — but the loader only INIs
6144 bytes and stops, discarding the tail. The result status is:

```
ST0=0x40  ST1=0xA0 (EN=end-of-cylinder + DE=data error)  ST2=0x20 (DD)
```

The loader reads exactly 6144 bytes per track and ignores the DE flag —
the short-sector CRC error is expected and not checked.

**Emulator fix:** `prepareReadBuffer()` in `upd765a.ts` detects
`sector.data.length < (128 << sector.n)` and returns the real 6144 bytes
followed by 2048 random bytes, matching real hardware behaviour. Without
this, earlier builds delivered only 6144 bytes and the loader stalled or
fell through to the 48K ROM tape loader.

**Track map** (from FDC log):

| Tracks | Command | Sector | Data/track |
|--------|---------|--------|------------|
| 0 | READ_DELETED, N=2, R=2–7 | Speedlock payload | 512 B × 6 = 3072 B |
| 0 | READ_DELETED, N=2, R=9 | Additional payload | 512 B |
| 1–20 | READ_DELETED, N=6, R=1, EOT=1 | Game data | 6144 B each |

Tracks 4, 7, 9, 12, 15, and 17 are each read **twice** — the loader
makes a second pass over specific tracks, likely loading into a second
RAM bank or page.

Total game data from disk: 20 tracks × 6144 bytes = **120 KB** (plus the
Speedlock payload from track 0).

After track 20's READ_DELETED completes, the loader issues `SPECIFY
(0x03)` and returns. The game entry point is reached and execution
continues into the game. Screen: `DEVELOPED BY M.C.LOTHLORIEN /
PROGRAMMED BY Paul Atkinson`.

---

## Summary Table

| Stage | Address | Algorithm | Bytes | R value |
|-------|---------|-----------|-------|---------|
| 0 | FE00 | +3 DOS boot header | — | — |
| 1 | FE10 | Bootstrap: page ROM3/bank3, FDC init | — | — |
| 2 | FE59 | FDC subroutine: command + execution + result PIO | — | — |
| 3 | FE33 | READ_ID (0x4A), retry until ST0=0 | — | — |
| 4 | FE3D | Self-modify JP; READ_DELETED_DATA (0x4C) trk0 sects 2–7 | 3072 | — |
| 5 | FE49 | LDIR 0x880 bytes → B5AB; RET PO → B5AB | 2176 | — |
| 6 | B5AB | Speedlock layer 1: R XOR IXH/IXL, seed LD R,0x32 | 2126 | 0x18 |
| 7 | B5EE | Speedlock layer 2: R XOR, self-patch JP | 2099 | 0x18 |
| 8 | B604 | Speedlock layer 3: R XOR + running-key D | 2071 | 0x67 |
| 9 | B62A | Speedlock layer 4: R ADD−D (D=0x28 const) | 2038 | 0x5F |
| 10+ | B7xx+ | Speedlock layers 5–N: further variants | — | varies |
| final | BDA0 | RST30+INI PIO; tracks 1–20 × 6144 B (N=6 short sectors); 120 KB total | — | — |
