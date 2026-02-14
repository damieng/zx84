/**
 * Custom tooltip using event delegation on [data-tip].
 */

import { useEffect, useRef } from 'preact/hooks';

export function Tooltip() {
  const elRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef(0);
  const targetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const tooltipEl = elRef.current!;

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
      clearTimeout(timerRef.current);
      timerRef.current = 0;
      targetRef.current = null;
      tooltipEl.classList.remove('visible');
    }

    function onMouseover(e: MouseEvent): void {
      const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      if (!el) { if (targetRef.current) hideTooltip(); return; }
      if (el === targetRef.current) return;
      hideTooltip();
      targetRef.current = el;
      timerRef.current = window.setTimeout(() => showTooltip(el), 400);
    }

    function onMouseout(e: MouseEvent): void {
      const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      if (el === targetRef.current) hideTooltip();
    }

    document.addEventListener('mouseover', onMouseover);
    document.addEventListener('mouseout', onMouseout);

    return () => {
      document.removeEventListener('mouseover', onMouseover);
      document.removeEventListener('mouseout', onMouseout);
      hideTooltip();
    };
  }, []);

  return <div class="zx-tooltip" ref={elRef} />;
}
