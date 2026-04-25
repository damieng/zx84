# ZX84 Timing Comparison Report

Comparison of ZX84 emulator timing against the
[web-spec timing reference](https://github.com/mikedaley/web-spec/wiki/ZX-Spectrum-Timing).

---

## 1. Summary of Findings

| Area | Status | Notes |
|------|--------|-------|
| 48K frame constants | **Match** | — |
| 128K/+2 frame constants | **Match** | — |
| +2A/+3 separate timing | **Fixed** | `TIMING_PLUS2A` with `contentionStart: 14361`, `displayOrigin: 14364` |
| +2A/+3 interrupt length (32T) | **Fixed** | `TIMING_PLUS2A.intLength: 32` |
| 128K/+2 interrupt length (36T) | **Fixed** | `TIMING_128K.intLength: 36` |
| 48K interrupt length (32T) | **Fixed** | `TIMING_48K.intLength: 32` |
| INT window enforcement | **Fixed** | `spectrum.ts` clears `intPending` after window closes |
| Contention pattern (Ferranti) | **Match** | `[6,5,4,3,2,1,0,0]` |
| Contention pattern (Amstrad) | **Fixed** | `[1,0,7,6,5,4,3,2]` — different from Ferranti |
| I/O contention (Ferranti) | **Match** | Four-case scheme preserved |
| I/O contention (Amstrad) | **Fixed** | No I/O contention (`hasIOContention: false`) |
| +2A/+3 alternate contention (banks 4-7) | **Fixed** | `spectrum-amstrad.ts`: `isContended() { return bank >= 4; }` |
| Floating bus T-state adjust | **Fixed** | `floatingBusAdjust: -1` (48K), `+1` (128K+) |
| Interrupt response (IM 0/1/2) | **Match** | — |
| Scanline structure | **Match** | — |
| AY clock | **Match** | — |

---

## 2. Detailed Differences

### 2.1 — Separate Timing for +2A/+3 Models (**Fixed**)

Implemented `TIMING_PLUS2A` in `src/contention.ts`:

| Parameter | 128K / +2 | +2A / +3 |
|-----------|-----------|----------|
| contentionStart | 14,361 | 14,361 |
| displayOrigin | 14,362 | **14,364** |
| intLength | 36 T-states | 32 T-states |
| tStatesPerLine | 228 | 228 |
| tStatesPerFrame | 70,908 | 70,908 |
| floatingBusAdjust | +1 | +1 |

The `Contention` constructor selects timing via `variant.timing`. The +2A/+3 has a
separate `displayOrigin: 14364` (contentionStart + 3T pipeline delay) while
`contentionStart` remains 14361 (when the ULA fetch actually begins).

**Files:** `src/contention.ts`, `src/variants/spectrum-amstrad.ts`

---

### 2.2 — INT Window Length (**Fixed**)

Implemented in `src/spectrum.ts`. The frame loop computes
`intWindowEnd = frameStart + timing.intLength` and clears `intPending`
when `cpu.tStates >= intWindowEnd`.

Model-dependent `intLength` values:

| Model | INT window |
|-------|------------|
| 48K | 0–31 (32 T-states) |
| 128K / +2 | 0–35 (36 T-states) |
| +2A / +3 | 0–31 (32 T-states) |

**Files:** `src/contention.ts` (timing struct), `src/spectrum.ts` (frame loop)

---

### 2.3 — +2A/+3 Alternate Contention Scheme (**Fixed**)

Implemented via `MachineVariant` in `src/variants/spectrum-amstrad.ts`:

1. **Memory contention applies to banks 4–7** — the Amstrad gate array
   contends the upper RAM chips (`isContended() { return bank >= 4; }`).
2. **No I/O contention** — `hasIOContention: false`. The Amstrad gate array
   only applies contention when MREQ is active, and MREQ is not asserted
   during I/O operations.
3. **Different contention pattern** — `[1,0,7,6,5,4,3,2]` instead of the
   Ferranti `[6,5,4,3,2,1,0,0]`.

**Files:** `src/variants/spectrum-amstrad.ts`, `src/contention.ts`

---

### 2.4 — Floating Bus T-State Adjustment (**Fixed**)

Implemented `floatingBusAdjust` field in `MachineTiming`:

| Model | Floating bus adjust |
|-------|-------------------|
| 48K | **−1** T-state |
| 128K / +2 / +2A / +3 | **+1** T-state |

Applied in `floatingBusRead()` at `src/contention.ts`:
```typescript
const offset = frameTStates - t.contentionStart + t.floatingBusAdjust;
```

**Files:** `src/contention.ts`

---

## 3. Items That Already Match

These aspects are correctly implemented and need no changes:

| Aspect | 48K Value | 128K Value | +2A/+3 Value | Status |
|--------|-----------|------------|--------------|--------|
| T-states/frame | 69,888 | 70,908 | 70,908 | Correct |
| T-states/line | 224 | 228 | 228 | Correct |
| Total scanlines | 312 | 311 | 311 | Correct |
| contentionStart | 14,335 | 14,361 | 14,361 | Correct |
| displayOrigin | 14,336 | 14,362 | 14,364 | Correct |
| Contention pattern (Ferranti) | `[6,5,4,3,2,1,0,0]` | same | n/a | Correct |
| Contention pattern (Amstrad) | n/a | n/a | `[1,0,7,6,5,4,3,2]` | Correct |
| Active display lines | 192 | 192 | 192 | Correct |
| Active display T-states/line | 128 | 128 | 128 | Correct |
| I/O contention (Ferranti, 4 patterns) | All 4 cases | same | n/a | Correct |
| I/O contention (Amstrad) | n/a | n/a | none | Correct |
| IM 0/1 response | 13T | 13T | 13T | Correct |
| IM 2 response | 19T | 19T | 19T | Correct |
| Contended memory (48K) | 0x4000–0x7FFF | — | — | Correct |
| Contended banks (128K/+2) | — | odd banks (1,3,5,7) | — | Correct |
| Contended banks (+2A/+3) | — | — | banks 4–7 | Correct |
| AY clock | — | 1,773,400 Hz | 1,773,400 Hz | Correct |
| EI one-instruction delay | yes | yes | yes | Correct |
| Flash period | 16 frames | 16 frames | 16 frames | Correct |
| INT window enforcement | 32T | 36T | 32T | Correct |
| Floating bus adjust | −1 | +1 | +1 | Correct |

---

## 4. Implementation History

All phases have been completed:

### Phase 1: +2A/+3 timing constants ✅
- `TIMING_PLUS2A` added in `src/contention.ts`
- `TIMING_48K` and `TIMING_128K` updated with `intLength` and `floatingBusAdjust`
- `MachineTiming` gained `displayOrigin` field for models where pixel output
  starts later than the ULA fetch

### Phase 2: INT window enforcement ✅
- `spectrum.ts` frame loop computes `intWindowEnd` and clears `intPending`
  when the window expires

### Phase 3: Floating bus adjustment ✅
- `floatingBusAdjust` applied in `floatingBusRead()`

### Phase 4: +2A/+3 alternate contention ✅
- `src/variants/spectrum-amstrad.ts`: banks 4–7 contended, no I/O contention,
  Amstrad contention pattern `[1,0,7,6,5,4,3,2]`
- Model-specific logic extracted into `MachineVariant` strategy objects
  (`src/variants/`) rather than inline `if (model)` checks

### Key design decisions

- **`contentionStart` vs `displayOrigin`**: For +2A/+3, the ULA fetch starts at
  T=14361 but pixel output begins at T=14364 (3T pipeline delay). Both values
  are tracked separately in `MachineTiming`. The reference's recommendation of
  `contentionStart: 14364` was refined to keep 14361 as the fetch start and add
  `displayOrigin: 14364` for rendering alignment.

- **No I/O contention on Amstrad**: Rather than the simplified two-case scheme
  (ULA port → contend, non-ULA → no contention), the code has `hasIOContention:
  false` — no I/O contention at all. The Amstrad gate array only applies
  contention when MREQ is active, and MREQ is not asserted during I/O operations.
