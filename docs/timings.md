# ZX Spectrum Interrupt & Frame Timing Reference

## Frame Structure

| Model | T-states/frame | Lines | T-states/line |
|-------|---------------|-------|---------------|
| 48K   | 69,888        | 312   | 224           |
| 128K  | 70,908        | 311   | 228           |

Frame reference point (T=0) is when the ULA asserts INT. The CPU responds at the
next instruction boundary after INT fires.

## Interrupt Response Cost

| Mode | T-states | Notes |
|------|----------|-------|
| IM 0 | 13T      | ACK(7T) + push |
| IM 1 | 13T      | ACK(7T) + push, jumps to 0x0038 |
| IM 2 | 19T      | ACK(7T) + push + vector read (2×3T) |

## Contention Reference Points

| Model | contentionStart | First contended byte |
|-------|----------------|----------------------|
| 48K   | 14,335T        | Screen row 0, col 0  |
| 128K  | 14,361T        | Screen row 0, col 0  |

Contention applies to addresses in contended RAM banks — 0x4000–0x7FFF on 48K,
odd banks (1,3,5,7) on 128K/+2, and banks 4–7 on +2A/+3. On Ferranti models
(48K/128K/+2), ULA port 0xFE reads/writes also incur I/O contention. Amstrad
models (+2A/+3) have no I/O contention. ROM and uncontended RAM are never delayed.

## EI Delay

On real Z80, interrupts are suppressed for one instruction after EI. This is
critical for loaders and multicolor engines.

**Implementation:** `eiDelay` flag set by EI, cleared after the *next instruction
executes* in the run loop (not in `interrupt()`). `interrupt()` returns 0 if
`eiDelay` is set but does not clear it — the run loop clears it.

**Why this matters:**

- **End-of-load crash**: Loaders run with DI, then do `EI / JP start_game`. Without
  the delay, INT fires between EI and JP, entering the interrupt handler with the
  loader's stack state still active → crash. With the delay, JP executes first.

- **EI → HALT pattern**: Common in main loops (`EI ; HALT`). HALT counts as the
  "one instruction", so INT fires normally when the CPU is waiting in HALT.
  No special handling needed.

- **Mid-frame EI**: If EI executes mid-frame (not at the frame boundary), eiDelay
  is cleared by the very next instruction in the run loop, so `interrupt()` fires
  at T=0 of the next frame as expected. No net timing shift.

**The wrong approach** is clearing `eiDelay` inside `interrupt()` — that ties the
delay to one *frame boundary check* instead of one *instruction*, causing
mid-frame EI to defer the interrupt a whole extra frame.

## intPending Mechanism

On real hardware INT is held low for ~32T. If IFF1 is false when INT fires (code
is inside DI), the CPU accepts it as soon as IFF1 becomes true again.

The emulator models this with a frame-scoped `intPending` flag (local variable
in the `runFrame()` loop in `spectrum.ts`, not a Z80 instance variable):

1. Frame start: `interrupt()` called on the Z80.
   - If it **fires** (IFF1=true, eiDelay=false) → `intPending = false`.
   - If blocked by **DI** (`!IFF1`) → `intPending = true`.
   - If blocked by **eiDelay** → leave `intPending` unchanged.
2. During the instruction loop: after each instruction, if `intPending && IFF1`,
   call `interrupt()`. If it fires, `intPending = false`.
3. When `cpu.tStates >= intWindowEnd`, `intPending` is cleared (INT window
   expired).

**Why the eiDelay case must NOT set intPending:**

