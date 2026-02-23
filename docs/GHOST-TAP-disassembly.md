# GHOST.TAP — Annotated Reverse Engineering

**Title:** The Ghost
**Author:** M. Harris ("Miktor")
**Source:** Your Sinclair, November 1990
**Target machine:** 128K / +2 / +3 Spectrum
**File size:** 1884 bytes (6 TAP blocks)

---

## TAP File Structure

| Block | Type    | Name        | Address | Size   | Notes                         |
|-------|---------|-------------|---------|--------|-------------------------------|
| 1     | Header  | `SetUpCode` | —       | —      | BASIC program, no autorun     |
| 2     | Data    | `SetUpCode` | —       | 1567 B | Type-in installer (see below) |
| 3     | Header  | `GHOST`     | —       | —      | BASIC program, autorun line 10 |
| 4     | Data    | `GHOST`     | —       | 102 B  | Two-line tape loader          |
| 5     | Header  | `GHOST.COD` | 28000   | —      | Machine code block            |
| 6     | Data    | `GHOST.COD` | 28000   | 140 B  | The actual machine code       |

There are two equivalent load paths:

- **Magazine type-in path:** Load `SetUpCode`, which POKEs the 140 machine-code
  bytes from DATA statements and then jumps to them.
- **Tape path:** Load `GHOST` (auto-runs line 10), which tape-loads `GHOST.COD`
  to address 28000 and calls `RANDOMIZE USR 28000`.

---

## BASIC Programs

### SetUpCode (blocks 1/2) — Magazine type-in installer

```basic
   0 REM The Ghost              by M. Harris    from Your Sinclair, Nov'90
   1 REM THE GHOST MTW '90
  10 CLEAR 27999: LET t=0
  20 FOR n=28000 TO 28139: READ a: POKE n,a: LET t=t+a: NEXT n
  30 IF t<>12642 THEN PRINT "ERROR IN DATA": STOP
  40 RANDOMIZE USR 4535
  50 DATA 243,62,20,1,253,127,237,121,33,0,0,17,0,192,1,0,64,237,176,62,5,1
  60 DATA 253,31,237,121,62,7,50,232,5,33,204,109,17,75,0,6,0,14,2,237,176,17
  70 DATA 82,11,14,4,237,176,17,73,19,14,4,237,176,17,125,27,14,4,237,176,17,244
  80 DATA 27,14,3,237,176,17,70,38,14,3,237,176,17,60,60,14,3,237,176,17,71,21
  90 DATA 14,9,237,176,33,0,57,17,1,57,1,0,3,54,60,237,176,195,183,17,191,2
 100 DATA 214,165,48,9,175,17,54,21,253,203,10,126,223,254,13,205,142,2,195,244,255,32
 110 DATA 47,32,77,105,107,116,111,114
```

- Pokes 140 bytes to 28000–28139, verifies checksum (sum = 12642), then calls
  `RANDOMIZE USR 4535` = `RANDOMIZE USR $11B7`, which is the 48K ROM's
  BASIC-MAIN re-entry point.  On a real 48K machine (ROM read-only), all ROM
  patches below are silently ignored and this acts as a warm restart.  On
  128K/+3 the machine code must be called via the tape path instead.

### GHOST (blocks 3/4) — Tape loader

```basic
  10 CLEAR 27999: LOAD "GHOST.COD" CODE: RANDOMIZE USR 28000
  20 SAVE "GHOST" LINE 10: SAVE "GHOST.COD" CODE 28000,140
```

- Line 10 is the intended entry point for 128K/+3: clears RAMTOP to 27999,
  loads the machine code, and calls it via USR.
- Line 20 is a re-save utility the author used during development.

---

## Machine Code — GHOST.COD (28000/$6D60, 140 bytes)

### Full Hex Dump

