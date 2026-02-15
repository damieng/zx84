/**
 * Sidebar container that renders ordered panes and handles DnD drop zone.
 */

import { type ComponentChildren } from 'preact';
import { useCallback, useRef } from 'preact/hooks';
import { movePaneTo } from '../store/panes.ts';

interface SidebarProps {
  id: string;
  side: 'left' | 'right';
  children: ComponentChildren;
  extra?: ComponentChildren;
}

// Shared drag state
let draggedPaneId: string | null = null;

const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';

export function Sidebar({ id, side, children, extra }: SidebarProps) {
  const sidebarRef = useRef<HTMLDivElement>(null);

  const onDragStart = useCallback((e: DragEvent) => {
    const pane = (e.target as HTMLElement).closest('.pane') as HTMLElement;
    if (!pane) return;
    if (!pane.dataset.dragFromLabel) { e.preventDefault(); return; }
    delete pane.dataset.dragFromLabel;
    draggedPaneId = pane.id;
    pane.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', pane.id);
  }, []);

  const onDragEnd = useCallback((e: DragEvent) => {
    const pane = (e.target as HTMLElement).closest('.pane') as HTMLElement;
    if (pane) pane.classList.remove('dragging');
    draggedPaneId = null;
    dropIndicator.remove();
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (!draggedPaneId) return;
    e.stopPropagation();
    e.dataTransfer!.dropEffect = 'move';

    const sidebar = sidebarRef.current;
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
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    const sidebar = sidebarRef.current;
    if (sidebar && !sidebar.contains(e.relatedTarget as Node)) {
      dropIndicator.remove();
    }
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedPaneId) return;

    const sidebar = sidebarRef.current;
    if (!sidebar) return;

    // Figure out which pane we're inserting before
    const indicatorNext = dropIndicator.nextElementSibling;
    const beforeId = indicatorNext?.classList.contains('pane') ? indicatorNext.id : null;

    // Move in the signal store (Preact re-render handles DOM)
    movePaneTo(draggedPaneId, side, beforeId);
    dropIndicator.remove();
  }, [side]);

  return (
    <div
      id={id}
      class="sidebar"
      ref={sidebarRef}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {extra}
      {children}
    </div>
  );
}

// Global mouseup handler to clear drag-from-label flag
document.addEventListener('mouseup', () => {
  document.querySelectorAll('.pane[data-drag-from-label]').forEach(p => {
    delete (p as HTMLElement).dataset.dragFromLabel;
  });
});
