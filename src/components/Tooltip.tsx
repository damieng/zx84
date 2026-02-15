/**
 * Custom tooltip using event delegation on [data-tip].
 */

import { onMount, onCleanup } from 'solid-js';

export function Tooltip() {
  let elRef!: HTMLDivElement;
  let timer = 0;
  let targetEl: HTMLElement | null = null;

  onMount(() => {
    const tooltipEl = elRef;

    function showTooltip(el: HTMLElement): void {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      tooltipEl.textContent = text;
      const rect = el.getBoundingClientRect();
      tooltipEl.style.left = rect.left + 'px';
      tooltipEl.style.top = (rect.bottom + 6) + 'px';
      tooltipEl.classList.add('visible');
    }

    function hideTooltip(): void {
      clearTimeout(timer);
      timer = 0;
      targetEl = null;
      tooltipEl.classList.remove('visible');
    }

    function onMouseover(e: MouseEvent): void {
      const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      if (!el) { if (targetEl) hideTooltip(); return; }
      if (el === targetEl) return;
      hideTooltip();
      targetEl = el;
      timer = window.setTimeout(() => showTooltip(el), 400);
    }

    function onMouseout(e: MouseEvent): void {
      const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      if (el === targetEl) hideTooltip();
    }

    document.addEventListener('mouseover', onMouseover);
    document.addEventListener('mouseout', onMouseout);

    onCleanup(() => {
      document.removeEventListener('mouseover', onMouseover);
      document.removeEventListener('mouseout', onMouseout);
      hideTooltip();
    });
  });

  return <div class="zx-tooltip" ref={elRef} />;
}