```
6D60 (  0): F3 3E 14 01 FD 7F ED 79 21 00 00 11 00 C0 01 00
6D70 ( 16): 40 ED B0 3E 05 01 FD 1F ED 79 3E 07 32 E8 05 21
6D80 ( 32): CC 6D 11 4B 00 06 00 0E 02 ED B0 11 52 0B 0E 04
6D90 ( 48): ED B0 11 49 13 0E 04 ED B0 11 7D 1B 0E 04 ED B0
6DA0 ( 64): 11 F4 1B 0E 03 ED B0 11 46 26 0E 03 ED B0 11 3C
6DB0 ( 80): 3C 0E 03 ED B0 11 47 15 0E 09 ED B0 21 00 39 11
6DC0 ( 96): 01 39 01 00 03 36 3C ED B0 C3 B7 11 BF 02 D6 A5
6DD0 (112): 30 09 AF 11 36 15 FD CB 0A 7E DF FE 0D CD 8E 02
6DE0 (128): C3 F4 FF 20 2F 20 4D 69 6B 74 6F 72
```

Checksum: sum of all 140 bytes = **12642** (verified by the BASIC installer).

---

### Annotated Disassembly

The code splits into two logical sections: 108 bytes of executable setup, then
32 bytes of patch-data blob.

#### Section 1: Executable setup (6D60–6DCB)

