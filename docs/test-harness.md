# ZX84 Test Harness

Headless Node.js REPL for debugging and testing Spectrum emulation without a browser.

## Starting

```
npm run harness -- [--model 48k|128k|+2|+2a|+3] [file]
```

The model is auto-detected for `.sna` files based on file size. ROMs are fetched from GitHub and cached in `test/.cache/`.

```
npm run harness -- --model +3 "E:\path\to\game.dsk"
```

## Command Reference

### Execution

| Command | Description |
|---------|-------------|
| `run [n]` | Run *n* frames (default 1) |
| `step [n]` / `s [n]` | Step *n* instructions, printing each one |
| `cont [max]` / `c [max]` | Continue until a breakpoint hits (default max 5000 frames) |

`cont` requires at least one breakpoint to be set first.

After `run`/`cont`, if a breakpoint was hit the address and frame count are printed.

---

### Registers & CPU State

| Command | Description |
|---------|-------------|
| `regs` / `r` | Show all registers, flags, IM, IFF, IR |
| `pc [addr]` | Get or set PC; if set, also prints the instruction there |
| `set <reg> <val>` | Set a register by name |

Register names for `set`: `A F AF B C BC D E DE H L HL SP PC IX IY`
Values are parsed as decimal unless they contain `a-f` or start with `0x`/`$`, in which case they are hex.

On 128K/+2/+2A/+3 models, `regs` also prints the current bank, ROM, port 0x7FFD value, and paging lock state.

---

### Memory

| Command | Description |
|---------|-------------|
| `mem <addr> [len]` / `m` | Hex dump (default 64 bytes) |
| `peek <addr>` | Read one byte |
| `poke <addr> <val>` | Write one byte |
| `find <hexbytes>` | Search all 64KB for a byte sequence (up to 64 matches) |

All addresses can be decimal, hex (`0x1234`, `$1234`, or bare `1234` with a-f digits).

---

### I/O Ports

| Command | Description |
|---------|-------------|
| `out <port> <val>` | Fire the port-out handler (triggers bank switching, etc.) |
| `in <port>` | Fire the port-in handler, print result |

On 128K+ models, `out` automatically prints the new bank/ROM state after the write. Useful for manually switching banks:

```
out 0x7FFD 0x10   ; select ROM 1
out 0x7FFD 0x03   ; select RAM bank 3 at 0xC000
```

---

### Breakpoints

| Command | Description |
|---------|-------------|
| `bp [addr]` | Set breakpoint, or list all breakpoints |
| `del [addr]` | Delete one breakpoint, or all if no address given |

Breakpoints check the PC before every instruction. Zero cost when none are set.

---

### Disassembly

| Command | Description |
|---------|-------------|
| `dis [addr] [n]` / `d` | Disassemble *n* lines from *addr* (defaults: PC, 16 lines) |

Current PC is marked with `>`.

---

### Media

| Command | Description |
|---------|-------------|
| `load <file> [unit]` | Load a TAP, TZX, SNA, Z80, or DSK file |
| `diskboot` | Boot +3 to startup menu, press Enter on Loader — runs DOS BOOT properly |
| `eject disk [0\|1\|A\|B]` | Eject disk from drive A (0) or B (1) |
| `eject tape` | Unload tape |

For DSK files the optional unit is `0`/`A`/`A:` (drive A, default) or `1`/`B`/`B:` (drive B).
File paths with spaces work — everything between `load` and the optional unit token is treated as the filename.

Loading a TAP/TZX also resets the machine and starts playback. Loading a DSK just inserts it into the FDC.

---

### Tracing

| Command | Description |
|---------|-------------|
| `trace <mode>` | Start a trace: `full`, `contention`, or `portio` |
| `stop` | Stop the trace; prints inline if ≤100 lines, else writes to `test/trace-<timestamp>.txt` |

---

### Screen

| Command | Description |
|---------|-------------|
| `screen` / `scr` | Print the RST 16 character grid as ASCII |
| `ocr` | Bitmap OCR of the screen |

---

### Miscellaneous

| Command | Description |
|---------|-------------|
| `model [m]` | Show current model, or switch to `48k`/`128k`/`+2`/`+2a`/`+3` (creates a fresh machine) |
| `key <name> [frames]` | Hold a key for *n* frames (default 5) then release |
| `subframe` / `sf` | Toggle sub-frame rendering |
| `help` / `?` | Command list |
| `quit` / `q` | Exit |

Key names: `a-z`, `0-9`, `enter`, `space`, `shift`, `sym`, `backspace`, `left`, `right`, `up`, `down`, `capslock`, `escape`/`esc`

---

## Typical Debug Workflows

### Boot a +3 disk and break at entry

```
load "E:\path\to\game.dsk"
bp FE10
diskboot
cont
regs
dis
```

`diskboot` runs the +3 startup (500 frames), then presses Enter on the Loader menu to trigger the real DOS BOOT path. The ROM loads the bootstrap sector from T0/S0/R1 into `FE00h` and jumps to `FE10h`. SP is set to `FE00h`, interrupts are disabled. Break at `FE10` to catch the moment of entry.

Note: `diskboot` requires `--model +3` (set on the command line or via `model +3` before loading).

### Inspect the loaded bootstrap sector

```
mem FE00 256
dis FE00 32
```

The sector must checksum to `3 mod 256`. Byte 15 (offset `FE0Fh`) is typically the checksum padding byte.

### Bank switching on +3

The +3 boot environment maps:

| Address | Page |
|---------|------|
| `C000–FFFF` | RAM page 3 |
| `8000–BFFF` | RAM page 6 |
| `4000–7FFF` | RAM page 7 |
| `0000–3FFF` | RAM page 4 (not ROM) |

Use `out 0x7FFD <val>` and `out 0x1FFD <val>` to switch pages manually and verify what the bootstrap is doing.

### Trace FDC I/O

```
trace portio
run 50
stop
```

Shows every IN/OUT to the FDC ports (0x2FFD, 0x3FFD) so you can see what commands the bootstrap issues.

### Step through the bootstrap

```
bp FE10
cont
s 1        ; step one instruction at a time
s
s
```

Each `s` prints: `ADDR  MNEMONIC            A=xx F=xx BC=xxxx DE=xxxx HL=xxxx SP=xxxx T=n`

### Search for a signature in memory

```
find C9 3E 01      ; look for RET / LD A,1
find 4C 6F 61 64   ; "Load"
```

---

## Address Parsing Rules

The `parseAddr` function used by all commands:

1. `0x1234` or `$1234` → hex
2. Contains any of `a–f` (case-insensitive) → hex
3. Pure digits that parse as decimal → decimal
4. Otherwise → hex

So `512`, `200h`, `0x200`, `$200` all work. `FE10` is hex (contains `e`).