If EI is the last instruction in frame N, `eiDelay=true` persists past the frame
boundary. At T=0 of frame N+1, `interrupt()` returns 0 (eiDelay). If we set
`_intPending=true` here, the pending fires mid-frame N+1 (after eiDelay clears)
at the wrong T-state — causing alternating correct/incorrect interrupt timing and
visible flicker (observed in Daley Thompson's Decathlon title screen).

The correct behaviour: when eiDelay blocks at T=0, the first instruction of
the new frame clears eiDelay, and T=0 of frame N+2 fires normally. No interrupt
is "lost" — it just fires one frame later, which is what real hardware does
(EI suppresses the current frame's interrupt, next frame fires at T=0).

---

## Multicolor Engines

### Bifrost++

**Mechanism:** IM 2 with a 257-byte vector table where every entry points to the
same handler address. The handler runs per-frame, updating attribute bytes one
character row at a time using carefully timed delay loops.

**What it needs:**
- Interrupt fires at a *consistent* T-state offset from frame start (T=0 ± a few T).
  Bifrost calibrates its delay loops assuming INT fires at T=0.
- EI delay must work correctly: the engine's main loop ends with `EI` and then
  either `HALT` or a short spin loop. The interrupt must not fire *before* that
  next instruction completes.
- IM 2 with a flat 257-byte vector table in RAM (every byte set to the handler's
  page address). The CPU uses `I` register for the high byte, the data bus value
  (0xFF on Spectrum) for the low byte → vector address = `(I << 8) | 0xFF`.

**What it does NOT need:**
- Sub-frame scanline-accurate interrupt delivery — it does its own timing inside
  the handler.
- Any special port or contention behaviour beyond what normal code needs.

**Failure symptoms without correct EI delay:**
- Attribute colors appear on wrong scanlines (timing shifted by whole frames).
- Flickering or color smearing if the interrupt fires mid-handler on re-entry.

---

### Buzzsaw

**Mechanism:** Similar to Bifrost — NMI-style tight interrupt timing using IM 2.
Uses a vector table and a per-frame handler that writes attribute data with
precise T-state loops. Slightly different vector table structure from Bifrost.

**What it needs:** Same requirements as Bifrost — consistent T=0 interrupt arrival
and correct EI delay. Very sensitive to any shift in when the interrupt fires
relative to frame start.

**Failure symptoms:** Same as Bifrost — flickering, wrong colors on wrong rows.

---

### Nirvana / Nirvana+

**Mechanism:** Also IM 2, but instead of a single handler with a timing loop,
Nirvana uses a *different handler address for each character row*. The vector
table has different values so each row's interrupt jumps to a different handler
that writes that specific row's attributes. This eliminates the need for per-row
delay loops entirely.

**What it needs:**
- IM 2 vector table with distinct addresses per row — requires the full 257-byte
  table to be set up correctly and the I register pointing at it.
- The interrupt *still* needs to fire at a consistent frame position, but
  Nirvana is somewhat more tolerant of small T-state shifts than Bifrost/Buzzsaw
  because it doesn't rely on counting cycles inside the handler.
- EI delay still matters for the same end-of-frame EI pattern.

**What it does NOT need:**
- Cycle-exact delay loops inside the handler (unlike Bifrost/Buzzsaw).
- Any special NMI hardware — it uses the standard ULA maskable interrupt.

**Why Nirvana was unaffected by the initial EI delay bug:** Nirvana's handlers are
very short (write attributes, return), so even if the interrupt timing shifted by
a few T-states or one frame, the effect could re-sync on the next frame. Bifrost
and Buzzsaw have longer handlers with delay loops that drift visibly if timing
is off.

---

## Summary: What All Three Engines Share

| Requirement | Bifrost++ | Buzzsaw | Nirvana |
|-------------|-----------|---------|---------|
| IM 2 flat vector table | ✓ | ✓ | ✓ (varied) |
| I register set correctly | ✓ | ✓ | ✓ |
| 0xFF on data bus for vector | ✓ | ✓ | ✓ |
| EI delay (1 instruction) | critical | critical | important |
| INT fires at consistent T=0 | critical | critical | tolerant |
| Sub-frame scanline accuracy | not needed | not needed | not needed |
| Cycle-exact handler loops | external | external | not needed |