```
; ── Step 1: select 48K ROM + bank 4 ───────────────────────────────────────
6D60  F3              DI
                      ; Disable interrupts for the entire setup.

6D61  3E 14           LD A, $14       ; $14 = %00010100
                      ;   bits 0–2 = 100  → page RAM bank 4 to $C000
                      ;   bit  3   =  0   → normal screen (bank 5)
                      ;   bit  4   =  1   → upper ROM = ROM 3 (48K BASIC)
                      ;   bit  5   =  0   → paging NOT locked yet

6D63  01 FD 7F        LD BC, $7FFD    ; 128K/+3 primary memory port

6D66  ED 79           OUT (C), A      ; bank 4 now visible at $C000;
                                      ; 48K BASIC ROM now visible at $0000

; ── Step 2: copy 48K ROM into bank 4 ──────────────────────────────────────
6D68  21 00 00        LD HL, $0000    ; source: $0000 (start of 48K BASIC ROM)
6D6B  11 00 C0        LD DE, $C000    ; dest:   $C000 (bank 4, just paged in)
6D6E  01 00 40        LD BC, $4000    ; count:  16384 bytes
6D71  ED B0           LDIR
                      ; Copies the entire 48K ROM into RAM bank 4.
                      ; After this, bank 4 is a writeable mirror of the ROM.

; ── Step 3: switch to +3 special paging — all-RAM config 2 ────────────────
6D73  3E 05           LD A, $05       ; $05 = %00000101
                      ;   bit 0 = 1  → special paging mode ACTIVE
                      ;   bit 1 = 0  ┐
                      ;   bit 2 = 1  ┘ config 2: banks 4,5,6,3 at $0/$4/$8/$C

6D75  01 FD 1F        LD BC, $1FFD    ; +3 extended memory/disk control port

6D78  ED 79           OUT (C), A
                      ; Address map is now FULLY RAM:
                      ;   $0000–$3FFF = bank 4  ← the writable ROM copy
                      ;   $4000–$7FFF = bank 5  ← screen RAM + system vars
                      ;   $8000–$BFFF = bank 6
                      ;   $C000–$FFFF = bank 3

; ── Step 4: update BANKM system variable ──────────────────────────────────
6D7A  3E 07           LD A, $07
6D7C  32 E8 05        LD ($05E8), A
                      ; Writes 7 to the BANKM shadow variable so that 128K
                      ; ROM/paging state is consistent with the new layout.

; ── Step 5: apply eight patches into the RAM copy of the 48K ROM ──────────
;
; HL points to the patch-data blob at $6DCC (see Section 2).
; B is set to 0 once; only C changes for each LDIR (BC = 0x00nn).
; After each LDIR, HL auto-increments past the bytes consumed.
;
6D7F  21 CC 6D        LD HL, $6DCC    ; source = start of patch-data blob

; Patch 1 — 2 bytes → $004B  (no effective change; same bytes as ROM)
6D82  11 4B 00        LD DE, $004B
6D85  06 00           LD B, $00
6D87  0E 02           LD C, $02
6D89  ED B0           LDIR

; Patch 2 — 4 bytes → $0B52  (no effective change; same bytes as ROM)
6D8B  11 52 0B        LD DE, $0B52
6D8E  0E 04           LD C, $04
6D90  ED B0           LDIR

; Patch 3 — 4 bytes → $1349  (no effective change; same bytes as ROM)
6D92  11 49 13        LD DE, $1349
6D95  0E 04           LD C, $04
6D97  ED B0           LDIR

; Patch 4 — 4 bytes → $1B7D  (no effective change; same bytes as ROM)
6D99  11 7D 1B        LD DE, $1B7D
6D9C  0E 04           LD C, $04
6D9E  ED B0           LDIR

; Patch 5 — 3 bytes → $1BF4  (no effective change; same bytes as ROM)
6DA0  11 F4 1B        LD DE, $1BF4
6DA3  0E 03           LD C, $03
6DA5  ED B0           LDIR

; Patch 6 — 3 bytes → $2646  (no effective change; same bytes as ROM)
6DA7  11 46 26        LD DE, $2646
6DAA  0E 03           LD C, $03
6DAC  ED B0           LDIR

; Patch 7 — 3 bytes → $3C3C  *** LIVE CHANGE ***
; ROM at $3C3C has $FF $FF $FF (unused padding before character set).
; Patch writes C3 F4 FF = JP $FFF4, inserting a redirect into the
; unused gap between the end of ROM code and the character set at $3D00.
6DAE  11 3C 3C        LD DE, $3C3C
6DB1  0E 03           LD C, $03
6DB3  ED B0           LDIR

; Patch 8 — 9 bytes → $1547  *** LIVE CHANGE ***
; ROM at $1547 contains "Research " (part of the 48K copyright string
; "© 1982 Sinclair Research Ltd").
; Patch writes " / Miktor" — the author's signature, replacing 9 bytes
; of the copyright notice in the RAM copy.
6DB5  11 47 15        LD DE, $1547
6DB8  0E 09           LD C, $09
6DBA  ED B0           LDIR

; ── Step 6: flood-fill $3900–$3BFF with $3C (INC A) ──────────────────────
6DBC  21 00 39        LD HL, $3900
6DBF  11 01 39        LD DE, $3901
6DC2  01 00 03        LD BC, $0300
6DC5  36 3C           LD (HL), $3C    ; seed first byte ($3C = INC A opcode)
6DC7  ED B0           LDIR
                      ; Fills $3900–$3BFF (unused $FF bytes in the ROM copy)
                      ; with $3C.  This creates a harmless NOP-like slide of
                      ; INC A instructions in the gap area.
                      ; Note: the JP $FFF4 at $3C3C is above this range and
                      ; is NOT overwritten.

; ── Step 7: hand off to the 48K BASIC main entry point ───────────────────
6DC9  C3 B7 11        JP $11B7
                      ; Jumps into the 48K ROM copy (now in bank 4 / $0000).
                      ; $11B7 is the 48K BASIC "MAIN-EXEC" re-entry point,
                      ; which reinitialises registers, sets I = $3F,
                      ; sets the border to white, and restarts the BASIC
                      ; executor — running whatever BASIC program is in RAM.
```

#### Section 2: Patch-data blob ($6DCC–$6DEB, 32 bytes)

This data is consumed sequentially by the eight LDIR patches above.
HL starts at $6DCC and auto-increments across all eight transfers.

```
Offset  Patch#  Dest    Len  Bytes (hex)           Decoded / effect
  +0    P1      $004B    2   BF 02                 Same as ROM — no change
  +2    P2      $0B52    4   D6 A5 30 09           Same as ROM — no change
  +6    P3      $1349    4   AF 11 36 15           Same as ROM — no change
 +10    P4      $1B7D    4   FD CB 0A 7E           Same as ROM — no change
 +14    P5      $1BF4    3   DF FE 0D              Same as ROM — no change
 +17    P6      $2646    3   CD 8E 02              Same as ROM — no change
 +20    P7      $3C3C    3   C3 F4 FF              JP $FFF4  ← new
 +23    P8      $1547    9   20 2F 20 4D 69 6B     " / Miktor"  ← new
                              74 6F 72
```

