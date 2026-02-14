# ZX84

A ZX Spectrum emulator written in TypeScript for the browser. Zero runtime dependencies.

## Features

### Emulation
- **Z80 CPU** — complete instruction set including undocumented ops (passes zexdoc/zexall)
- **48K, 128K, +2, +2A, and +3 models** with full memory banking and ROM paging
- **ULA** — accurate display rendering (256x192 + border), flash attributes, beeper
- **AY-3-8910** — three-channel sound chip with envelope generator, stereo panning (128K)
- **Beeper audio** with DC-blocking filter for clean output
- **Keyboard matrix** — 8 half-rows mapped from PC keyboard
- **Joystick** — Kempston, Cursor, Sinclair IF2, Sinclair 1 with on-screen dpad
- **uPD765A FDC** — floppy disk controller for +3 disk support

### File Formats
- **.sna** — 48K and 128K snapshots
- **.z80** — versions 1, 2, 3 with decompression
- **.tap** — tape images with instant ROM-trap loading and auto-play
- **.tzx** — turbo and custom tape formats
- **.dsk** — +3 disk images (standard and extended formats)
- **.zip** — archives containing any of the above (auto-load or file picker)

### Display
- WebGL renderer with integer scaling (1x–4x)
- CRT filter — scanlines, dot masks, barrel distortion, brightness/contrast
- Custom font support (.ch8)

### Persistence
- ROMs stored in IndexedDB, survive page reloads
- Last snapshot/tape/disk and UI settings restored on startup

### Diagnostics
- Stuck-loop detector with Z80 disassembly
- Screen text transcription
- Activity LEDs for keyboard, Kempston, tape, beeper, AY, disk

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and load a ZX Spectrum ROM file to begin.

### Loading Software

1. Select your model (48K, 128K, +2, +2A, or +3)
2. Load the appropriate ROM file
3. Load a snapshot (.sna, .z80), tape (.tap, .tzx), disk (.dsk), or ZIP archive

TAP files auto-load — the emulator types `LOAD ""` (48K) or selects Tape Loader (128K) for you.

## Build

```bash
npm run build     # type-check + production build → dist/
npm run preview   # serve the production build locally
```

## Architecture

```
src/
├── main.ts              Entry point, UI wiring, persistence
├── spectrum.ts           Machine orchestrator, frame loop, audio mixing
├── memory.ts             48K/128K/+2A memory with bank switching
├── ula.ts                Display rendering, keyboard port, beeper
├── keyboard.ts           Keyboard matrix and PC key mapping
├── display.ts            WebGL renderer with CRT shader
├── audio.ts              Web Audio ring buffer
├── diagnostics.ts        Stuck-loop detector and disassembler
├── floppy-sound.ts       Floppy drive sound effects
├── plus3dos-trap.ts      +3DOS BIOS-level disk traps
├── cores/
│   ├── z80.ts            Z80 CPU (complete instruction set)
│   ├── ay-3-8910.ts      AY-3-8910 sound chip
│   └── upd765a.ts        uPD765A floppy disk controller
├── formats/
│   ├── sna.ts            .sna snapshot loader/saver
│   ├── z80format.ts      .z80 snapshot loader (v1-v3)
│   ├── tap.ts            .tap tape image parser
│   ├── tzx.ts            .tzx tape format parser
│   ├── dsk.ts            .dsk disk image parser
│   └── zip.ts            ZIP archive extraction
└── ui/
    └── zip-picker.ts     Modal file picker for ZIP contents
```

The `Spectrum` class wires everything together: CPU executes instructions, port I/O dispatches to ULA/AY/memory banking/FDC, the frame loop is paced by audio buffer fill level at 50.08 Hz, and display updates go through WebGL.

## Tech

- TypeScript with strict mode, zero runtime dependencies
- Vite for dev server and bundling
- Browser APIs: Web Audio, WebGL, IndexedDB, DecompressionStream, File API

## License

[MIT](LICENSE)
