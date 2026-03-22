/**
 * Pane order and collapse state, persisted to localStorage.
 */

import { createSignal } from 'solid-js';

export interface PanePosition {
  id: string;
  sidebar: 'left' | 'right';
}

const ORDER_KEY = 'zx84-pane-order';
const COLLAPSE_KEY = 'zx84-collapsed';

// ── Default pane layout ─────────────────────────────────────────────────

const DEFAULT_ORDER: PanePosition[] = [
  { id: 'hardware-panel', sidebar: 'left' },
  { id: 'snapshot-panel', sidebar: 'left' },
  { id: 'joystick-panel', sidebar: 'left' },
  { id: 'mouse-panel', sidebar: 'left' },
  { id: 'sound-panel', sidebar: 'left' },
  { id: 'display-pane', sidebar: 'left' },
  { id: 'font-panel', sidebar: 'left' },
  { id: 'text-panel', sidebar: 'left' },
  { id: 'sysvar-panel', sidebar: 'right' },
  { id: 'basic-panel', sidebar: 'right' },
  { id: 'basic-vars-panel', sidebar: 'right' },
  { id: 'banks-panel', sidebar: 'right' },
  { id: 'disk-info-panel', sidebar: 'right' },
  { id: 'drive-panel', sidebar: 'right' },
  { id: 'tape-panel', sidebar: 'right' },
  { id: 'disasm-panel', sidebar: 'right' },
  { id: 'memory-panel', sidebar: 'right' },
  { id: 'dev-panel', sidebar: 'right' },
];

function loadPaneOrder(): PanePosition[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) {
      const saved: PanePosition[] = JSON.parse(raw);
      // Merge: use saved order but ensure all default panes exist
      // and remove any panes no longer in defaults
      const defaultIds = new Set(DEFAULT_ORDER.map(p => p.id));
      const savedIds = new Set(saved.map(p => p.id));
      const merged = saved.filter(p => defaultIds.has(p.id));
      for (const def of DEFAULT_ORDER) {
        if (!savedIds.has(def.id)) merged.push(def);
      }
      return merged;
    }
  } catch { /* */ }
  return [...DEFAULT_ORDER];
}

const DEFAULT_COLLAPSED = new Set<string>();

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* */ }
  return new Set(DEFAULT_COLLAPSED);
}

// ── Signals ─────────────────────────────────────────────────────────────

const _paneOrder = createSignal<PanePosition[]>(loadPaneOrder());
export const paneOrder = _paneOrder[0];
const _setPaneOrder = _paneOrder[1];

const _collapsedPanes = createSignal<Set<string>>(loadCollapsed());
export const collapsedPanes = _collapsedPanes[0];
const _setCollapsedPanes = _collapsedPanes[1];

// ── Actions ─────────────────────────────────────────────────────────────

export function savePaneOrder(): void {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(paneOrder())); } catch { /* */ }
}

export function setPaneOrder(order: PanePosition[]): void {
  _setPaneOrder(order);
  savePaneOrder();
}

export function toggleCollapsed(id: string): void {
  const set = new Set(collapsedPanes());
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  _setCollapsedPanes(set);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* */ }
}

export function isCollapsed(id: string): boolean {
  return collapsedPanes().has(id);
}

export function movePaneTo(paneId: string, targetSidebar: 'left' | 'right', beforeId: string | null): void {
  const order = paneOrder().filter(p => p.id !== paneId);
  const entry: PanePosition = { id: paneId, sidebar: targetSidebar };

  if (beforeId) {
    const idx = order.findIndex(p => p.id === beforeId);
    if (idx >= 0) {
      order.splice(idx, 0, entry);
    } else {
      order.push(entry);
    }
  } else {
    // Find last pane in target sidebar and insert after it
    let lastIdx = -1;
    for (let i = 0; i < order.length; i++) {
      if (order[i].sidebar === targetSidebar) lastIdx = i;
    }
    order.splice(lastIdx + 1, 0, entry);
  }

  setPaneOrder(order);
}
