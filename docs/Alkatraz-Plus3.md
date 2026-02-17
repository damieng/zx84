# Alkatraz +3 Disk Protection — Analysis

Investigation of the Alkatraz +3 copy-protection system as found on
*California Games (Side A)* and other Alkatraz-protected +3 titles.

**Status:** Root cause found and fixed. The FDC emulation was not setting
ST0/ST1 End-of-Cylinder flags after READ_DATA when R == EOT. The
protection check expects ST0=0x40 (abnormal) + ST1=0x80 (EN) as the
normal result of a single-sector read. Fix applied in `upd765a.ts`.

---

## Disk Structure

Extended DSK, 42 tracks, 1 side.

| Tracks | Sectors | CHRN | Notes |
|--------|---------|------|-------|
| 0–6 | 9 × 512 B | C=T H=0 R=1–9 N=2 | Standard +3DOS format |
| 7–31 | 8 × 512 B | C=T H=0 R=177–184 N=2 | Non-standard R values |
| 32 | 9 × 512 B | (standard) | Normal format |
| **33** | **18 × 256 B** | **C=233 H=various R=various N=1** | **Protection track** |
| 34–36 | 9 × 512 B | standard | ST2=0x40 (deleted data mark) |
| 37–41 | 9 × 512 B | standard | Normal |

### Track 33 — Protection Track

18 sectors, each 256 bytes, with fake CHRN values:

- C is always 233 (0xE9)
- H values vary (e.g. 24, 0, 8, 16, ...)
- R values vary (e.g. 246, 247, 248, ...)
- N=1 (256 bytes)

Each sector is filled with a single repeated byte value (e.g. sector R=246
is all 0x51). The protection reads all 18 sectors and verifies every byte
matches the expected fill. Some sectors may contain weak bits that differ
on each read — a secondary check after the primary EOT flag check.

---

## Boot Sequence Overview

```
DOS BOOT (ROM 2, 012Ah)
  │
  ▼
FE00  Bootstrap sector (T0/S0/R1, 512 bytes)
FE10  Entry point — DI, set up stack/banks
  │   Copies FE7D–FFFF (0x183 bytes) → 4000
  │
  ▼
4000  First-stage loader
  │   Reads T0 sectors 1–5 via DD_L_READ (CALL 0163)
  │   Copies loaded data to bank 0 via LDIR
  │   Self-modifying JP → EF12
  │
  ▼
EF12  Decryption layers 1–2 (documented below)
  │   XOR running key, then R-register dependent XOR
  │
  ▼
EF4F  Decryption layers 3–20+ (onion layers)
  │   ~15 additional decrypt passes: XOR, NEG, ADC, SUB, RLC,
  │   INC/DEC, R-register XOR, stack-based XOR, SBC with carry chain
  │   Each layer uses self-modifying JR offset trick
  │
  ▼
~F139 Anti-tamper checks
  │   ROM signature test, AMX mouse port probe,
  │   memory integrity verification
  │
  ▼
F2A9  Protection check — direct FDC port access
  │   RECALIBRATE → SEEK track 33 → READ all 18 sectors
  │   Verify each sector's fill byte, check ST0/ST1 result flags
  │   FAIL → F461 → clear memory, beep, RST 0000
  │   PASS → F319 → load game data from tracks 34+
  │
  ▼
F433  Success path
  │   Set up banking, EI, JP 6400 (game entry)
```

---

## Root Cause: Missing End-of-Cylinder Flag

### The Bug

The protection's sector read routine (`F4DD`) sends a READ_DATA command
with R == EOT (e.g. both 0xF6). This reads exactly one sector. On a real
uPD765A, when the sector counter increments past EOT the FDC signals:

- **ST0 = 0x40** (abnormal termination)
- **ST1 = 0x80** (EN — End of Cylinder)

This is not an error — the data was read successfully. It just means
"no more sectors to read". The protection explicitly checks for these
exact values at F506/F50D:

```asm
F503  LD A,(F5FA)         ; ST0 result byte
F506  CP 40               ; must be 0x40 (abnormal termination)
F508  JR NZ,F518          ; if not → return failure
F50A  LD A,(F5FB)         ; ST1 result byte
F50D  CP 80               ; must be 0x80 (End of Cylinder)
F50F  JR NZ,F518          ; if not → return failure
F511  LD A,(F5FC)         ; ST2 result byte
F514  OR A                ; must be 0x00
F515  RET NZ              ; if not → return failure (carry clear)
F516  SCF                 ; set carry = success
F517  RET
F518  AND A               ; clear carry = failure
F519  RET
```

