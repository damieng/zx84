/**
 * Base pane component with 128K-style title bar, collapse/expand, and drag.
 */

import { type ComponentChildren } from 'preact';
import { useCallback } from 'preact/hooks';
import { collapsedPanes, toggleCollapsed } from '../store/panes.ts';

interface PaneProps {
  id: string;
  label: string;
  mono?: boolean;
  visible?: boolean;
  labelExtra?: ComponentChildren;
  children: ComponentChildren;
}

export function Pane({ id, label, mono, visible = true, labelExtra, children }: PaneProps) {
  if (!visible) return null;

  const collapsed = collapsedPanes.value.has(id);

  const onLabelClick = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('select, button')) return;
    toggleCollapsed(id);
  }, [id]);

  const onLabelMouseDown = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('select, button')) return;
    // Mark that drag started from label — the Sidebar handles actual DnD
    const pane = (e.currentTarget as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) pane.dataset.dragFromLabel = '1';
  }, []);

  const className = `pane${mono ? ' pane--mono' : ''}${collapsed ? ' collapsed' : ''}`;

  return (
    <div id={id} class={className} draggable>
      <div class="section-label" onClick={onLabelClick} onMouseDown={onLabelMouseDown}>
        <svg class="twisty" width="10" height="10" viewBox="0 0 10 10">
          <path d="M2,3 L8,3 L5,8 Z" fill="currentColor" />
        </svg>
        {label}
        {labelExtra}
      </div>
      <div class="pane-content">
        <div class="pane-content-inner">
          {children}
        </div>
      </div>
    </div>
  );
}
