# ZX84 Timing Comparison Report

Comparison of ZX84 emulator timing against the
[web-spec timing reference](https://github.com/mikedaley/web-spec/wiki/ZX-Spectrum-Timing).

---

## 1. Summary of Findings

| Area | Status | Impact |
|------|--------|--------|
| 48K frame constants | **Match** | — |
| 128K/+2 frame constants | **Match** | — |
| +2A/+3 contention start | **Differs** | Floating bus & contention phase off by 3 T-states |
| +2A/+3 interrupt length | **Differs** | INT window too long (36T vs 32T) |
| 128K/+2 interrupt length | **Differs** | INT window not enforced (should be 36T window) |
| 48K interrupt length | **Differs** | INT window not enforced (should be 32T window) |
| Contention pattern | **Match** | — |
| I/O contention patterns | **Match** | — |
| +2A/+3 alternate contention | **Missing** | Wrong contention on +2A/+3 models |
| Floating bus T-state adjust | **Missing** | Floating bus reads off by 1–2 T-states |
| Interrupt response (IM 0/1/2) | **Match** | — |
| Scanline structure | **Match** | — |
| AY clock | **Match** | — |

---

## 2. Detailed Differences

### 2.1 — No Separate Timing for +2A/+3 Models

**Current behaviour:** All 128K-class models (`128k`, `+2`, `+2a`, `+3`) use
the same `TIMING_128K` constants:

```
contentionStart: 14361
tStatesPerLine:  228
tStatesPerFrame: 70908
```

**Reference says:**

| Parameter | 128K / +2 | +2A / +3 |
|-----------|-----------|----------|
| contentionStart | 14,361 | **14,364** |
| Interrupt length | **36** T-states | **32** T-states |
| tStatesPerLine | 228 | 228 |
| tStatesPerFrame | 70,908 | 70,908 |

**What to change:**
- Add a `TIMING_PLUS2A` constant with `contentionStart: 14364`.
- In the `Contention` constructor, select the right timing based on
  `isPlus2AClass(model)` vs `is128kClass(model)`.

**Files:** `src/contention.ts`

---

### 2.2 — INT Window Length Not Modelled

**Current behaviour:** The emulator fires `interrupt()` at T=0, and if it
doesn't fire (because `iff1` is false / DI is active), it stays pending
**for the entire frame**. Any `EI` instruction at any point during the frame
will immediately trigger the deferred interrupt.

**Reference says:** INT is only held LOW for a limited window:

| Model | INT window |
|-------|------------|
| 48K | 0–31 (32 T-states) |
| 128K / +2 | 0–35 (36 T-states) |
| +2A / +3 | 0–31 (32 T-states) |

If `EI` is executed after the INT window has closed, the interrupt should
**not** fire until the next frame.

**Impact:** Programs that do `DI` ... long work ... `EI` could incorrectly
receive an interrupt mid-frame instead of waiting for the next frame boundary.
This is uncommon but can affect cycle-exact demos and timing-sensitive loaders.

**What to change:**
- Add a model-dependent `intLength` field to `MachineTiming` (32 or 36).
- In the frame loop, only check `intPending` while
  `cpu.tStates - frameStart < intLength`.
- After the window closes, clear `intPending`.

**Files:** `src/contention.ts` (timing struct), `src/spectrum.ts` (frame loop)

---

### 2.3 — +2A/+3 Alternate Contention Scheme

**Current behaviour:** All models use the same ULA contention logic — the
standard 48K/128K scheme where contention applies during the 128 T-state
active display window based on the `[6,5,4,3,2,1,0,0]` pattern.

**Reference says:** The +2A and +3 use an **alternate contention** scheme. The
key differences in the Amstrad gate-array ULA (vs the original Ferranti ULA):

1. **Memory contention only applies to port-contended addresses** — the +2A/+3
   gate array applies contention to pages that are in contended memory banks
   (banks 4, 5, 6, 7 — the "even" RAM chips), not just bank 5.
2. **I/O contention is simplified** — on +2A/+3, all ULA port accesses
   (bit 0 = 0) get a fixed contention pattern regardless of the high byte.
   Non-ULA ports get no contention at all (the four-pattern scheme doesn't
   apply).
3. **The contention pattern itself is the same** `[6,5,4,3,2,1,0,0]` but the
   set of contended banks differs.

**What to change:**
- In `isContended()`, for +2A/+3: contend banks 4, 5, 6, 7 (not 1, 3, 5, 7).
- In `applyIOContention()`, for +2A/+3: use the simplified two-case scheme
  (ULA port → contend; non-ULA port → no contention).
- This requires `isPlus2AClass(model)` checks in the contention class.

**Files:** `src/contention.ts`

---

### 2.4 — Floating Bus T-State Adjustment

**Current behaviour:** `floatingBusRead()` calculates the ULA fetch position
directly from `cpuTStates - frameStartTStates - contentionStart` with no
per-model adjustment.

**Reference says:**

| Model | Floating bus adjust |
|-------|-------------------|
| 48K | **−1** T-state |
| 128K / +2 / +2A / +3 | **+1** T-state |

This offset accounts for the timing difference between when the CPU sees the
data bus value and when the ULA actually drives it. Without this, floating bus
reads return data from the wrong phase of the ULA fetch cycle (e.g., returning
a pixel byte when the software expects an attribute byte, or vice versa).

**What to change:**
- Add a `floatingBusAdjust` field to `MachineTiming` (−1 for 48K, +1 for 128K+).
- Apply it in `floatingBusRead()` when calculating the frame-relative offset.

**Files:** `src/contention.ts`

---

## 3. Items That Already Match

These aspects are correctly implemented and need no changes:

| Aspect | 48K Value | 128K Value | Status |
|--------|-----------|------------|--------|
| T-states/frame | 69,888 | 70,908 | Correct |
| T-states/line | 224 | 228 | Correct |
| Total scanlines | 312 | 311 | Correct |
| contentionStart | 14,335 | 14,361 | Correct |
| Contention pattern | `[6,5,4,3,2,1,0,0]` | same | Correct |
| Active display lines | 192 | 192 | Correct |
| Active display T-states/line | 128 | 128 | Correct |
| I/O contention (4 patterns) | All 4 cases | same | Correct |
| IM 0/1 response | 13T | 13T | Correct |
| IM 2 response | 19T | 19T | Correct |
| Contended memory (48K) | 0x4000–0x7FFF | — | Correct |
| Contended banks (128K) | — | odd banks | Correct |
| AY clock | — | 1,773,400 Hz | Correct |
| EI one-instruction delay | yes | yes | Correct |
| Flash period | 16 frames | 16 frames | Correct |

---

## 4. Implementation Plan

### Phase 1: Add +2A/+3 timing constants (low risk, localised)

1. **Add `TIMING_PLUS2A`** in `src/contention.ts`:
   ```typescript
   export const TIMING_PLUS2A: MachineTiming = {
     cpuClock: 3546900,
     tStatesPerFrame: 70908,
     tStatesPerLine: 228,
     contentionStart: 14364,
     intLength: 32,
     floatingBusAdjust: 1,
   };
   ```
2. **Update `TIMING_48K`** and **`TIMING_128K`** with the new fields:
   - 48K: `intLength: 32`, `floatingBusAdjust: -1`
   - 128K: `intLength: 36`, `floatingBusAdjust: 1`
3. **Update `Contention` constructor** to select timing using
   `isPlus2AClass()` → `TIMING_PLUS2A`, else `is128kClass()` → `TIMING_128K`,
   else → `TIMING_48K`.

### Phase 2: Enforce INT window length (medium risk, affects frame loop)

4. **Modify frame loop** in `src/spectrum.ts`:
   - Track the INT window end: `intWindowEnd = frameStart + timing.intLength`.
   - Only check `intPending` while `cpu.tStates < intWindowEnd`.
   - After the window, set `intPending = false`.
5. **Test** with known timing-sensitive programs (multicolor demos, Speedlock
   loaders) to ensure no regressions.

### Phase 3: Floating bus adjustment (low risk, one-line change)

6. **Apply `floatingBusAdjust`** in `floatingBusRead()`:
   ```typescript
   const offset = frameTStates - t.contentionStart + t.floatingBusAdjust;
   ```
7. **Test** with programs that use floating bus detection (e.g., Arkanoid,
   Cobra, Sentinel).

### Phase 4: +2A/+3 alternate contention (medium risk, contention logic)

8. **Update `isContended()`** for +2A/+3:
   - Contend banks 4, 5, 6, 7 (even RAM chips) instead of 1, 3, 5, 7.
   - Bank 5 (0x4000–0x7FFF) remains contended on all models.
9. **Update `applyIOContention()`** for +2A/+3:
   - ULA port (bit 0 = 0): apply contention (regardless of high byte).
   - Non-ULA port: no contention (regardless of high byte).
10. **Test** with +3 disk software that is sensitive to contention timing.

### Phase 5: Validation

11. Run the **FUSE timing tests** (if available as TAP/TZX) to validate
    contention and interrupt timing across all models.
12. Verify **Speedlock**, **Alkatraz**, and **multicolor demos** still work.
13. Check **floating bus detection** in games that use it for copy protection.

---

## 5. Risk Assessment

| Change | Risk | Reason |
|--------|------|--------|
| +2A/+3 contentionStart | Low | Only shifts contention phase by 3T on two models |
| INT window enforcement | Medium | Could break programs relying on late-frame EI+INT |
| Floating bus adjust | Low | Only affects floating bus reads, most software ignores them |
| +2A/+3 alt contention | Medium | Changes which banks are contended; could break +3 software if wrong |

**Recommendation:** Implement in the order above (phases 1–4), testing after
each phase. The INT window change (phase 2) is the most likely to cause
regressions, so test thoroughly before moving on.