Our FDC was returning ST0=0x00 (normal termination), so the CP 40 at
F506 failed immediately. The protection never even got to read sector
data or check for weak bits.

### The Fix

In `src/cores/upd765a.ts`: when `advanceSector()` detects R > EOT, it
now sets `exHitEOT = true`. `finishExecution()` checks this flag and
OR's in `ST0_ABNORMAL (0x40)` and `ST1 bit 7 (0x80, EN)`.

---

## Annotated Disassembly

### Bootstrap Sector (FE00–FFFF)

Loaded by the +3DOS ROM's DOS BOOT routine from T0/S0/R1 into FE00h.
Entry at FE10h with DI, SP=FE00.

```asm
; === Entry point ===
FE10  F3           DI
FE11  31 00 48     LD SP,4800          ; stack below screen
FE14  ED 56        IM 1
FE16  3E 3F        LD A,3F
FE18  ED 47        LD I,A              ; interrupt vector page 3F
FE1A  FD 21 3A 5C  LD IY,5C3A          ; system variables base
FE1E  D9           EXX
FE1F  21 58 27     LD HL,2758          ; HL' = 2758 (ROM charset addr)
FE22  D9           EXX

; --- Turn on FDC motor via port 1FFD ---
FE23  3E 28        LD A,28             ; bit 3 = motor on, bit 5 = ??
FE25  01 FD 1F     LD BC,1FFD
FE28  ED 79        OUT (C),A

; --- Select ROM 2 (+3DOS) via 1FFD bit 2 ---
FE2A  3A 67 5B     LD A,(5B67)         ; 1FFD shadow
FE2D  E6 F8        AND F8
FE2F  F6 04        OR 04               ; bit 2 = ROM high bit → ROM 2
FE31  ED 79        OUT (C),A
FE33  32 67 5B     LD (5B67),A

; --- Select RAM bank 3 at C000 via 7FFD ---
FE36  01 FD 7F     LD BC,7FFD
FE39  3A 5C 5B     LD A,(5B5C)         ; 7FFD shadow
FE3C  E6 E8        AND E8              ; keep ROM bit (4) + screen bit (3)
FE3E  F6 03        OR 03               ; bank 3
FE40  ED 79        OUT (C),A
FE42  32 5C 5B     LD (5B5C),A

; --- Set up attributes from bootstrap data ---
FE45  3A FA FF     LD A,(FFFA)         ; attr fill byte (from sector data)
FE48  32 8D 5C     LD (5C8D),A         ; ATTR_P system variable
FE4B  47           LD B,A
FE4C  1F           RRA
FE4D  1F           RRA
FE4E  1F           RRA
FE4F  E6 07        AND 07              ; extract PAPER colour
FE51  4F           LD C,A
FE52  78           LD A,B
FE53  E6 F8        AND F8
FE55  B1           OR C                ; combine for attribute fill
FE56  21 00 58     LD HL,5800
FE59  11 01 58     LD DE,5801
FE5C  01 FF 02     LD BC,02FF
FE5F  77           LD (HL),A
FE60  ED B0        LDIR                ; fill attribute area

; --- Set border colour ---
FE62  3A FB FF     LD A,(FFFB)         ; border colour (from sector data)
FE65  D3 FE        OUT (FE),A
FE67  17           RLA
FE68  17           RLA
FE69  17           RLA
FE6A  E6 38        AND 38
FE6C  32 48 5C     LD (5C48),A         ; BORDCR system variable

; --- Copy stub to 4000 and jump ---
FE6F  21 7D FE     LD HL,FE7D          ; source: FE7D
FE72  11 00 40     LD DE,4000          ; dest: 4000
FE75  01 83 01     LD BC,0183          ; length: 0x183 bytes
FE78  ED B0        LDIR
FE7A  C3 00 40     JP 4000             ; enter first-stage loader
```

### First-Stage Loader (4000–4183)

Copied from FE7D–FFFF by the bootstrap. Loads sectors from track 0 via
the +3DOS ROM, copies data to bank 0, then jumps to the decrypted code.

