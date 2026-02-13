# TODO

## Done

### Core Emulation
- [x] Z80 CPU — full instruction set, passes zexdoc/zexall
- [x] 48K memory model (flat 64KB)
- [x] 128K memory model with 8 RAM banks + 2 ROM pages
- [x] Bank switching via port 0x7FFD with paging lock
- [x] ROM write protection

### Video
- [x] ULA display rendering (256x192 bitmap + attributes)
- [x] Border color
- [x] Flash attribute (16-frame toggle)
- [x] WebGL renderer with integer scaling (1x/2x/3x)
- [x] CRT filter (scanlines, aperture grille, barrel distortion, vignette)

### Audio
- [x] Beeper via ULA port bit 4
- [x] DC-blocking high-pass filter on beeper output
- [x] AY-3-8910 three-channel sound (128K)
- [x] AY envelope generator with all shapes
- [x] AY stereo panning modes
- [x] Audio-buffer-driven frame pacing (no drift)

### Input
- [x] Keyboard matrix (8 half-rows, PC key mapping)
- [x] Kempston joystick (port 0x1F)
- [x] Cursor joystick (keys 5/6/7/8/0)
- [x] Sinclair IF2 joystick (keys 1/2/3/4/5)
- [x] Sinclair 1 joystick (keys 6/7/8/9/0)
- [x] On-screen dpad with mouse and touch support

### File Formats
- [x] .sna snapshots (48K and 128K)
- [x] .z80 snapshots (v1, v2, v3 with decompression)
- [x] .tap tape images with block parsing
- [x] ZIP archives with deflate via DecompressionStream
- [x] ZIP file picker dialog for multi-file archives
- [x] ROM trap at 0x0556 for instant tape loading
- [x] TAP auto-load (auto-types LOAD "" on 48K, ENTER on 128K)

### Persistence
- [x] ROM storage in IndexedDB (per model)
- [x] Snapshot caching in localStorage
- [x] UI state persistence (model, scale, CRT toggle)

### Diagnostics
- [x] Stuck-loop detector with PC sampling
- [x] Minimal Z80 disassembler for loop display
- [x] Activity LEDs (keyboard, Kempston, tape, beeper, AY)

---

## To Do

### Accuracy
- [ ] Contended memory timing (48K: 0x4000-0x7FFF, 128K: odd banks)
- [ ] Floating bus emulation (port 0xFF reads during ULA access)
- [ ] Per-scanline border rendering (racing-the-beam effects)
- [ ] Interrupt timing (IM2 with proper vector table reads)
- [ ] Snow effect (register pair corruption on ULA clash)

### File Formats
- [ ] .tzx tape format (turbo loaders, direct recording, pure tone blocks)
- [ ] .szx snapshot format
- [ ] .dsk / +3 disk images
- [ ] Drag-and-drop file loading

### Audio
- [ ] Migrate ScriptProcessorNode to AudioWorklet
- [ ] Tape audio playback (for turbo loaders that bypass ROM)
- [ ] Configurable AY stereo mode in UI

### Display
- [ ] Fullscreen mode
- [ ] Aspect ratio correction option (4:3)
- [ ] Screenshot capture / download

### Input
- [ ] Gamepad API support for physical controllers
- [ ] Virtual keyboard overlay (mobile)
- [ ] Key mapping customization

### UX
- [ ] Drag-and-drop files onto the page
- [ ] Recent files list
- [ ] URL query parameter loading (e.g. ?tap=url)
- [ ] Download/export current snapshot
- [ ] Mobile-responsive layout
- [ ] PWA / offline support

### Developer
- [ ] Debugger (breakpoints, step, register watch)
- [ ] Memory viewer / hex editor
- [ ] BASIC program listing viewer
- [ ] Performance profiling overlay (fps, frame budget)
