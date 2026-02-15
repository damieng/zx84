/**
 * Sidebar container that renders ordered panes and handles DnD drop zone.
 */

import type { JSX } from 'solid-js';
import { movePaneTo } from '@/ui/panes.ts';

interface SidebarProps {
  id: string;
  side: 'left' | 'right';
  children?: JSX.Element;
  extra?: JSX.Element;
}

// Shared drag state
let draggedPaneId: string | null = null;

const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';

export function Sidebar(props: SidebarProps) {
  let sidebarRef!: HTMLDivElement;

  function onDragStart(e: DragEvent) {
    const pane = (e.target as HTMLElement).closest('.pane') as HTMLElement;
    if (!pane) return;
    if (!pane.dataset.dragFromLabel) { e.preventDefault(); return; }
    delete pane.dataset.dragFromLabel;
    draggedPaneId = pane.id;
    pane.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', pane.id);

    // Use a compact drag image (just the label bar) to avoid ghosting all panes
    const label = pane.querySelector('.section-label') as HTMLElement;
    if (label) {
      const ghost = label.cloneNode(true) as HTMLElement;
      ghost.style.cssText = `position:fixed;top:-1000px;width:${label.offsetWidth}px;background:#000;color:#fff;padding:6px 10px;border-radius:4px;font-size:0.85rem;`;
      document.body.appendChild(ghost);
      e.dataTransfer!.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
      requestAnimationFrame(() => ghost.remove());
    }
  }

  function onDragEnd(e: DragEvent) {
    const pane = (e.target as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) pane.classList.remove('dragging');
    draggedPaneId = null;
    dropIndicator.remove();
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    if (!draggedPaneId) return;
    e.stopPropagation();
    e.dataTransfer!.dropEffect = 'move';

    const sidebar = sidebarRef;
    if (!sidebar) return;

    const panes = Array.from(sidebar.querySelectorAll(':scope > .pane'));
    const y = e.clientY;
    let insertBefore: Element | null = null;
    for (const p of panes) {
      if (p.id === draggedPaneId) continue;
      const rect = p.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        insertBefore = p;
        break;
      }
    }

    if (insertBefore) {
      sidebar.insertBefore(dropIndicator, insertBefore);
    } else {
      sidebar.appendChild(dropIndicator);
    }
  }

  function onDragLeave(e: DragEvent) {
    if (!sidebarRef.contains(e.relatedTarget as Node)) {
      dropIndicator.remove();
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedPaneId) return;

    // Figure out which pane we're inserting before
    const indicatorNext = dropIndicator.nextElementSibling;
    const beforeId = indicatorNext?.classList.contains('pane') ? indicatorNext.id : null;

    // Move in the signal store (Solid re-render handles DOM)
    movePaneTo(draggedPaneId, props.side, beforeId);
    dropIndicator.remove();
  }

  return (
    <div
      id={props.id}
      class="sidebar"
      ref={sidebarRef}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {props.extra}
      {props.children}
    </div>
  );
}

// Global mouseup handler to clear drag-from-label flag
document.addEventListener('mouseup', () => {
  document.querySelectorAll('.pane[data-drag-from-label]').forEach(p => {
    delete (p as HTMLElement).dataset.dragFromLabel;
  });
});