```asm
; === Select bank 7 at C000, enable interrupts ===
4000  3A 5C 5B     LD A,(5B5C)         ; 7FFD shadow
4003  E6 F8        AND F8
4005  F6 07        OR 07               ; bank 7
4007  01 FD 7F     LD BC,7FFD
400A  ED 79        OUT (C),A
400C  32 5C 5B     LD (5B5C),A
400F  FB           EI

; === Initialise +3DOS disk system ===
4010  3E 41        LD A,41             ; 'A' = drive A
4012  CD 51 01     CALL 0151           ; DD_L_DPBASE — set up disk params
4015  30 79        JR NC,4090          ; fail → reset

; --- Save initial dest address, patch JP target ---
4017  2A 81 41     LD HL,(4181)        ; dest address from disk data
401A  22 8E 40     LD (408E),HL        ; patch the JP at 408D ← SELF-MODIFYING

; === Sector read loop: T0/S1–S9 ===
401D  06 01        LD B,01             ; first sector = 1
401F  C5           PUSH BC             ; save sector counter
4020  58           LD E,B              ; E = sector number
4021  16 00        LD D,00             ; D = track 0
4023  0E 00        LD C,00             ; C = logical sector (0)
4025  06 00        LD B,00             ; B = 0
4027  21 00 50     LD HL,5000          ; buffer at 5000
402A  DD E5        PUSH IX
402C  CD 63 01     CALL 0163           ; DD_L_READ — read one sector
402F  DD E1        POP IX
4031  30 5D        JR NC,4090          ; read error → reset

; --- Calculate copy size ---
4033  2A 7F 41     LD HL,(417F)        ; remaining bytes to load
4036  01 00 02     LD BC,0200          ; 512 (one sector)
4039  A7           AND A
403A  ED 42        SBC HL,BC           ; remaining -= 512
403C  30 07        JR NC,4045          ; still >= 0 → full sector
403E  2A 7F 41     LD HL,(417F)        ; partial last sector
4041  4D           LD C,L
4042  44           LD B,H
4043  18 06        JR 404B
4045  22 7F 41     LD (417F),HL        ; update remaining count
4048  01 00 02     LD BC,0200          ; copy full 512 bytes

; --- Copy from 5000 to dest in bank 0 ---
404B  ED 5B 81 41  LD DE,(4181)        ; current dest address
404F  21 00 50     LD HL,5000          ; source buffer
4052  F3           DI
4053  F5           PUSH AF             ; save flags (Z/C from remaining calc)
4054  C5           PUSH BC             ; save byte count
4055  3A 5C 5B     LD A,(5B5C)
4058  E6 F8        AND F8              ; select bank 0 at C000
405A  01 FD 7F     LD BC,7FFD
405D  ED 79        OUT (C),A
405F  C1           POP BC
4060  ED B0        LDIR                ; copy sector data to bank 0
4062  3A 5C 5B     LD A,(5B5C)
4065  01 FD 7F     LD BC,7FFD
4068  ED 79        OUT (C),A           ; restore bank 7
406A  F1           POP AF              ; restore Z/C flags
406B  FB           EI
406C  ED 53 81 41  LD (4181),DE        ; update dest pointer

; --- Loop control ---
4070  28 0B        JR Z,407D           ; remaining == 512 → last block, done
4072  38 09        JR C,407D           ; remaining < 512 → partial, done
4074  C1           POP BC              ; restore sector counter
4075  04           INC B               ; next sector
4076  78           LD A,B
4077  FE 0A        CP 0A               ; sector 10?
4079  20 A4        JR NZ,401F          ; loop back
407B  18 13        JR 4090             ; all 9 sectors used up → reset

; === Loading complete — turn off motor, jump to loaded code ===
407D  CD 9C 01     CALL 019C           ; DD_L_OFF_MOTOR
4080  3A 5C 5B     LD A,(5B5C)
4083  E6 F8        AND F8              ; select bank 0
4085  01 FD 7F     LD BC,7FFD
4088  ED 79        OUT (C),A
408A  32 5C 5B     LD (5B5C),A
408D  C3 12 EF     JP EF12             ; ← patched by 401A (was JP 0000)
                                        ; jumps to decryption stage

; === Error/Reset path ===
4090  F3           DI
4091  AF           XOR A
4092  01 FD 7F     LD BC,7FFD
4095  ED 79        OUT (C),A           ; bank 0, ROM 0
4097  01 FD 1F     LD BC,1FFD
409A  ED 79        OUT (C),A           ; normal paging, motor off
409C  C7           RST 0000            ; warm reset

; === Embedded data ===
; 417F: 2 bytes — total byte count to load (decremented per sector)
; 4181: 2 bytes — destination address in bank 0 (patched into JP at 408E)
; 40C3: "THE ALKATRAZ PROTECTION SYSTEM  (C) 1987"
```

### Decryption Layer 1 (EF12–EF29)

First decryption pass. Simple XOR with running key.

