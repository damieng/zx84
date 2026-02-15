/**
 * Renders a signal's HTML into a DOM element via ref,
 * bypassing Preact's VDOM diffing entirely.
 * Use this for frequently-updating HTML (registers, sysvars, etc.)
 * to avoid allocating VNodes/closures every frame.
 */

import { useRef, useEffect } from 'preact/hooks';
import type { Signal } from '@preact/signals';

interface RawHtmlProps {
  tag?: string;
  id?: string;
  class?: string;
  style?: string;
  html: Signal<string>;
  onDblClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  innerRef?: (el: HTMLElement | null) => void;
}

export function RawHtml({ tag = 'pre', id, class: cls, style, html, onDblClick, onContextMenu, innerRef }: RawHtmlProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (innerRef) innerRef(ref.current);
  }, [innerRef]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Subscribe to signal changes and update DOM directly
    const unsub = html.subscribe((value) => {
      el.innerHTML = value;
    });
    return unsub;
  }, [html]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (onDblClick) el.addEventListener('dblclick', onDblClick as EventListener);
    if (onContextMenu) el.addEventListener('contextmenu', onContextMenu as EventListener);
    return () => {
      if (onDblClick) el.removeEventListener('dblclick', onDblClick as EventListener);
      if (onContextMenu) el.removeEventListener('contextmenu', onContextMenu as EventListener);
    };
  }, [onDblClick, onContextMenu]);

  const Tag = tag as any;
  return <Tag ref={ref} id={id} class={cls} style={style} />;
}
