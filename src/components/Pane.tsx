/**
 * Base pane component with 128K-style title bar, collapse/expand, and drag.
 */

import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { collapsedPanes, toggleCollapsed } from '@/ui/panes.ts';

interface PaneProps {
  id: string;
  label: string;
  mono?: boolean;
  visible?: boolean;
  labelExtra?: JSX.Element;
  children?: JSX.Element;
}

export function Pane(props: PaneProps) {
  function onLabelClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    toggleCollapsed(props.id);
  }

  function onLabelMouseDown(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('select, button')) return;
    const pane = (e.currentTarget as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) pane.dataset.dragFromLabel = '1';
  }

  return (
    <Show when={props.visible !== false}>
      <div id={props.id} class={`pane${props.mono ? ' pane--mono' : ''}${collapsedPanes().has(props.id) ? ' collapsed' : ''}`} draggable={true}>
        <div class="section-label" onClick={onLabelClick} onMouseDown={onLabelMouseDown}>
          <svg class="twisty" width="10" height="10" viewBox="0 0 10 10">
            <path d="M2,3 L8,3 L5,8 Z" fill="currentColor" />
          </svg>
          {props.label}
          {props.labelExtra}
        </div>
        <div class="pane-content">
          <div class="pane-content-inner">
            {props.children}
          </div>
        </div>
      </div>
    </Show>
  );
}