Patches 1–6 write back the exact same bytes already in the ROM.  The LDIR
loop treats all eight patches uniformly and these early entries exist solely
to advance HL to the correct offset before the meaningful patches.

---

## What the Two Live Patches Do

### Patch 7 — JP $FFF4 at $3C3C

The 48K ROM's $3C00–$3CFF is unused padding (all $FF bytes) between the end of
ROM code and the character-set data at $3D00.  Placing `JP $FFF4` here would
redirect any code that slides into this region.  This is likely the hook for
the IM 2 interrupt mechanism: the code sets `I = $3F` (via the ROM init at
$11B7), and on an IM 2 interrupt the low byte of the vector address comes from
the data bus (typically $FF on a Spectrum), giving vector address $3FFF.  The
two bytes at $3FFF–$4000 form the ISR address: byte at $3FFF in the ROM copy
($3C from the character set preamble) and byte at $4000 in bank 5 (normally
$00), giving ISR = $003C → which branches into the ROM's RST 38 / keyboard
scanner chain.  The JP at $3C3C is the safety net if any code path otherwise
falls into the $FF zone.

### Patch 8 — " / Miktor" at $1547

The 48K ROM copyright string at $1540 reads:

```
1540: 53 69 6E 63 6C 61 69 72 20 52 65 73 65 61 72 63 68 20 4C 74
      S  i  n  c  l  a  i  r     R  e  s  e  a  r  c  h     L  t
```

After patch 8 ($1547 ← " / Miktor"):

```
1540: 53 69 6E 63 6C 61 69 72 20 2F 20 4D 69 6B 74 6F 72 20 4C 74
      S  i  n  c  l  a  i  r     /     M  i  k  t  o  r     L  t
```

The result is `"Sinclair / Miktor Ltd"` in the RAM copy of the ROM.
This is the author's signature, embedded in the copyright notice that is
displayed on the 48K Spectrum startup screen.

---

## Execution Flow Summary

```
GHOST BASIC (line 10)
  CLEAR 27999          ; RAMTOP = $6D5F, SP = $6D5F
  LOAD "GHOST.COD"     ; loads 140 bytes to $6D60–$6DEB
  RANDOMIZE USR 28000  ; calls $6D60
    │
    ├─ DI
    ├─ OUT($7FFD, $14)  ; bank 4 @ $C000, 48K ROM @ $0000
    ├─ LDIR $0000→$C000 ; copy 48K ROM into bank 4
    ├─ OUT($1FFD, $05)  ; +3 special paging: banks 4,5,6,3
    │                    ; NOW: $0000–$3FFF = bank 4 (writable ROM copy)
    ├─ LD ($05E8), $07   ; update BANKM sysvar
    ├─ 6 × LDIR no-ops  ; advance data pointer
    ├─ LDIR → $3C3C      ; patch: JP $FFF4 (into unused ROM padding)
    ├─ LDIR → $1547      ; patch: " / Miktor" over "Research "
    ├─ fill $3900–$3BFF  ; flood-fill unused ROM area with $3C (INC A)
    └─ JP $11B7           ; enter 48K BASIC main loop via patched ROM copy
         │
         └─ 48K BASIC restarts, copyright now reads "Sinclair / Miktor Ltd"
```

---

## Notes

- **48K compatibility:** On a real 48K Spectrum, all OUT and POKE instructions
  targeting ROM/paging addresses are silently ignored (ROM is read-only, banking
  ports don't exist).  `RANDOMIZE USR 4535` calls the ROM's startup directly,
  which performs a warm BASIC reset (equivalent to NEW).  The program has no
  visible effect on 48K.

- **Signature:** The ASCII bytes at the very end of the data blob,
  `20 2F 20 4D 69 6B 74 6F 72` = ` / Miktor`, are both the patch data for the
  copyright string and a plaintext signature readable directly in any hex editor.

- **Checksum:** The BASIC installer validates that the sum of all 140 DATA bytes
  equals 12642.  Verified: ∑(bytes at $6D60–$6DEB) = 12642 ✓