```asm
EF12  F3           DI
EF13  01 0F 07     LD BC,070F          ; byte count = 0x70F (1807 bytes)
EF16  21 2A EF     LD HL,EF2A          ; start of encrypted region
EF19  16 64        LD D,64             ; initial XOR key = 0x64
EF1B  ED 56        IM 1
EF1D  3E 5B        LD A,5B
EF1F  ED 4F        LD R,A              ; seed R register (for layer 2)

; --- Decrypt loop ---
EF21  7E           LD A,(HL)           ; read encrypted byte
EF22  AA           XOR D               ; XOR with running key
EF23  57           LD D,A              ; D = decrypted byte (becomes next key)
EF24  77           LD (HL),A           ; store decrypted byte
EF25  23           INC HL
EF26  0B           DEC BC
EF27  78           LD A,B
EF28  B1           OR C
EF29  20 ??        JR NZ,EF21          ; loop (offset byte at EF2A is part of
                                        ; encrypted data — first decrypted byte
                                        ; becomes 0xF6 = offset -10 → EF21)
; Falls through to EF2B when BC=0
```

**Clever trick:** The JR NZ offset byte at EF2A is itself encrypted.
After decryption it becomes 0xF6 (signed -10), which points back to EF21.
When BC reaches zero, JR NZ falls through to EF2B.

### Decryption Layer 2 (EF2B–EF4D)

Second pass using the R register as part of the XOR key stream.
This makes the decryption timing-dependent — if the R register doesn't
match what the encryptor expected, the code decrypts to garbage.

```asm
EF2B  21 4E EF     LD HL,EF4E          ; start of layer-2 encrypted region
EF2E  31 31 EF     LD SP,EF31          ; SP → LD DE operand below (stack trick)
EF31  11 EB 06     LD DE,06EB          ; byte count = 0x6EB (1771 bytes)
EF34  D9           EXX
EF35  CD 38 EF     CALL EF38           ; push EF38 onto stack
EF38  E1           POP HL              ; HL' = EF38
EF39  01 08 00     LD BC,0008
EF3C  09           ADD HL,BC           ; HL' = EF40
EF3D  E5           PUSH HL             ; push EF40 onto stack at EF2F
EF3E  E1           POP HL              ; restore HL' = EF40 (obfuscation)
EF3F  D9           EXX                 ; back to main regs

; --- Decrypt loop (R-register dependent) ---
EF40  ED 5F        LD A,R              ; R increments every instruction
EF42  AA           XOR D               ; XOR with D (running key)
EF43  AE           XOR (HL)            ; XOR with encrypted byte
EF44  AB           XOR E               ; XOR with E (running key)
EF45  77           LD (HL),A           ; store decrypted byte
EF46  3B           DEC SP              ;
EF47  3B           DEC SP              ; SP → EF2F (where EF40 is stored)
EF48  1B           DEC DE              ; count down
EF49  23           INC HL              ; next byte
EF4A  EB           EX DE,HL
EF4B  7D           LD A,L              ; A = counter low byte
EF4C  EB           EX DE,HL
EF4D  B2           OR D                ; test counter == 0
; EF4E: first byte of encrypted region — after decryption, becomes
;        RET NZ (0xC0) which uses the stacked EF40 address to loop.
;        When counter reaches 0, RET NZ falls through → decrypted code.
```

**Stack-based loop:** The two `DEC SP` instructions point SP at the
stacked return address (EF40). The decrypted byte at EF4E becomes
`RET NZ` (0xC0), which pops EF40 and jumps back to the loop start.
When the counter reaches zero, `OR D` produces zero (Z flag set),
`RET NZ` falls through, and execution continues with the decrypted
code at EF4F.

### Decryption Layers 3–20+ (EF4F onward)

After the first two layers, an additional **~15 onion layers** peel off
in sequence. Each layer decrypts the remaining code using a different
algorithm and then falls through to the next. The byte count shrinks
by ~0x11 each time (the layer header size).

Every layer uses the same self-modifying JR trick: the JR NZ offset
byte lies within the encrypted region. After the first iteration
modifies it, it becomes 0xF6 (-10) or similar, forming the loop-back.

