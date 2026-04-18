# Bug Tracker

## Critical

- [ ] **SNA 128K save: buffer overflow when `currentBank` is 2 or 5** — `src/snapshot/sna.ts:125,141-145`
  Buffer sized for 5 remaining banks. Skip set `{5, 2, currentBank}` collapses to 2 unique values when currentBank is 2 or 5, causing 6 banks to be written and a `RangeError` overflow.

- [ ] **SP snapshot loader: 2-byte offset error in 128K mode** — `src/snapshot/sp.ts:89,94`
  Port 0x7FFD read from offset 49192 instead of 49190. All 128K SP snapshots produce corrupted machine state.

- [ ] **TZX `pulseLen = 0` causes infinite loop / emulator hang** — `src/tape/tap.ts:323-330`
  Malformed TZX with `bit0Pulse=0` or `bit1Pulse=0` creates an unexitable while loop.

## High

- [ ] **`currentBank` wrong during +2A/+3 special paging** — `src/memory.ts:222-229,250-254`
  `bankSwitch()` and `bankSwitch1FFD()` don't update `currentBank` to match special mode, propagating wrong contention.

- [ ] **`isContended()` wrong for special paging on +2A/+3** — `src/spectrum-amstrad.ts:25-31`, `src/contention.ts:78-79`
  Only checks 0x4000-0x7FFF and 0xC000+. Contended banks at 0x0000/0x8000 in special paging modes are missed.

- [ ] **`updateSlots()` clobbers external overlay in special paging** — `src/memory.ts:154-159`
  Special-paging branch unconditionally sets `_slots[0]`; normal branch guards with `!externalRomPaged`.

## Medium

- [ ] **SNA 48K save: corrupts live memory with zeroes** — `src/snapshot/sna.ts:169-170`
  Restores stack bytes with 0 instead of original values after saving.

- [ ] **FDC `advanceSector()` returns wrong R after EOT** — `src/cores/upd765a.ts:379-382`
  `exR` incremented before EOT check, so result R = EOT+1 instead of last transferred sector.

- [ ] **FDC missing ST1 ND flag when sector not found** — `src/cores/upd765a.ts:388-391`
  `advanceSector()` returns false with no error flag when sector R+1 missing; result looks like success.

- [ ] **FDC `exN` not updated when advancing to next sector** — `src/cores/upd765a.ts:402-406`
  `exC/H/ST1/ST2` updated but `exN` retains first sector's value.

- [ ] **`contend()` misses 0xC000+ contention on 128K/+2** — `src/io-ports.ts:38-42`
  Hardcodes 0x4000-0x7FFF; should use `contention.isContended(addr)`.

- [ ] **Multiface MF1 port decoding too restrictive** — `src/peripherals/multiface.ts:99-103`
  Exact byte match on 0x9F/0x1F; real hardware only decodes A5=0, A1=1 and uses A7 for direction.

- [ ] **`cursorShiftCount` not reset on machine reset** — `src/peripherals/joysticks.ts:66`
  Caps Shift can get permanently stuck after reset.

- [ ] **128K `displayOrigin = 14362` likely 2T early** — `src/contention.ts:48`
  Should be 14364 (63 × 228), matching Amstrad timing. Shifts 128K/+2 display ~4px left.

## Low

- [ ] **SNA loader missing IM mask** — `src/snapshot/sna.ts:53`
  `cpu.im = data[25]` has no `& 0x03` unlike Z80/SZX loaders.

- [ ] **32KB ROM on +2A/+3 leaves ROM pages 2-3 as zeros** — `src/memory.ts:192-194`
  Only fills pages 0 and 1; crash on ROM page switch.

- [ ] **Tape turbo doesn't reset `beeperAccum`** — `src/spectrum.ts:659-664`
  Only resets `beeperTStatesAccum`, not `beeperAccum`.

- [ ] **GLSL `smoothstep` with reversed edges** — `src/display/webgl-renderer.ts:176-178`
  `edge0 > edge1` violates GLSL ES spec. Works on current drivers.

- [ ] **ULA `readPort` always forces bit 7 high** — `src/cores/ula.ts:154`
  Correct for Ferranti but not Amstrad gate array.

- [ ] **Multiface comment says OUT but code uses IN** — `src/peripherals/multiface.ts:5-7`

- [ ] **Floating bus returns VRAM on +2A/+3** — `src/contention.ts:151-172`
  Amstrad gate array may return 0xFF instead.
