# TODO

## High Priority

### Core Features
- [ ] Fullscreen mode
- [ ] Mobile-responsive layout
- [ ] Virtual keyboard overlay (mobile/tablet)
- [ ] URL query parameter loading (e.g. `?tap=url`)

### File Formats
- [ ] `.szx` snapshot format
- [ ] `.tzx` advanced blocks (turbo loaders, direct recording, pure tone)

### Display Enhancements
- [ ] Save screen as PNG
- [ ] Save screen as animated GIF (flash support)
- [ ] Per-scanline border color changes (full rainbow effects)

### Audio Enhancements
- [ ] 3-channel AY visualizer
- [ ] Save music as `.ay` format

### Debugger
- [ ] Memory viewer / hex editor
- [ ] BASIC program listing viewer
- [ ] Watch expressions / conditional breakpoints

---

## Medium Priority

### Input Devices
- [ ] Kempston mouse emulation
- [ ] Light gun support (Op Wolf, etc.)
- [ ] Light pen emulation
- [ ] Key mapping customization UI

### Fonts
- [ ] Auto-detect current font from memory
- [ ] Save current font to `.ch8`
- [ ] Real-time font replacement

### Persistence
- [ ] Save individual RAM blocks (e.g., screen memory)

### Performance
- [ ] Performance profiling overlay (FPS, frame budget, T-state usage)

### UX Polish
- [ ] PWA / offline support
- [ ] Recent files list
- [ ] Better mobile touch controls

---

## Low Priority / Future

### Additional Hardware Models
- [ ] Pentagon (Russian clone with extended timing)
- [ ] Scorpion (256KB RAM)
- [ ] Timex TS2068 / TC2048
- [ ] ZX80 (stretch goal)
- [ ] ZX81 (stretch goal)

### Peripherals
- [ ] Interface 1 (RS232, network, microdrives)
- [ ] Beta Disc interface
- [ ] Disciple / Plus-D disk interface
- [ ] Multiface 1/2/+3 (snapshot/poke hardware)
- [ ] SpecDrum (8-bit DAC)
- [ ] RAM Music Machine (6-channel sample playback)
- [ ] VTX5000 speech synthesizer
- [ ] Printer support (ZX Printer, Epson, etc.)

### Hardware Fixes
- [ ] +3 Ghost fix (artifact reduction)
- [ ] External 3" / 3.5" drive support

### Sound Enhancements
- [ ] Tape motor/relay sounds
- [ ] Enhanced floppy drive sounds (seek, read, write)

---

## Accuracy Improvements

### Timing & Edge Cases
- [ ] Snow effect (register corruption on ULA memory contention clash)
- [ ] Interrupt timing refinement (IM2 vector table reads)
- [ ] Accurate +3 memory contention on special paging modes

---

## Notes

### Completed Recently
See README.md for full feature list. Recent additions include:
- Breakpoints and debugger stepping
- Execution tracing with loop detection
- Extended keyboard mappings
- Drag-and-drop file loading
- Sub-frame precision rendering
- Activity monitoring LEDs
- Turbo mode

### Won't Do
- Cloud save/sync (privacy concerns, keep it local-first)
- Social features (out of scope)
- ROM hosting (legal issues)
