/**
 * Base pane component with 128K-style title bar, collapse/expand, and drag.
 */

import type { JSX } from 'solid-js';
import { createSignal, Show, onCleanup, createEffect } from 'solid-js';
import { collapsedPanes, toggleCollapsed } from '@/ui/panes.ts';

interface PaneProps {
  id: string;
  label: string;
  mono?: boolean;
  visible?: boolean;
  labelExtra?: JSX.Element;
  /** If provided, enables the "..." menu button on the title bar. */
  onResetSettings?: () => void;
  children?: JSX.Element;
}

export function Pane(props: PaneProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal({ top: 0, left: 0 });
  let menuRef!: HTMLDivElement;
  let dotBtnRef!: HTMLSpanElement;

  function onLabelClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    toggleCollapsed(props.id);
  }

  function onLabelMouseDown(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    const pane = (e.currentTarget as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) {
      pane.draggable = true;
      pane.dataset.dragFromLabel = '1';
    }
  }

  function toggleMenu() {
    if (menuOpen()) { setMenuOpen(false); return; }
    if (!dotBtnRef) return;
    const rect = dotBtnRef.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 2, left: rect.right });
    setMenuOpen(true);
  }

  function closeMenu() { setMenuOpen(false); }

  function handleReset() {
    props.onResetSettings?.();
    closeMenu();
  }

  // Close on click outside or Escape
  createEffect(() => {
    if (!menuOpen()) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef && !menuRef.contains(e.target as Node) &&
          dotBtnRef && !dotBtnRef.contains(e.target as Node)) closeMenu();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    });
  });

  return (
    <Show when={props.visible !== false}>
      <div id={props.id} class={`pane${props.mono ? ' pane--mono' : ''}${collapsedPanes().has(props.id) ? ' collapsed' : ''}`}>
        <div class="section-label" onClick={onLabelClick} onMouseDown={onLabelMouseDown}>
          <svg class="twisty" width="10" height="10" viewBox="0 0 10 10">
            <path d="M2,3 L8,3 L5,8 Z" fill="currentColor" />
          </svg>
          {props.label}
          {props.labelExtra}
          <Show when={props.onResetSettings}>
            <span ref={dotBtnRef} class="pane-dots" title="Pane options" onClick={(e) => { e.stopPropagation(); toggleMenu(); }}>
              ⋮
            </span>
          </Show>
        </div>
        <div class="pane-content">
          <div class="pane-content-inner">
            {props.children}
          </div>
        </div>
      </div>
      <Show when={menuOpen()}>
        <div
          ref={menuRef}
          class="ddmenu"
          style={{ top: `${menuPos().top}px`, left: `${menuPos().left}px`, transform: 'translateX(-100%)' }}
        >
          <div class="ddmenu-item" onClick={handleReset}>
            Reset settings
          </div>
        </div>
      </Show>
    </Show>
  );
}