| Layer | Address | Algorithm | Count | Key |
|-------|---------|-----------|-------|-----|
| 3 | EF4F | R-XOR + all regs | 0x6CC | R ⊕ D ⊕ E ⊕ C ⊕ B |
| 4 | EF6E | NEG each byte | 0x6BC | — |
| 5 | EF7E | ADC A,0x58 chain | 0x6AB | carry propagates |
| 6 | EF8F | R-XOR + IY indexed | 0x68F | R ⊕ (IY+0) ⊕ H ⊕ L |
| 7 | EFAB | XOR running key | 0x67D | D starts 0x52 |
| 8 | EFBD | Stack-based R-XOR | 0x332 words | pop/xor/push |
| 9 | EFD4 | SBC A,0x4C chain (backward) | 0x654 | carry propagates |
| 10 | EFE5 | SUB 0x49 | 0x645 | — |
| 11 | EFF5 | RLC each byte | 0x637 | — |
| 12 | F003 | R-XOR pairs (B=2) | 0x30C×2 | IY counter |
| 13 | F022 | SBC A,0x40 chain | 0x607 | carry propagates |
| 14 | F033 | DEC each byte | 0x5FA | — |
| 15 | F040 | R-XOR | 0x5EA | — |
| ... | ... | (pattern continues) | ... | ... |

The decryption layers serve two purposes:
1. **Anti-analysis:** Each layer must execute at the correct speed
   (R-register sensitive) to produce valid code. Stepping in a debugger
   changes R timing and corrupts the result.
2. **Packing density:** The onion structure means a cracker must defeat
   every layer to get to the protection check.

### Anti-Tamper Checks (~F139)

After all decryption layers complete, several anti-tamper checks run
before the FDC protection:

```asm
; --- ROM signature test ---
F139  21 00 3C     LD HL,3C00          ; check video RAM / ROM area
F13C  7E           LD A,(HL)
F13D  23           INC HL
F13E  23           INC HL
F13F  23           INC HL
F140  86           ADD A,(HL)
F141  FE 86        CP 86               ; expected ROM checksum
F143  20 04        JR NZ,F149
F145  16 01        LD D,01             ; flag: ROM signature present
F147  18 04        JR F14D
F149  16 00        LD D,00             ; flag: not present

; --- AMX mouse port probe ---
F14D  3E 07        LD A,07
F14F  D3 3F        OUT (3F),A          ; AY register select
F151  3E 00        LD A,00
F153  D3 7F        OUT (7F),A          ; AY data write
F155  3E 0E        LD A,0E
F157  D3 3F        OUT (3F),A
F159  DB 7F        IN A,(7F)           ; read AY register 14
F15B  FE B9        CP B9               ; AMX mouse signature?
F15D  20 04        JR NZ,F163
F15F  1E 01        LD E,01             ; flag: AMX present
F161  18 04        JR F167
F163  1E 00        LD E,00             ; flag: not present

; --- Consistency check ---
F167  7A           LD A,D
F168  93           SUB E
F169  FE 01        CP 01
F16B  20 01        JR NZ,F16E
F16D  C7           RST 0000            ; if D=1, E=0 → suspicious, reset

; --- Memory integrity test ---
F16E  21 00 00     LD HL,0000
F171  06 64        LD B,64             ; sum 100 bytes at stride 2
F173  AF           XOR A
F174  86           ADD A,(HL)
F175  23           INC HL
F176  23           INC HL
F177  10 FB        DJNZ F174
F179  57           LD D,A              ; save checksum
; ... fills memory with D, re-checksums, compares
; if checksum changed → anti-tampering detected → reset
```

### Protection Check — FDC Subroutines (F5xx)

The protection accesses the FDC directly via ports 2FFD (status) and
3FFD (data), bypassing the +3DOS ROM entirely.

