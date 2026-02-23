# Memory Slots Refactor Plan

Eliminate the `flat[]`/`ramBanks[]` dual-copy pattern. Make `ramBanks[n]` the
single source of truth for each RAM bank. The CPU accesses memory through four
slot pointers that reference `ramBanks`/`romPages` directly — no copies.

---

## The Problem

`flat[]` and `ramBanks[]` hold the same data in different states of freshness:

- CPU writes land in `flat[]` (live)
- `ramBanks[n]` holds stale data until `saveToRAMBanks()` is manually called
- Every bank switch copies 16KB out (`flat` → `ramBanks[old]`) and 16KB in
  (`ramBanks[new]` → `flat`)
- `applyBanking()` does up to 4 × 16KB copies just to "sync" state that
  should never diverge
- If any snapshot/save path forgets `saveToRAMBanks()`, you silently serialise
  stale data — no error, wrong output

---

## The Insight

If `slots[n]` is a **reference** to `ramBanks[bank]` rather than a copy, then:

- CPU writes through `slots[n][offset]` land directly in `ramBanks[bank]`
- A bank switch is `slots[3] = ramBanks[newBank]` — one pointer update, 0 bytes
  copied
- `ramBanks[n]` is always live and correct
- `saveToRAMBanks()` is never needed
- `applyBanking()` becomes `setupSlots()`: four reference assignments, no copy

---

## New `SpectrumMemory` Layout

```typescript
class SpectrumMemory {
  ramBanks: Uint8Array[];    // 8 × 16KB — single source of truth, always live
  romPages: Uint8Array[];    // 1–4 × 16KB ROM pages (read-only)

  // The 4 slot pointers. These ARE the memory map.
  // They reference ramBanks/romPages directly — no data is copied here.
  slots: Uint8Array[];       // [slot0, slot1, slot2, slot3]

  // Write-protect offset per slot:
  //   0x0000 = fully writable (RAM slot)
  //   0x2000 = protect first 8KB (Multiface ROM+RAM slot)
  //   0x4000 = fully read-only (ROM slot; max offset is 0x3FFF so always blocked)
  slotWriteBase: number[];
}
```

### CPU read (in `installMemoryHooks`)

```typescript
return memory.slots[addr >> 14][addr & 0x3FFF];
```

### CPU write

```typescript
const slot = addr >> 14, offset = addr & 0x3FFF;
if (offset < memory.slotWriteBase[slot]) return;  // ROM/MF-ROM protection
memory.slots[slot][offset] = val & 0xFF;
```

`slotWriteBase` handles all write-protection cases uniformly:

| Slot type            | `slotWriteBase` | Effect                              |
|----------------------|-----------------|-------------------------------------|
| Normal ROM           | `0x4000`        | All writes discarded (0–0x3FFF < 0x4000 always) |
| Normal RAM           | `0x0000`        | All writes pass (0 < 0 never true)  |
| Multiface ROM+RAM    | `0x2000`        | 0x0000–0x1FFF discarded, 0x2000+ pass |
| Special paging RAM@0 | `0x0000`        | Fully writable                      |

---

## Key Changes

### `bankSwitch()` — Before vs. After

**Before** — copies 16KB, handles a bank-5/bank-2 live-alias edge case:
```typescript
if (oldBank !== newBank) {
  this.saveSlot(0xC000, oldBank);       // 16KB copy: flat → ramBanks[old]
  if (oldBank === 5) this.loadSlot(0x4000, 5);  // re-copy live bank 5
  if (newBank === 5) this.saveSlot(0x4000, 5);  // ...and other direction
  this.loadSlot(0xC000, newBank);       // 16KB copy: ramBanks[new] → flat
}
```

**After** — pointer update only:
```typescript
if (oldBank !== newBank) this.slots[3] = this.ramBanks[newBank];
if (newROM !== this.currentROM) {
  this.slots[0] = this.romPages[newROM];  // slotWriteBase[0] stays 0x4000
}
```

The bank-5/bank-2 aliasing mess disappears — there is no `flat` to diverge from
`ramBanks`.

### `setupSlots()` replaces `applyBanking()`

**Before** — 4 × 16KB copies.

**After** — four reference assignments:
```typescript
private setupSlots(): void {
  if (this.specialPaging) {
    const banks = SPECIAL_MODES[(this.port1FFD >> 1) & 3];
    for (let i = 0; i < 4; i++) {
      this.slots[i] = this.ramBanks[banks[i]];
      this.slotWriteBase[i] = 0;
    }
    return;
  }
  const rom = this.is128K ? this.romPages[this.currentROM] : this.romPages[1];
  this.slots[0] = rom;                          this.slotWriteBase[0] = 0x4000;
  this.slots[1] = this.ramBanks[5];             this.slotWriteBase[1] = 0;
  this.slots[2] = this.ramBanks[2];             this.slotWriteBase[2] = 0;
  this.slots[3] = this.ramBanks[this.currentBank]; this.slotWriteBase[3] = 0;
}
```

### `screenBank` — Before vs. After

