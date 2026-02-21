# ZX84 — Claude Code Guidelines

## Engineering Philosophy

**Favour thoughtful abstractions over minimal patches.**

When fixing a bug or adding a feature, don't just slap a band-aid on the nearest
line of code.  Step back and ask:

1. **Where does this logic belong?**  If multiple subsystems need the same
   information (e.g. "is the program loading from tape?"), put the logic in
   *one* place and expose it through a clean interface.  Don't scatter inline
   heuristics across io-ports.ts, spectrum.ts, and frame-bridge.ts.

2. **Single source of truth.**  Classification / masking / decoding of hardware
   signals (port addresses, ULA reads, FDC status) should live in the subsystem
   that owns them.  Consumers read the result; they don't re-derive it.

3. **Don't duplicate or half-duplicate.**  If you see two places computing the
   same thing with slightly different thresholds or conditions, unify them.
   A broken duplicate is worse than no abstraction at all.

4. **Reliable > minimal.**  The right fix often touches more files than the
   smallest possible diff.  That's fine.  A refactor that prevents the next
   three bugs is better than a one-liner that invites them.

5. **Understand before changing.**  Read the surrounding code.  Trace the data
   flow.  Know *why* the current code is the way it is before proposing changes.
   Don't guess at fixes — if you're not sure, investigate first.

## Architecture Notes

- `src/cores/` — hardware cores (Z80, ULA, AY, FDC).  Pure emulation logic,
  no UI or framework dependencies.
- `src/spectrum.ts` — the main machine, owns the frame loop and orchestrates
  cores.  This is the authority on machine state.
- `src/io-ports.ts` — wires CPU port I/O to the appropriate cores.  Should be
  thin glue, not business logic.
- `src/frame-bridge.ts` — transfers per-frame state from the emulator to the
  Solid.js UI.  Read-only consumer of `activity` / machine state.
- `src/contention.ts` — ULA memory/IO contention timing.
- `test/mcp-server.ts` — MCP server for Claude Code integration.

## Common Pitfalls

- **Port 0xFE is shared**: keyboard reads and tape EAR reads both hit the ULA
  port.  Distinguish them by the high byte of the port address (0xFF = no row
  selected = EAR-only read; anything else selects keyboard half-rows).
- **`memory.flat[]` vs `memory.ramBanks[]`**: `flat` is live; `ramBanks` is a
  snapshot updated only on bank switches.  Always call `saveToRAMBanks()` before
  reading from `ramBanks` (e.g. saving snapshots).
- **Contention models differ**: Ferranti ULA (48K/128K/+2) vs Amstrad gate
  array (+2A/+3) have different patterns, different contended banks, and
  different IO contention rules.
