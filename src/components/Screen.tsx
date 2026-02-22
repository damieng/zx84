/**
 * Canvas wrapper for the emulator display + transcribe overlay.
 */

import { createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { setCanvas, spectrum, transcribeMode, transcribeHtml } from '@/emulator.ts';
import { renderer, scale, borderSize, ocrFont, ocrFontSize, ocrLineHeight, ocrTracking, ocrOffsetX, ocrOffsetY, ocrScaleX, ocrScaleY } from '@/store/settings.ts';

export function Screen() {
  let canvasRef!: HTMLCanvasElement;
  let drawOverlayRef!: HTMLCanvasElement;
  let overlayRef!: HTMLPreElement;
  let natSize = { w: 0, h: 0 };

  // Track devicePixelRatio changes (browser zoom, OS scaling)
  const [dpr, setDpr] = createSignal(window.devicePixelRatio || 1);
  onMount(() => {
    let cancel = false;
    const watchDpr = () => {
      if (cancel) return;
      const mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', () => {
        setDpr(window.devicePixelRatio || 1);
        watchDpr();
      }, { once: true });
    };
    watchDpr();
    onCleanup(() => { cancel = true; });
  });

  // Re-apply scale when DPR changes
  createEffect(() => {
    dpr(); // track
    if (spectrum?.display) spectrum.display.setScale(scale());
  });

  // When renderer changes, create a fresh canvas element.
  createEffect(() => {
    renderer(); // track
    if (!canvasRef) return;
    const fresh = document.createElement('canvas');
    fresh.id = canvasRef.id;
    fresh.className = canvasRef.className;
    canvasRef.replaceWith(fresh);
    canvasRef = fresh;
    setCanvas(fresh);
  });


  // When font settings change, force re-measure (after fonts load)
  createEffect(() => {
    ocrFont(); ocrFontSize(); ocrLineHeight(); ocrTracking(); ocrScaleX(); ocrScaleY();
    // Wait for fonts to be ready before clearing cache
    document.fonts.ready.then(() => {
      natSize = { w: 0, h: 0 };
    });
  });

  // Position the overlay and scale it to cover the 256×192 display area
  createEffect(() => {
    const mode = transcribeMode();
    ocrFont(); // Track font changes to trigger re-measure
    if (mode === 'off') {
      natSize = { w: 0, h: 0 };
      return;
    }
    if (!spectrum || !overlayRef || !canvasRef) return;

    const html = transcribeHtml();
    const scl = scale();
    const curDpr = dpr(); // track DPR changes
    borderSize(); // track border changes
    const ov = overlayRef;
    const borderPx = (spectrum.ula.screenWidth - 256) / 2;
    // Use effective scale that accounts for DPR integer rounding
    const effectiveScale = Math.round(scl * curDpr) / curDpr;
    const targetW = 256 * effectiveScale;
    const targetH = 192 * effectiveScale;

    // Apply font settings
    ov.style.fontFamily = ocrFont();
    ov.style.fontSize = ocrFontSize() + 'px';
    ov.style.lineHeight = (ocrLineHeight() / 100).toFixed(2);
    ov.style.letterSpacing = (ocrTracking() / 10).toFixed(1) + 'px';

    // Position with user-adjustable offset
    ov.style.left = (borderPx * effectiveScale + ocrOffsetX()) + 'px';
    ov.style.top = (borderPx * effectiveScale + ocrOffsetY()) + 'px';
    ov.innerHTML = html;

    // When font changes, force re-measure
    if (!natSize.w) {
      // Wait a tick to ensure font is rendered before measuring
      requestAnimationFrame(() => {
        if (!html || html.length < 32) return;
        ov.style.transform = 'none';
        natSize.w = ov.scrollWidth || 1;
        natSize.h = ov.scrollHeight || 1;
        const sx = (targetW / natSize.w) * (ocrScaleX() / 100);
        const sy = (targetH / natSize.h) * (ocrScaleY() / 100);
        ov.style.transform = `scale(${sx},${sy})`;
      });
    } else if (natSize.w) {
      const sx = (targetW / natSize.w) * (ocrScaleX() / 100);
      const sy = (targetH / natSize.h) * (ocrScaleY() / 100);
      ov.style.transform = `scale(${sx},${sy})`;
    }
  });

  return (
    <div id="screen-wrap">
      <canvas id="screen" ref={canvasRef} />
      <pre
        id="transcribe-overlay"
        ref={overlayRef}
        class={transcribeMode() !== 'off' ? 'active' : ''}
      />
    </div>
  );
}
