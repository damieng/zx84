/**
 * Canvas wrapper for the emulator display + transcribe overlay.
 */

import { useRef, useEffect } from 'preact/hooks';
import { setCanvas, spectrum, transcribeMode, transcribeText } from '../store/emulator.ts';
import { renderer } from '../store/settings.ts';

export function Screen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const natSizeRef = useRef({ w: 0, h: 0 });

  const rendererType = renderer.value;

  useEffect(() => {
    if (canvasRef.current) {
      setCanvas(canvasRef.current);
    }
  }, [rendererType]);

  // Position the transcribe overlay
  useEffect(() => {
    const mode = transcribeMode.value;
    if (mode === 'off') {
      // Clear cached measurement so it's remeasured next time
      natSizeRef.current = { w: 0, h: 0 };
      return;
    }
    if (!spectrum || !overlayRef.current || !canvasRef.current) return;

    const ov = overlayRef.current;
    const scale = spectrum.display!.scale;
    const borderPx = (spectrum.ula.screenWidth - 256) / 2;
    const offsetLeft = borderPx * scale + 2;
    const offsetTop = borderPx * scale + 2;
    const targetW = 256 * scale;
    const targetH = 192 * scale;

    ov.style.left = offsetLeft + 'px';
    ov.style.top = offsetTop + 'px';

    if (!natSizeRef.current.w) {
      // Need actual text content to measure — skip if empty
      if (!ov.textContent || ov.textContent.length < 32) return;
      ov.style.transform = 'none';
      natSizeRef.current.w = ov.scrollWidth || 1;
      natSizeRef.current.h = ov.scrollHeight || 1;
    }
    ov.style.transform = `scale(${targetW / natSizeRef.current.w},${targetH / natSizeRef.current.h})`;
  });

  const mode = transcribeMode.value;
  const active = mode !== 'off';
  const text = transcribeText.value;
  return (
    <div id="screen-wrap">
      <canvas id="screen" key={rendererType} ref={canvasRef} class={active ? 'dimmed' : ''} />
      <pre
        id="transcribe-overlay"
        ref={overlayRef}
        class={active ? 'active' : ''}
      >{text}</pre>
    </div>
  );
}
