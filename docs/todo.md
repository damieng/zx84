# TODO

## High Priority

### Core Features
- [ ] Handling DSK protection
- [ ] Fullscreen mode
- [ ] Mobile-responsive layout
- [ ] Virtual keyboard overlay (mobile/tablet)
- [ ] URL query parameter loading (e.g. `?tap=url`)

### File Formats
- [x] `.szx` snapshot format
- [ ] `.tzx` advanced blocks (turbo loaders, direct recording, pure tone)

### Display Enhancements
- [x] Save screen as PNG
- [ ] Save screen as animated GIF (flash support)
- [x] Per-scanline border color changes (full rainbow effects)

### Audio Enhancements
- [ ] 3-channel AY visualizer
- [ ] Extract music as `.ay` format???
- [ ] Log music as `.psg` format
- [ ] Log music as `.ym` format
- [ ] Log music as `.vgm` format

### Debugger
- [ ] Memory viewer / hex editor
- [x] BASIC program listing viewer
- [x] Breakpoints
- [ ] Watch expressions / conditional breakpoints

---

## Medium Priority

### Input Devices
- [ ] Kempston mouse emulation
- [ ] Light gun support (Op Wolf, etc.)
- [ ] Light pen emulation
- [ ] Key mapping customization UI

### Fonts
- [x] Font hunting
- [x] Save current font to `.ch8`
- [ ] Real-time font replacement

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
- [ ] Currah speech synthesizer
- [ ] Printer support (ZX Printer, Epson, etc.)

### Hardware Fixes
- [ ] +3 Ghost fix
- [x] External 3" / 3.5" drive support

### Sound Enhancements
- [ ] Tape motor/relay sounds
- [ ] Enhanced floppy drive sounds (seek, read, write)

---

## Accuracy Improvements

### Timing & Edge Cases
- [ ] Snow effect (register corruption on ULA memory contention clash)
- [ ] Interrupt timing refinement (IM2 vector table reads)
- [ ] Accurate +3 memory contention on special paging modes