**Before** — conditional mess checking whether the screen bank is in `flat` or
in `ramBanks`, returning different subarray views.

**After** — always correct, always live:
```typescript
get screenBank(): Uint8Array {
  return this.ramBanks[(this.port7FFD & 0x08) ? 7 : 5];
}
```

### Multiface — Simplified

**Before**: `pageIn` saves a 16KB copy of `flat[0..16383]` into `savedSlot0`.
`pageOut` copies it back. `io-ports.ts` syncs MF RAM into `flat` before every
bank switch while MF is paged in.

**After**: `mfPage` is a combined 16KB buffer (8KB ROM + 8KB RAM as a view).
`pageIn`/`pageOut` save/restore a slot reference — no copy.

```typescript
// pageIn:
this.savedSlot0Ref = slots[0];         // save reference — no 16KB copy
this.savedWriteBase0 = slotWriteBase[0];
slots[0] = this.mfPage;
slotWriteBase[0] = 0x2000;             // protect ROM half

// pageOut:
slots[0] = this.savedSlot0Ref;         // restore reference — no 16KB copy
slotWriteBase[0] = this.savedWriteBase0;
// mfRam is a view into mfPage[0x2000..] so writes through the slot went
// directly into mfRam — no sync needed
```

Bank switches while MF is paged in only change `slots[3]`. Slot 0 holds the
`mfPage` reference and is untouched. The entire pre/post-bankswitch MF sync
dance in `io-ports.ts` disappears.

### Snapshots

`saveToRAMBanks()` calls removed from `sna.ts`, `szx.ts`. `ramBanks[]` is
always the authoritative, current data.

The 48K SNA PC-push trick (`flat[sp] = pc; flat.subarray(0x4000, 0x10000)`)
is rewritten:
- Write 2 bytes via `memory.writeByte(sp, ...)` (new helper, routes through slots)
- Read 48KB directly from `ramBanks[5]` + `ramBanks[2]` + `ramBanks[0]`
  (same pattern the 128K path already uses)

`applyBanking()` calls in snapshot loaders → `setupSlots()` calls.

### `cpu.memory` — The Debug Path

`cpu.memory` (the 64KB flat view) is used by the disassembler, basic parser,
OCR, and debug manager. These are non-hot paths called on pauses and UI updates.

New method `SpectrumMemory.buildFlat(): Uint8Array`:
```typescript
buildFlat(): Uint8Array {
  const out = new Uint8Array(65536);
  out.set(this.slots[0], 0x0000);
  out.set(this.slots[1], 0x4000);
  out.set(this.slots[2], 0x8000);
  out.set(this.slots[3], 0xC000);
  return out;
}
```

Debug callers call `memory.buildFlat()` once and pass the result down. For
single-byte reads in hot emulation paths (e.g. ROM version detection), add
`memory.readByte(addr): number`.

---

## Cons / Risks

### 1. Hot-path performance regression (unknown magnitude)

**Old**: `s.cpu.memory[addr]` — single typed array read; JIT-friendly, likely
inlined to a single bounds-checked load.

**New**: `memory.slots[addr >> 14][addr & 0x3FFF]` — load JS array, then load
typed array, plus a bit shift and a mask. This is two indirections instead of
one.

The read8/write8 closures are already function calls (not inlined), so there is
overhead there already. Modern V8 is good at inline-caching short fixed arrays,
so the `slots[4]` access may be nearly free. But this is unknown until measured.
**Mitigation**: benchmark before and after; if there is a regression, expose
`slots` as a local variable in the closures via closure capture so the JIT sees a
stable reference.

### 2. `buildFlat()` is still a "don't forget to call" API

`saveToRAMBanks()` is a required pre-snapshot call that is easy to forget.
`buildFlat()` is a required pre-debug-access call that is easy to forget.
The difference: forgetting `buildFlat()` shows stale data in the debugger.
Forgetting `saveToRAMBanks()` silently corrupts a saved snapshot. So the new
"forgotten call" failure mode is much less severe — but it exists.

**Mitigation**: where possible, thread `memory.buildFlat()` through the single
call site that enters debug display mode (e.g., on `step()` or on UI pause
event), not scattered across every consumer.

### 3. Invasive refactor — regression surface

Touches ~11 files across core, io, peripherals, snapshots, and bridge layers.
That is a large diff with plenty of opportunity to introduce subtle bugs in
seldom-tested paths (e.g. +2A special paging, Multiface+special paging, SP
format non-standard load).

**Mitigation**: existing test coverage. After the refactor, run the full test
suite (Fuse Z80 tests + snapshot round-trip tests) before declaring done.

### 4. `cpu.memory` becomes semantically misleading

Z80's `memory: Uint8Array` field currently means "live machine memory". After
the refactor it means "stale debug snapshot, valid after buildFlat()". The field
stays in Z80 for API compatibility but its semantics change. Future code that
expects it to be live will be wrong silently.

**Mitigation**: rename it to `debugMemory` or `memorySnapshot` to signal the
new contract. Or remove it from Z80 entirely and thread `buildFlat()` through
only the places that actually need it.