```asm
; === F5CD: Send command byte to FDC ===
; Waits for RQM, checks for error, writes byte to 3FFD.
F5CD  F5           PUSH AF
F5CE  F5           PUSH AF
F5CF  ED 78        IN A,(C)            ; read FDC status (2FFD)
F5D1  87           ADD A,A             ; bit 7 (RQM) → carry
F5D2  30 FB        JR NC,F5CF          ; wait for RQM
F5D4  87           ADD A,A             ; bit 6 (DIO) → carry
F5D5  30 03        JR NC,F5DA          ; if DIO=0 (CPU→FDC), proceed
F5D7  C3 65 F4     JP F465             ; DIO=1 (FDC→CPU) = error → fail
F5DA  F1           POP AF
F5DB  06 3F        LD B,3F             ; port 3FFD
F5DD  ED 79        OUT (C),A           ; send command/parameter byte
F5DF  06 2F        LD B,2F             ; restore B for status port
F5E1  3E 05        LD A,05             ; short delay
F5E3  3D           DEC A
F5E4  00           NOP
F5E5  20 FC        JR NZ,F5E3
F5E7  F1           POP AF
F5E8  C9           RET

; === F5B0: Read result phase bytes ===
; Reads ST0, ST1, ST2, C, H, R, N into buffer at F5FA.
F5B0  21 FA F5     LD HL,F5FA          ; result buffer
F5B3  ED 78        IN A,(C)            ; read status (2FFD)
F5B5  FE C0        CP C0               ; RQM + DIO both set?
F5B7  38 FA        JR C,F5B3           ; no → wait
F5B9  06 3F        LD B,3F             ; port 3FFD
F5BB  ED 78        IN A,(C)            ; read result byte
F5BD  06 2F        LD B,2F             ; restore status port
F5BF  77           LD (HL),A           ; store result
F5C0  23           INC HL
F5C1  3E 05        LD A,05             ; delay
F5C3  3D           DEC A
F5C4  20 FD        JR NZ,F5C3
F5C6  ED 78        IN A,(C)            ; check status again
F5C8  E6 10        AND 10              ; CB (command busy) bit
F5CA  20 E7        JR NZ,F5B3          ; still busy → read more
F5CC  C9           RET

; === F51A: Recalibrate (seek to track 0) ===
F51A  01 FD 2F     LD BC,2FFD          ; status port
F51D  3E 08        LD A,08
F51F  CD CD F5     CALL F5CD           ; SENSE_INT_STATUS
F522  CD B0 F5     CALL F5B0           ; read result
F525  3E 07        LD A,07
F527  CD CD F5     CALL F5CD           ; RECALIBRATE
F52A  AF           XOR A
F52B  CD CD F5     CALL F5CD           ; unit = 0
F52E  18 10        JR F540             ; → wait for seek complete

; === F530: Seek to cylinder E ===
F530  01 FD 2F     LD BC,2FFD
F533  3E 0F        LD A,0F
F535  CD CD F5     CALL F5CD           ; SEEK command
F538  AF           XOR A
F539  CD CD F5     CALL F5CD           ; unit = 0
F53C  7B           LD A,E
F53D  CD CD F5     CALL F5CD           ; cylinder number
; --- Wait for seek complete ---
F540  3E 08        LD A,08
F542  CD CD F5     CALL F5CD           ; SENSE_INT_STATUS
F545  CD B0 F5     CALL F5B0           ; read result
F548  3A FA F5     LD A,(F5FA)         ; ST0
F54B  E6 20        AND 20              ; SE (Seek End) bit
F54D  28 F1        JR Z,F540           ; not set → keep polling
F54F  C9           RET

; === F550: Motor on with delay ===
F550  C5           PUSH BC
F551  01 FD 1F     LD BC,1FFD
F554  3E 1C        LD A,1C             ; motor on + paging bits
F556  ED 79        OUT (C),A
F558  06 02        LD B,02             ; outer loop = 2
F55A  11 00 00     LD DE,0000          ; inner loop = 65536
F55D  1B           DEC DE
F55E  7A           LD A,D
F55F  B3           OR E
F560  20 FB        JR NZ,F55D
F562  10 F6        DJNZ F55A           ; ~130K iterations ≈ spinup delay
F564  C1           POP BC
F565  C9           RET

; === F566: Set normal paging (motor off) ===
F566  01 FD 1F     LD BC,1FFD
F569  3E 14        LD A,14
F56B  ED 79        OUT (C),A
F56D  C9           RET

; === F56E: Send multi-byte FDC command from (HL), E bytes ===
F56E  7E           LD A,(HL)
F56F  CD CD F5     CALL F5CD           ; send byte
F572  23           INC HL
F573  1D           DEC E
F574  20 F8        JR NZ,F56E
F576  C9           RET

; === F589: Read sector data bytes into (HL), DE bytes ===
F589  06 3F        LD B,3F             ; data port
F58B  ED 78        IN A,(C)            ; read data byte
F58D  77           LD (HL),A           ; store
F58E  06 2F        LD B,2F             ; status port
F590  23           INC HL
F591  1B           DEC DE
F592  ED 78        IN A,(C)            ; check status
F594  F2 92 F5     JP P,F592           ; RQM not set → wait
F597  E6 20        AND 20              ; EXM (execution mode) bit
F599  C8           RET Z               ; EXM clear → data phase done
F59A  7A           LD A,D
F59B  B3           OR E
F59C  C2 89 F5     JP NZ,F589          ; more bytes → continue
; --- Drain remaining bytes ---
F59F  06 3F        LD B,3F
F5A1  ED 78        IN A,(C)            ; read and discard
F5A3  06 2F        LD B,2F
F5A5  ED 78        IN A,(C)
F5A7  F2 A5 F5     JP P,F5A5           ; wait for RQM
F5AA  E6 20        AND 20
F5AC  C2 9F F5     JP NZ,F59F          ; still in EXM → drain more
F5AF  C9           RET
```

