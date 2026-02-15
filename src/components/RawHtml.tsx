/**
 * Renders a signal's HTML into a DOM element via ref,
 * bypassing Solid's rendering entirely.
 * Use this for frequently-updating HTML (registers, sysvars, etc.)
 * to avoid allocating VNodes/closures every frame.
 */

import { createEffect, onMount, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Dynamic } from 'solid-js/web';

interface RawHtmlProps {
  tag?: string;
  id?: string;
  class?: string;
  style?: string;
  html: Accessor<string>;
  onDblClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  innerRef?: (el: HTMLElement | null) => void;
}

export function RawHtml(props: RawHtmlProps) {
  let ref!: HTMLElement;

  onMount(() => {
    if (props.innerRef) props.innerRef(ref);

    if (props.onDblClick) ref.addEventListener('dblclick', props.onDblClick as EventListener);
    if (props.onContextMenu) ref.addEventListener('contextmenu', props.onContextMenu as EventListener);

    onCleanup(() => {
      if (props.onDblClick) ref.removeEventListener('dblclick', props.onDblClick as EventListener);
      if (props.onContextMenu) ref.removeEventListener('contextmenu', props.onContextMenu as EventListener);
    });
  });

  createEffect(() => {
    if (ref) ref.innerHTML = props.html();
  });

  return (
    <Dynamic
      component={(props.tag || 'pre') as any}
      ref={(el: HTMLElement) => { ref = el; }}
      id={props.id}
      class={props.class}
      style={props.style}
    />
  );
}
