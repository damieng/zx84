/**
 * Tape loader detection — auto-start tape playback for custom loaders.
 *
 * Watches for edge-detection loop patterns in port 0xFE reads to detect
 * when a custom loader (Speedlock, etc.) is actively trying to read the
 * tape. Based on FUSE's loader.c (Philip Kendall, GPL).
 *
 * Detection logic (tape NOT playing):
 *   Consecutive reads within 500T with B delta ±1/0 → after 10, auto-start.
 *   B is the timeout counter in edge-detection loops; normal keyboard
 *   polling doesn't touch B in a tight loop like this.
 *
 * Auto-stop is deliberately NOT implemented here. TZX pause-0 and
 * stop-if-48k blocks handle tape stops; trying to infer "loader finished"
 * from port-read gaps produces false positives (loaders do byte-processing
 * between edges that easily exceeds any fixed T-state threshold).
 */

/** Max T-states between consecutive reads to count as "tight loop" */
const DETECT_GAP = 500;

/** Consecutive qualifying reads to trigger auto-start */
const START_THRESHOLD = 10;

export class LoaderDetector {
  /** T-states of last port 0xFE read */
  private lastTStatesRead = -100000;

  /** B register value at last read */
  private lastBRead = 0;

  /** Count of consecutive qualifying reads */
  private successiveReads = 0;

  /**
   * Called on each IN from port 0xFE.
   * Returns true when a custom loader edge-detection loop is detected
   * and the tape should be auto-started.
   */
  onPortRead(tstates: number, bReg: number): boolean {
    const gap = tstates - this.lastTStatesRead;
    const bDelta = bReg - this.lastBRead;

    this.lastTStatesRead = tstates;
    this.lastBRead = bReg;

    // B delta of ±1 or 0 is typical for edge-detection loops
    // (INC B / DEC B as timeout counter, or unchanged within the loop body)
    const standardBDelta = bDelta === 1 || bDelta === -1 || bDelta === 0;

    if (gap <= DETECT_GAP && standardBDelta) {
      this.successiveReads++;
      if (this.successiveReads >= START_THRESHOLD) {
        this.successiveReads = 0;
        return true;
      }
    } else {
      this.successiveReads = 0;
    }

    return false;
  }

  /**
   * Called at frame end to adjust T-state tracking across frame boundaries.
   * Subtracts the frame length so the gap calculation remains correct.
   */
  onFrameEnd(frameLength: number): void {
    this.lastTStatesRead -= frameLength;
  }

  /** Reset state — called on tape play/stop/rewind */
  reset(): void {
    this.lastTStatesRead = -100000;
    this.lastBRead = 0;
    this.successiveReads = 0;
  }
}
