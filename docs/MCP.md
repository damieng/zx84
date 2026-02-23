# ZX84 MCP Server

MCP (Model Context Protocol) server that wraps the ZX84 Spectrum emulator as a persistent tool server. Claude Code (or any MCP client) can drive the emulator directly — load files, step through code, inspect memory, trace I/O, and read the screen.

## Setup

Add to `.mcp.json` in the project root (already present):

```json
{
  "mcpServers": {
    "zx84": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "test/mcp-server.ts"]
    }
  }
}
```

Or run standalone:

```
npm run mcp -- [--model 48k|128k|+2|+2a|+3]
```

Defaults to `48k`. ROMs are fetched from GitHub and cached in `test/.cache/`.

## Tool Reference

### Execution

| Tool | Parameters | Description |
|------|-----------|-------------|
| `run` | `frames` (default 1) | Run N frames. Reports breakpoint or port watchpoint if hit. |
| `step_frame` | — | Run exactly one frame. Equivalent to `run frames=1`. |
| `step` | `count` (default 1) | Single-step N instructions. Returns disassembly + registers for each. |
| `continue` | `max_frames` (default 5000) | Run until a breakpoint or port watchpoint fires. Requires at least one set. |

### Registers & CPU State

| Tool | Parameters | Description |
|------|-----------|-------------|
| `registers` | — | All registers, flags, IM, IFF, halt state. Banking info on 128K+ models. |
| `set_register` | `register`, `value` | Set a register: A F AF B C BC D E DE H L HL SP PC IX IY. |

Values are parsed as hex if they contain `a-f` or start with `0x`/`$`, otherwise decimal.

### Memory

| Tool | Parameters | Description |
|------|-----------|-------------|
| `memory` | `address`, `length` (default 64) | Hex dump with ASCII sidebar. |
| `peek` | `address` | Read one byte. |
| `poke` | `address`, `value` | Write one byte. |
| `find` | `hex_bytes` | Search all 64KB for a byte sequence (e.g. `"CD0050"`). Up to 64 matches. |

### Disassembly

| Tool | Parameters | Description |
|------|-----------|-------------|
| `disassemble` | `address` (default PC), `lines` (default 16) | Z80 disassembly with byte display. Current PC marked with `>`. |

### Breakpoints & Watchpoints

| Tool | Parameters | Description |
|------|-----------|-------------|
| `breakpoint` | `address` (optional) | Set a PC breakpoint, or list all if no address given. |
| `delete_breakpoint` | `address` (optional) | Remove one breakpoint, or clear all. |
| `port_watchpoint` | `port` (optional) | Set a port watchpoint (breaks on IN **or** OUT to that port), or list all. |
| `delete_port_watchpoint` | `port` (optional) | Remove one port watchpoint, or clear all. |

### I/O Ports

| Tool | Parameters | Description |
|------|-----------|-------------|
| `port_out` | `port`, `value` | Write to I/O port. Triggers bank switching, FDC, etc. Shows banking state on 128K+. |
| `port_in` | `port` | Read from I/O port. |

### Media

| Tool | Parameters | Description |
|------|-----------|-------------|
| `load` | `file`, `drive` (default `"0"`) | Load TAP, TZX, SNA, Z80, SZX, or DSK. TAP/TZX reset and start playback. DSK inserts into FDC. SZX restores a full snapshot. |
| `save` | `file` | Save current machine state to a SZX snapshot file. `.szx` extension added automatically. |
| `disk_boot` | — | +3 only. Runs 500 frames to reach the startup menu, presses Enter on "Loader". |
| `disk_trace` | `file` | All-in-one: switch to +3, mount DSK, boot to Loader, arm FE10h breakpoint + 3FFDh port watchpoint. |
| `eject` | `target` (`tape`/`disk`), `drive` | Eject tape or disk from drive A/B. |

### Input

| Tool | Parameters | Description |
|------|-----------|-------------|
| `key` | `name`, `frames` (default 5) | Press and hold a key for N frames. Supports combos like `"shift+2"` or `"sym+p"`. |
| `type` | `text` | Type a string of characters. Handles letters, digits, symbols, and `\n` for Enter. |

Key names: `a`–`z`, `0`–`9`, `enter`, `space`, `shift`, `sym`, `backspace`, `left`, `right`, `up`, `down`, `capslock`, `escape`

### Tracing

