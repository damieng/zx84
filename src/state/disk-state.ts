/**
 * Disk State - floppy disk status signals.
 *
 * Tracks disk images loaded in drive A and B:
 * - Disk info (geometry, tracks, sectors)
 * - Disk names
 * - Drive status
 */

import { createSignal } from 'solid-js';
import type { DskImage } from '@/plus3/dsk.ts';

// Drive A
export const [currentDiskInfo, setCurrentDiskInfo] = createSignal<DskImage | null>(null);
export const [currentDiskName, setCurrentDiskName] = createSignal('');
export const [driveAStatus, setDriveAStatus] = createSignal('');

// Drive B
export const [currentDiskInfoB, setCurrentDiskInfoB] = createSignal<DskImage | null>(null);
export const [currentDiskNameB, setCurrentDiskNameB] = createSignal('');
export const [driveBStatus, setDriveBStatus] = createSignal('');

// Disk info HTML (for UI display)
export const [diskInfoHtml, setDiskInfoHtml] = createSignal('');
export const [driveHtml, setDriveHtml] = createSignal('');