### Protection Check — Read Sector (F4DD)

Sends a READ_DATA command to the FDC and checks the result flags.

```asm
; === F4DD: Read one sector ===
; Input: B = cylinder (C field), C = sector (R field)
; Uses command template at F601 (9 bytes).
; Returns: CF=1 success, CF=0 failure.
F4DD  D5           PUSH DE
F4DE  E5           PUSH HL
F4DF  79           LD A,C
F4E0  32 05 F6     LD (F605),A         ; patch R in template
F4E3  32 07 F6     LD (F607),A         ; patch EOT (= R, so reads 1 sector)
F4E6  78           LD A,B
F4E7  32 03 F6     LD (F603),A         ; patch C in template
F4EA  01 FD 2F     LD BC,2FFD
F4ED  21 01 F6     LD HL,F601          ; command template
F4F0  1E 09        LD E,09             ; 9 bytes
F4F2  CD 6E F5     CALL F56E           ; send command
F4F5  E1           POP HL
F4F6  ED 5B F1 F5  LD DE,(F5F1)        ; expected byte count
F4FA  CD 92 F5     CALL F592           ; read data phase (joins mid-loop)
F4FD  E5           PUSH HL
F4FE  CD B0 F5     CALL F5B0           ; read result phase
F501  E1           POP HL
F502  D1           POP DE

; === Check result flags ===
F503  3A FA F5     LD A,(F5FA)         ; ST0
F506  FE 40        CP 40               ; abnormal termination?  ← KEY CHECK
F508  20 0E        JR NZ,F518          ; no → fail
F50A  3A FB F5     LD A,(F5FB)         ; ST1
F50D  FE 80        CP 80               ; End of Cylinder?       ← KEY CHECK
F50F  20 07        JR NZ,F518          ; no → fail
F511  3A FC F5     LD A,(F5FC)         ; ST2
F514  B7           OR A                ; must be 0x00
F515  C0           RET NZ              ; non-zero → fail (carry clear)
F516  37           SCF                 ; success!
F517  C9           RET
F518  A7           AND A               ; clear carry = failure
F519  C9           RET
```

**This is where the emulation failed.** Our FDC returned ST0=0x00
instead of 0x40, so the CP 40 at F506 didn't match and the read
was treated as failed.

### FDC Command Template (F601)

```
F601: 66 00 E9 18 F6 01 F6 0A FF
       │  │  │   │  │  │  │  │  └─ DTL = FF
       │  │  │   │  │  │  │  └──── GPL = 0A
       │  │  │   │  │  │  └─────── EOT = F6 (patched = R)
       │  │  │   │  │  └────────── N   = 01 (256 bytes)
       │  │  │   │  └───────────── R   = F6 (patched per sector)
       │  │  │   └──────────────── H   = 18 (24)
       │  │  └──────────────────── C   = E9 (233, patched per track)
       │  └─────────────────────── HDS/US = 00 (head 0, unit 0)
       └────────────────────────── Command = 66 (READ_DATA, MFM, skip deleted)
```

### Protection Check — Main Flow (F2A9)

The main protection orchestrator. Reads all 18 sectors from track 33,
verifies each sector's fill byte, then loads game data from tracks 34+.

