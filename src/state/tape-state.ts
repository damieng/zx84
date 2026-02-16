/**
 * Tape State - tape deck control signals.
 *
 * Tracks tape loading, playback, and position:
 * - Tape loaded/name/blocks
 * - Playback state (playing/paused)
 * - Position within tape
 */

import { createSignal } from 'solid-js';
import type { TapeBlock } from '@/tape/tap.ts';

export const [tapeLoaded, setTapeLoaded] = createSignal(false);
export const [tapeName, setTapeName] = createSignal('');
export const [tapeBlocks, setTapeBlocks] = createSignal<TapeBlock[]>([]);
export const [tapePosition, setTapePosition] = createSignal(0);
export const [tapePaused, setTapePaused] = createSignal(true);
export const [tapePlaying, setTapePlaying] = createSignal(false);
