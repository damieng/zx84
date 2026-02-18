/**
 * Canvas wrapper for the emulator display + transcribe overlay.
 */

import { createEffect } from 'solid-js';
import { setCanvas, spectrum, transcribeMode, transcribeHtml } from '@/emulator.ts';
import { renderer, scale, ocrFont, ocrFontSize, ocrLineHeight, ocrTracking, ocrOffsetX, ocrOffsetY, ocrScaleX, ocrScaleY } from '@/store/settings.ts';

export function Screen() {
  let canvasRef!: HTMLCanvasElement;
  let overlayRef!: HTMLPreElement;
  let natSize = { w: 0, h: 0 };

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

  // When font settings change, force re-measure
  createEffect(() => {
    ocrFont(); ocrFontSize(); ocrLineHeight(); ocrTracking(); ocrScaleX(); ocrScaleY();
    natSize = { w: 0, h: 0 };
  });

  // Position the overlay and scale it to cover the 256×192 display area
  createEffect(() => {
    const mode = transcribeMode();
    if (mode === 'off') {
      natSize = { w: 0, h: 0 };
      return;
    }
    if (!spectrum || !overlayRef || !canvasRef) return;

    const html = transcribeHtml();
    const scl = scale();
    const ov = overlayRef;
    const borderPx = (spectrum.ula.screenWidth - 256) / 2;
    const targetW = 256 * scl;
    const targetH = 192 * scl;

    // Apply font settings
    ov.style.fontFamily = ocrFont();
    ov.style.fontSize = ocrFontSize() + 'px';
    ov.style.lineHeight = (ocrLineHeight() / 100).toFixed(2);
    ov.style.letterSpacing = (ocrTracking() / 10).toFixed(1) + 'px';

    // Position with user-adjustable offset
    ov.style.left = (borderPx * scl + ocrOffsetX()) + 'px';
    ov.style.top = (borderPx * scl + ocrOffsetY()) + 'px';
    ov.innerHTML = html;

    // Measure natural size then scale to fit
    if (!natSize.w) {
      if (!html || html.length < 32) return;
      ov.style.transform = 'none';
      natSize.w = ov.scrollWidth || 1;
      natSize.h = ov.scrollHeight || 1;
    }
    const sx = (targetW / natSize.w) * (ocrScaleX() / 100);
    const sy = (targetH / natSize.h) * (ocrScaleY() / 100);
    ov.style.transform = `scale(${sx},${sy})`;
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