```asm
; === Set up and read track 33 ===
F2A9  F3           DI
F2AA  CD 66 F5     CALL F566           ; set 1FFD = 0x14 (normal paging)
F2AD  01 FD 2F     LD BC,2FFD          ; FDC status port
F2B0  AF           XOR A
F2B1  CD CD F5     CALL F5CD           ; send 0x00 (stray/reset)
F2B4  CD B0 F5     CALL F5B0           ; read result
F2B7  CD 50 F5     CALL F550           ; motor on + spinup delay
F2BA  CD 1A F5     CALL F51A           ; RECALIBRATE (seek track 0)
F2BD  3A F9 F5     LD A,(F5F9)         ; cylinder from SENSE_INT
F2C0  5F           LD E,A
F2C1  CD 30 F5     CALL F530           ; SEEK to track (E=cylinder)

; === Read 18 sectors in a loop ===
F2C4  LD DE,F234                       ; parameter table (3 bytes/entry)
F2C7  LD HL,4000                       ; destination buffer
F2CA  LD A,12                          ; 18 sectors
; loop:
F2CC  PUSH AF
F2CD  LD A,(DE) / LD C,A              ; R value from table
F2CF  INC DE / INC DE
F2D1  LD A,(DE) / INC DE              ; H value → patch F604
F2D3  LD (F604),A
F2D6  LD A,(F233) / LD B,A            ; C value = 0xE9 (233)
F2DA  CALL F4DD                        ; READ one sector
F2DD  JR C,F2EC                        ; success → next sector
F2DF  POP AF                           ; failure → retry
F2E0  LD A,(F5E9) / DEC A
F2E4  JP Z,F461                        ; retries exhausted → FAIL
F2E7  LD (F5E9),A
F2EA  JR F2BA                          ; recalibrate and retry all
; success:
F2EC  POP AF / DEC A
F2EE  JR NZ,F2CC                       ; loop 18 times

; === Verify sector fill bytes ===
F2FE  LD HL,4000                       ; buffer with 18×256 bytes
F301  LD DE,F235                       ; expected fill bytes (offset 1 in table)
F304  LD A,12                          ; 18 sectors
; loop:
F306  PUSH AF
F307  LD BC,0100                       ; 256 bytes per sector
F30A  LD A,(DE)                        ; expected fill byte
F30B  CPI                              ; compare A with (HL), HL++, BC--
F30D  JP NZ,F461                       ; mismatch → FAIL
F310  JP PE,F30B                       ; BC != 0 → check next byte
F313  INC DE / INC DE / INC DE         ; next 3-byte table entry
F316  POP AF / DEC A
F318  JR NZ,F306                       ; loop 18 sectors

; === Phase 3: Load game data from tracks 34+ ===
F31A  ...                              ; 3-pass loading with XOR decryption,
                                        ; checksum verification, driven by
                                        ; parameter table at F625
; === Success → enter game ===
F433  CALL F566                        ; motor off
F436  ...                              ; set up ROM 3 (48K BASIC) banking
F452  LD HL,2758 / EXX                 ; charset address
F456  LD IY,5C3A                       ; system variables
F45A  LD SP,5FFF
F45D  FB                               ; EI
F45E  JP 6400                          ; ← GAME ENTRY POINT

; === Fail path ===
F461  DI
F462  CALL F51A                        ; recalibrate
F465  LD HL,F467
F468  ; clear all memory, switch to ROM 3, play error beep, RST 0000
```

### Sector Parameter Table (F233)

3 bytes per sector: `[R, expected_fill, H]`

```
F233: E9                               ; C value (cylinder = 233)
F234: F6 51 18                         ; R=246, fill=0x51, H=24
F237: 3D FF 68                         ; R=61,  fill=0xFF, H=104
F23A: 2B 31 F0                         ; R=43,  fill=0x31, H=240
...                                     ; (18 entries total)
```

### Copyright String (F609)

```
F609: "(C) 1987 APPLEBY ASSOCIATES"
```

---

## FDC Behaviour Required

### 1. End-of-Cylinder flag (FIXED)

When READ_DATA finishes the last sector (R increments past EOT),
the FDC must set:
- ST0 bit 6 = 1 (abnormal termination)
- ST1 bit 7 = 1 (EN, End of Cylinder)

This is standard uPD765A behaviour. Fix applied in `upd765a.ts`:
`advanceSector()` sets `exHitEOT`, `finishExecution()` OR's in the flags.

### 2. Weak sector randomisation (TODO)

If the EN flag fix alone doesn't fully pass the protection, the sector
fill byte verification at F30A may also be relevant. Some sectors on
track 33 may have weak bits causing byte-level variation. Further testing
needed after the EN fix is verified.

### Investigation TODO

- [x] Disassemble the decrypted protection code
- [x] Identify root cause of failure (missing EN flag)
- [x] Fix ST0/ST1 End-of-Cylinder in `upd765a.ts`
- [ ] Test the fix end-to-end with California Games
- [ ] Verify no regression with Speedlock-protected disks
- [ ] Examine track 33 sector data for weak bit indicators
- [ ] Test other Alkatraz-protected titles

---

## Reproduction

Using MCP tools:

```
model        → +3
load         → "path/to/california-games.dsk"
breakpoint   → 0xFE10
disk_boot
continue                    ; breaks at bootstrap entry
breakpoint   → 0xF503       ; READ_DATA result check
delete_breakpoint 0xFE10
continue                    ; breaks at first sector read
memory       → 0xF5FA, 8   ; inspect ST0/ST1/ST2 result bytes
```

Expected result after fix: `F5FA: 40 80 00 ...`