| Tool | Parameters | Description |
|------|-----------|-------------|
| `trace` | `mode` (`full`/`contention`/`portio`) | Start a trace. |
| `stop_trace` | — | Stop and return results. Traces over 200 lines are written to a file. |
| `frame_trace` | — | Run one frame logging every instruction: T-state, beam position, contention delays, border changes, and VRAM writes. Always writes to file. |

- **full** — every instruction executed
- **contention** — contended cycle info
- **portio** — port I/O only (great for FDC debugging)

### Screen

| Tool | Parameters | Description |
|------|-----------|-------------|
| `ocr` | — | Bitmap OCR of the screen. |

### Model

| Tool | Parameters | Description |
|------|-----------|-------------|
| `model` | `target` (optional) | Show current model, or switch to `48k`/`128k`/`+2`/`+2a`/`+3`. Switching creates a fresh machine. |

### Disk Protection

| Tool | Parameters | Description |
|------|-----------|-------------|
| `weak` | `track`, `sector` (optional) | Mark sector(s) as weak (randomised on each read). Omit sector to mark entire track. |

### Peripherals

| Tool | Parameters | Description |
|------|-----------|-------------|
| `multiface` | `action` (`on`/`off`/`nmi`/`status`) | Enable/disable the Multiface peripheral, press its NMI button, or show status. Supports MF1, MF128, MF3. |

## Workflows

### Trace a +3 copy-protection scheme (one step)

```
disk_trace   → file: "path/to/game.dsk"
continue     → runs to FE10h bootstrap entry
registers
disassemble
continue     → runs to next FDC command byte (port 3FFDh watchpoint)
...
```

`disk_trace` does everything in one call: switch to +3, mount the DSK, boot to Loader, set FE10h breakpoint + 3FFDh port watchpoint. No manual setup needed.

### Save and restore a checkpoint

```
save         → file: "C:/tmp/checkpoint.szx"
... (investigation continues) ...
load         → file: "C:/tmp/checkpoint.szx"   (restores full machine state)
```

Checkpoints let you rewind to a known state without re-running hundreds of frames.

### Boot a +3 disk and break at entry (manual)

```
model        → switch to +3
load         → file: "path/to/game.dsk"
breakpoint   → address: "FE10"
disk_boot
continue
registers
disassemble
```

The +3 bootstrap loads sector T0/S0/R1 into `FE00h` and jumps to `FE10h`. Breaking there catches the moment of entry.

### Inspect bootstrap code

```
memory       → address: "FE00", length: 256
disassemble  → address: "FE00", lines: 32
```

### Trace FDC I/O

```
trace        → mode: "portio"
run          → frames: 50
stop_trace
```

Shows every IN/OUT to the FDC ports (`0x2FFD`, `0x3FFD`).

### Step through code

```
breakpoint   → address: "FE10"
continue
step         → count: 1
step
step
```

Each step returns: `ADDR  MNEMONIC            A=xx F=xx BC=xxxx DE=xxxx HL=xxxx SP=xxxx T=n`

### Search for a signature

```
find         → hex_bytes: "C93E01"     (RET / LD A,1)
find         → hex_bytes: "4C6F6164"   ("Load")
```

### Bank switching on 128K/+3

```
port_out     → port: "0x7FFD", value: "0x10"   (select ROM 1)
port_out     → port: "0x7FFD", value: "0x03"   (select RAM bank 3 at C000)
```

The response includes the new banking state.

### Watch for bank/paging changes

```
port_watchpoint  → port: "7FFD"
continue
```

Fires on any `OUT (7FFD), *` — catches ROM switches, RAM bank changes, paging locks. Check `registers` at each hit to see the new banking state.

### Test weak-sector protection

```
load         → file: "protected.dsk"
weak         → track: 33, sector: 246
disk_boot
continue
```

## Address Parsing

All address/value string parameters are parsed as **hex by default**:

- `FE10` → 0xFE10
- `4000` → 0x4000
- `0x1234` or `$1234` → hex (explicit prefix also works)
- There is no decimal mode — use hex throughout

## Architecture

The server (`test/mcp-server.ts`) creates a single `Spectrum` instance that persists across all tool calls. State (breakpoints, loaded files, memory modifications) accumulates naturally. Switching models with the `model` tool creates a fresh machine.

The server communicates over stdio using the MCP SDK (`@modelcontextprotocol/sdk`). Claude Code spawns it automatically based on `.mcp.json`.
