# TODO

## Done

### Core Emulation
- [x] Z80 CPU — full instruction set, passes zexdoc/zexall
- [x] 48K memory model (flat 64KB)
- [x] 128K memory model with 8 RAM banks + 2 ROM pages
- [x] +2, +2A, +3 memory models with extended ROM paging
- [x] Bank switching via port 0x7FFD with paging lock
- [x] +2A/+3 special paging modes (all-RAM configurations)
- [x] ROM write protection
- [x] Contended memory timing (48K: 0x4000-0x7FFF, 128K: odd banks)
- [x] Floating bus emulation (port 0xFF reads during ULA access)
- [x] I/O contention delay patterns

### Peripherals
- [ ] Interface 1
- [ ] SpecDrum
- [ ] RAM Music Machine
- [ ] Printers
- [ ] Multiface 1/2/+3
- [ ] Beta Disc
- [ ] Disciple/Plus-D
- [ ] VTX5000
- [ ] RS232

### Hardware
- [ ] Pentagon
- [ ] Scorpion
- [ ] ZX80 ?
- [ ] ZX81
- [ ] Timex models
- [ ] +3 Ghost fix
- [ ] External 3" / 3.5" drive

### Video
- [x] ULA display rendering (256x192 bitmap + attributes)
- [x] Border color
- [x] Flash attribute (16-frame toggle)
- [x] WebGL renderer with integer scaling (1x/2x/3x)
- [x] CRT filter (scanlines, aperture grille/RGB mask, barrel distortion, brightness/contrast)
- [x] Configurable dot pitch and curvature modes
- [x] Sub-frame precision rendering (per-scanline for rainbow effects)
- [x] Multiple border sizes (none/standard/full)
- [ ] Save screen as PNG or GIF (animated flash)

### Audio
- [x] Beeper via ULA port bit 4
- [x] DC-blocking high-pass filter on beeper output
- [x] AY-3-8912 three-channel sound (128K)
- [x] AY envelope generator with all shapes
- [x] AY stereo panning modes (ABC, ACB, BAC, mono)
- [x] Audio-buffer-driven frame pacing (no drift)
- [x] AudioWorklet-based audio processing
- [ ] Tape drive sounds
- [ ] Disk drive sounds
- [ ] 3 Channel AY visualizer
- [ ] Save music as .AY?

### Input
- [x] Keyboard matrix (8 half-rows, PC key mapping)
- [x] Extended PC key mappings (`;`, `:`, `'`, `#`, `?`, `@`, `~`, `{`, `}`, `-`, `+`, `=`, `_`, `[`, `]`)
- [x] ESC as BREAK (CAPS SHIFT + SPACE)
- [x] Kempston joystick (port 0x1F)
- [x] Cursor joystick (keys 5/6/7/8/0)
- [x] Sinclair IF2 joystick (keys 1/2/3/4/5)
- [x] Sinclair 1 joystick (keys 6/7/8/9/0)
- [x] On-screen dpad with mouse and touch support
- [x] Gamepad API support for physical controllers (dual player)
- [x] Drag-and-drop file loading
- [ ] Mouse as Kempston mouse
- [ ] Mouse as lightgun (Op Wolf?)
- [ ] Mouse as lightpen

### File Formats
- [x] .sna snapshots (48K and 128K)
- [x] .z80 snapshots (v1, v2, v3 with decompression)
- [x] .tap tape images with block parsing
- [x] .tzx tape format (standard blocks)
- [x] .dsk disk images (+3 only)
- [x] ZIP archives with deflate via DecompressionStream
- [x] ZIP file picker dialog for multi-file archives
- [x] ROM trap at 0x0556 for instant tape loading
- [ ] +3DOS BIOS trap mode for disk operations

### Persistence
- [x] ROM storage in IndexedDB (per model)
- [x] Snapshot caching in localStorage
- [x] Last-loaded file restoration on startup
- [x] UI state persistence (model, scale, display settings, pane layout)
- [x] Custom font storage in localStorage
- [ ] Save RAM block (e.g. Screen)

### Debugger
- [x] CPU register display with tooltips
- [x] System variables viewer
- [x] Memory layout viewer (128K banking state)
- [x] Real-time disassembly at PC
- [x] Breakpoints (double-click to toggle, visual indicators)
- [x] Run to cursor (right-click context menu)
- [x] Step Into / Step Over / Step Out
- [x] Execution tracing (Full, Contention, Port I/O modes)
- [x] Loop detection and analysis
- [x] Breakpoint auto-pause

### Activity Monitoring
- [x] Activity LEDs (keyboard, Kempston, tape EAR, LOAD trap, beeper, AY, disk)
- [x] RST 16 character capture with overlay
- [x] Pixel OCR transcription mode
- [x] Tape deck status display with block list
- [x] Disk drive status (+3: motor, head, track, sector, operation)
- [x] T-states per frame indicator
- [x] Clock speed display (MHz)
- [x] Turbo mode (~50MHz)

### UX
- [x] Model switching (48K, 128K, +2, +2A, +3)
- [x] Collapsible/draggable sidebar panes
- [x] Pane visibility persistence
- [x] Snapshot save/download
- [x] Floppy drive sound effects (+3)
- [x] Status bar with visual feedback
- [x] Play/pause emulation control

### Fonts
- [ ] Current detection
- [ ] Save current
- [ ] Real-Time Replacement

---

## To Do

### Accuracy
- [ ] Per-scanline border color changes (currently sub-frame VRAM writes only)
- [ ] Interrupt timing refinement (IM2 with proper vector table reads)
- [ ] Snow effect (register pair corruption on ULA clash)

### File Formats
- [ ] .szx snapshot format
- [ ] .tzx advanced blocks (turbo loaders, direct recording, pure tone)

### Display
- [ ] Fullscreen mode

### Input
- [ ] Virtual keyboard overlay (mobile)
- [ ] Key mapping customization UI

### UX
- [ ] URL query parameter loading (e.g. ?tap=url)
- [ ] Mobile-responsive layout
- [ ] PWA / offline support

### Developer
- [ ] Memory viewer / hex editor
- [ ] BASIC program listing viewer
- [ ] Performance profiling overlay (fps, frame budget)
