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
const _currentDiskInfo = createSignal<DskImage | null>(null);
export const currentDiskInfo = _currentDiskInfo[0];
export const setCurrentDiskInfo = _currentDiskInfo[1];

const _currentDiskName = createSignal('');
export const currentDiskName = _currentDiskName[0];
export const setCurrentDiskName = _currentDiskName[1];

const _driveAStatus = createSignal('');
export const driveAStatus = _driveAStatus[0];
export const setDriveAStatus = _driveAStatus[1];

// Drive B
const _currentDiskInfoB = createSignal<DskImage | null>(null);
export const currentDiskInfoB = _currentDiskInfoB[0];
export const setCurrentDiskInfoB = _currentDiskInfoB[1];

const _currentDiskNameB = createSignal('');
export const currentDiskNameB = _currentDiskNameB[0];
export const setCurrentDiskNameB = _currentDiskNameB[1];

const _driveBStatus = createSignal('');
export const driveBStatus = _driveBStatus[0];
export const setDriveBStatus = _driveBStatus[1];

// Disk info HTML (for UI display)
const _diskInfoHtml = createSignal('');
export const diskInfoHtml = _diskInfoHtml[0];
export const setDiskInfoHtml = _diskInfoHtml[1];

const _driveHtml = createSignal('');
export const driveHtml = _driveHtml[0];
export const setDriveHtml = _driveHtml[1];
