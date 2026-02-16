/**
 * IndexedDB + localStorage helpers for ROM/file persistence.
 */

const DB_NAME = 'zx84';
const DB_VERSION = 1;
const STORE_NAME = 'roms';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbSave(key: string, data: Uint8Array): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function dbLoad(key: string): Promise<Uint8Array | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export function getSaved(key: string, fallback: string): string {
  try { return localStorage.getItem(`zx84-${key}`) ?? fallback; } catch { return fallback; }
}

export function setSaved(key: string, value: string): void {
  try { localStorage.setItem(`zx84-${key}`, value); } catch { /* */ }
}

export async function persistLastFile(data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave('last-file', data);
    localStorage.setItem('zx84-last-file', filename);
  } catch { /* quota or write error */ }
}

export async function restoreLastFile(): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem('zx84-last-file');
    if (!name) return null;
    const data = await dbLoad('last-file');
    if (!data) return null;
    return { data, name };
  } catch { return null; }
}

export function clearLastFile(): void {
  try {
    localStorage.removeItem('zx84-last-file');
  } catch { /* */ }
}

// ── Per-media persistence (tape, disk A, disk B) ─────────────────────

export async function persistTape(data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave('tape-file', data);
    localStorage.setItem('zx84-tape-file', filename);
  } catch { /* quota or write error */ }
}

export async function restoreTape(): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem('zx84-tape-file');
    if (!name) return null;
    const data = await dbLoad('tape-file');
    if (!data) return null;
    return { data, name };
  } catch { return null; }
}

export function clearTape(): void {
  try {
    localStorage.removeItem('zx84-tape-file');
    dbSave('tape-file', new Uint8Array(0)).catch(() => {});
  } catch { /* */ }
}

export async function persistDisk(unit: number, data: Uint8Array, filename: string): Promise<void> {
  try {
    const suffix = unit === 0 ? 'a' : 'b';
    await dbSave(`disk-${suffix}-file`, data);
    localStorage.setItem(`zx84-disk-${suffix}-file`, filename);
  } catch { /* quota or write error */ }
}

export async function restoreDisk(unit: number): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const suffix = unit === 0 ? 'a' : 'b';
    const name = localStorage.getItem(`zx84-disk-${suffix}-file`);
    if (!name) return null;
    const data = await dbLoad(`disk-${suffix}-file`);
    if (!data || data.length === 0) return null;
    return { data, name };
  } catch { return null; }
}

export function clearDisk(unit: number): void {
  try {
    const suffix = unit === 0 ? 'a' : 'b';
    localStorage.removeItem(`zx84-disk-${suffix}-file`);
    dbSave(`disk-${suffix}-file`, new Uint8Array(0)).catch(() => {});
  } catch { /* */ }
}
