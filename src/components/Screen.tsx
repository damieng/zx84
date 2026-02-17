/**
 * Canvas wrapper for the emulator display + transcribe overlay.
 */

import { createEffect } from 'solid-js';
import { setCanvas, spectrum, transcribeMode, transcribeText } from '@/emulator.ts';
import { renderer } from '@/store/settings.ts';

export function Screen() {
  let canvasRef!: HTMLCanvasElement;
  let overlayRef!: HTMLPreElement;
  let natSize = { w: 0, h: 0 };

  // When renderer changes, create a fresh canvas element.
  // Browsers only allow one context type per canvas — once getContext('2d')
  // has been called, getContext('webgl') returns null on the same element.
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

  // Position the transcribe overlay
  createEffect(() => {
    const mode = transcribeMode();
    if (mode === 'off') {
      natSize = { w: 0, h: 0 };
      return;
    }
    if (!spectrum || !overlayRef || !canvasRef) return;

    const ov = overlayRef;
    const scl = spectrum.display!.scale;
    const borderPx = (spectrum.ula.screenWidth - 256) / 2;
    const offsetLeft = borderPx * scl + 2;
    const offsetTop = borderPx * scl + 2;
    const targetW = 256 * scl;
    const targetH = 192 * scl;

    ov.style.left = offsetLeft + 'px';
    ov.style.top = offsetTop + 'px';

    // Also track text to re-measure
    void transcribeText();

    if (!natSize.w) {
      if (!ov.textContent || ov.textContent.length < 32) return;
      ov.style.transform = 'none';
      natSize.w = ov.scrollWidth || 1;
      natSize.h = ov.scrollHeight || 1;
    }
    ov.style.transform = `scale(${targetW / natSize.w},${targetH / natSize.h})`;
  });

  return (
    <div id="screen-wrap">
      <canvas id="screen" ref={canvasRef} class={transcribeMode() !== 'off' ? 'dimmed' : ''} />
      <pre
        id="transcribe-overlay"
        ref={overlayRef}
        class={transcribeMode() !== 'off' ? 'active' : ''}
      >{transcribeText()}</pre>
    </div>
  );
}
