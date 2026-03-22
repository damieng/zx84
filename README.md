# ZX84

**A ZX Spectrum emulator for your browser.**

https://zx84.envytech.workers.dev

Experience the legendary ZX Spectrum with authentic CRT filtering, and a powerful integrated debugger. Built from scratch in TypeScript with zero runtime dependencies.

![ZX Spectrum Models](https://img.shields.io/badge/Models-48K%20%7C%20128K%20%7C%20%2B2%20%7C%20%2B2A%20%7C%20%2B3-blue)
![File Formats](https://img.shields.io/badge/Formats-SNA%20%7C%20Z80%20%7C%20SZX%20%7C%20TAP%20%7C%20TZX%20%7C%20DSK%20%7C%20ZIP-green)

This project has been extensively developed using AI - specifically Claude Code.

---

## ✨ Features

### 🎮 Complete Spectrum Family
- **48K** — The original rubber-key classic
- **128K / +2** — 128KB RAM, AY sound chip, improved BASIC
- **+2A / +3** — Built-in disk drive support with full +3DOS emulation

### 🕹️ Authentic Hardware Emulation
- **Z80 CPU** — Cycle-accurate with contended memory timing
- **ULA** — Precise video rendering with floating bus emulation
- **AY-3-8912** — 3-channel programmable sound chip (128K models)
- **Beeper** — 1-bit audio with DC-blocking filter
- **uPD765A FDC** — Full floppy disk controller (+3 only)

### 📂 Universal File Support
Load your software instantly with drag-and-drop:
- **Snapshots**: `.sna` (48K/128K), `.z80` (v1/v2/v3), `.szx` (ZX-State)
- **Tapes**: `.tap`, `.tzx` with instant ROM-trap loading
- **Disks**: `.dsk` for +3 models (standard & extended formats)
- **Archives**: `.zip` files with automatic extraction

### 🎨 Authentic CRT Display
Relive the 80s with customizable visual filters:
- **Scanlines** — Adjustable horizontal line intensity
- **Phosphor Masks** — RGB aperture grille or shadow mask patterns
- **Curvature** — Authentic barrel distortion
- **Brightness/Contrast** — Fine-tune the picture
- **Border Modes** — None, standard, or full (for overscan effects)
- **Sub-frame Rendering** — Pixel-perfect rainbow effects including Nirvana+

### 🎵 Crystal-Clear Audio
- **AudioWorklet** — Low-latency, glitch-free sound
- **Stereo Modes** — ABC, ACB, BAC, or mono mixing
- **Volume Control** — Individual beeper and AY levels
- **Frame Pacing** — Audio-buffer-driven timing (no drift)

### 🕹️ Controller Support
Play your way with multiple input options:
- **Keyboard** — Full PC keyboard mapping with extended symbols
  - `;`, `:`, `'`, `#`, `?`, `@`, `~`, `{`, `}`, `-`, `+`, `=`, `_`, `[`, `]`
  - `ESC` as BREAK (CAPS SHIFT + SPACE)
- **Joystick Emulation** — Kempston, Cursor, Sinclair IF2, Sinclair 1
- **Gamepad** — Dual physical controller support via Gamepad API
- **On-screen D-Pad** — Touch and mouse controls

### 🔧 Powerful Debugger
Built-in development tools for reverse engineering and learning:
- **Breakpoints** — Double-click to set, visual indicators
- **Stepping** — Step Into, Step Over, Step Out
- **Run to Cursor** — Right-click any instruction
- **Live Disassembly** — Real-time Z80 code view at PC
- **Register Inspector** — All CPU registers with tooltips
- **Memory Viewer** — Banking state and layout (128K)
- **Execution Tracing** — Full, Contention, or Port I/O modes
- **Loop Detection** — Automatic stuck-loop analysis

### 📊 Activity Monitoring
Watch your Spectrum work in real-time:
- **Activity LEDs** — Keyboard, Kempston, Tape, Beeper, AY, Disk
- **Tape Deck** — Block list, position, play/pause control
- **Disk Drive** — Motor, head, track, sector, operation status
- **Performance** — T-states/frame, clock speed (MHz)
- **Turbo Mode** — ~50MHz for fast-loading

### 💾 Smart Persistence
- **Auto-save** — ROMs stored in IndexedDB
- **Last Session** — Restores your last loaded file on startup
- **UI State** — Model, scale, display settings, pane layout
- **Custom Fonts** — Load and store `.ch8` font files

### 🎯 Transcription Tools
Extract text and graphics from running programs:
- **Pixel OCR** — Live character recognition from screen

---

## 🚀 Getting Started

### Installation

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Quick Start

1. **Choose a Model** — Select 48K, 128K, +2, +2A, or +3 from the hardware pane
2. **Load a ROM** — Click "Load ROM" and select the appropriate ROM file for your model
3. **Load Software** — Drag and drop a `.sna`, `.z80`, `.szx`, `.tap`, `.tzx`, `.dsk`, or `.zip` file onto the window

That's it! For tape files, the emulator will start playback automatically.

### Keyboard Controls

- **ESC** — BREAK (stops tape loading)
- **Arrow Keys** — Mapped to CAPS SHIFT + 5/6/7/8
- **Backspace** — DELETE (CAPS SHIFT + 0)
- **All symbols** — Extended mappings for `;:'"#?@~{}-=_[]`

---

## 🎮 Controls

### Debugger
- **Play/Pause** — Run or pause emulation
- **Step Into** — Execute one instruction (when paused)
- **Step Over** — Execute, stepping over CALLs (when paused)
- **Step Out** — Run until RET (when paused)
- **Double-click** — Toggle breakpoint on disassembly line
- **Right-click** — Context menu with "Run to here"
- **Trace** — Select mode (Full, Contention, Port I/O, Loop Analysis)

### Display
- **Scale** — 1x to 4x integer scaling
- **Border** — None, Standard, or Full
- **Scanlines** — 0-100% intensity
- **Curvature** — Off, Low, Medium, High
- **Mask Type** — None, RGB, Aperture Grille
- **Sub-frame** — Enable for rainbow/raster effects

### Audio
- **Volume** — 0-100% master volume
- **Stereo Mode** — ABC, ACB, BAC, Mono

---

## 🏗️ Build for Production

```bash
npm run build     # TypeScript check + Vite build → dist/
npm run preview   # Serve production build locally
```

---

## 📜 License

[MIT](LICENSE)

---

## 🙏 Acknowledgments

Built with inspiration from the ZX Spectrum community and based on extensive hardware documentation. Special thanks to all the homebrew developers keeping the Spectrum alive!

**Enjoy your trip back to 1984! 🎉**