### 5. +2A `bankSwitch1FFD` edge case needs care

Currently `bankSwitch1FFD()` handles a special case: normal→normal mode where
the slot banks don't change but the ROM page does. In the slots model, this
becomes: `slots[0] = romPages[newROM]` if ROM changed. Straightforward, but the
existing edge-case test (line 257–262 in memory.ts) must be reproduced correctly
in `setupSlots()` / the inline ROM-change check.

### 6. `floatingBusRead` signature change

`contention.floatingBusRead(tStates, memory.flat)` currently takes the full
64KB `flat` to read VRAM data. After the refactor this becomes
`floatingBusRead(tStates, memory.screenBank)` (a 16KB bank). The offset
arithmetic inside `floatingBusRead` must be adjusted (it currently uses
absolute addresses like `0x4000 + ...`; with a 16KB bank passed, offsets need
to be relative to the bank start).

### 7. `sp.ts` non-standard 48K load path

`sp.ts` has a path that writes directly to `memory.flat.set(ramData, ramStart)`
for non-standard SP files with unusual RAM layouts (not starting at 0x4000).
This needs a `writeRange(dest, data, offset)` method on SpectrumMemory, or the
data needs to be split across slot boundaries manually.

---

## What This Eliminates

| Removed | Impact |
|---------|--------|
| `saveToRAMBanks()` and its required call sites | No more silent stale-data corruption |
| 16KB copies on every bank switch | ~2 × memcpy(16K) per switch → 0 |
| 4 × 16KB copies in `applyBanking()` | ~4 × memcpy(16K) per snapshot load → 0 |
| Bank-5/bank-2 aliasing workaround in `bankSwitch()` | 12 lines of fragile special-case logic gone |
| Complex conditional `screenBank` getter | 24 lines → 1 line |
| MF pre/post-bankswitch sync dance in `io-ports.ts` | ~12 lines per bank switch handler |
| 16KB `savedSlot0` copy in Multiface | 16KB allocation + 2 × 16KB copies per NMI gone |
| `cpu.memory = memory.flat` reassignments | 6+ scattered call sites gone |

---

## 48K Single-Array Option (optional add-on)

For 48K, `ramBanks[5]`, `ramBanks[2]`, `ramBanks[0]` can be `subarray` views
into a single 49152-byte allocation:

```typescript
const ram = new Uint8Array(49152);
this.ramBanks[5] = ram.subarray(0, 16384);
this.ramBanks[2] = ram.subarray(16384, 32768);
this.ramBanks[0] = ram.subarray(32768, 49152);
```

Snapshot code is unchanged (reads `ramBanks[5,2,0]`). No branching for 48K vs
128K. Purely a memory layout optimisation. Can be added to this refactor or as
a follow-on.

---

## Files Touched

| File | Change |
|------|--------|
| `src/memory.ts` | Add `slots`, `slotWriteBase`, `setupSlots()`, `buildFlat()`, `readByte()`, `writeByte()`; rewrite `bankSwitch()`/`bankSwitch1FFD()`; simplify `screenBank`; remove `flat`, `saveSlot()`, `loadSlot()`, `saveToRAMBanks()`, `applyBanking()` |
| `src/io-ports.ts` | `read8`/`write8` use slots + `slotWriteBase`; remove all post-bankswitch `cpu.memory = memory.flat`; remove MF pre-switch sync; `floatingBusRead` → pass `memory.screenBank` |
| `src/peripherals/multiface.ts` | `mfPage` combined buffer; `mfRam` as view into it; `pageIn`/`pageOut` take `slots`/`slotWriteBase`; remove `savedSlot0` |
| `src/spectrum.ts` | Remove `new Z80(this.memory.flat)`; `applyBanking()` → `setupSlots()`; `renderFrame(cpu.memory)` → `renderFrame(memory.screenBank, 0x4000)`; `cpu.memory[0x0556]` → `memory.readByte(0x0556)` |
| `src/emulator.ts` | Remove `applyBanking()`/`cpu.memory = memory.flat`; `memory.flat.slice(...)` → `buildFlat()` or direct bank reads |
| `src/managers/media-manager.ts` | Same as emulator.ts |
| `src/contention.ts` | `floatingBusRead` takes `Uint8Array` (screenBank, 16KB) instead of `flat` (64KB); adjust vram offsets |
| `src/snapshot/sna.ts` | Remove `saveToRAMBanks()`; rewrite 48K PC-push/dump using `writeByte()`/direct bank reads; `applyBanking()` → `setupSlots()` |
| `src/snapshot/szx.ts` | Remove `saveToRAMBanks()` |
| `src/snapshot/z80format.ts` | `applyBanking()` → `setupSlots()` |
| `src/snapshot/sp.ts` | `applyBanking()` → `setupSlots()`; replace `memory.flat.set(...)` with `writeRange()` or slot-split write |
| `src/frame-bridge.ts` | `cpu.memory` uses → `memory.buildFlat()` at entry point then thread down |
| `src/managers/debug-manager.ts` | `cpu.memory[...]` → `memory.readByte(...)` for single-byte access |
