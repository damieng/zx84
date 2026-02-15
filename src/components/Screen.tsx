/**
 * Canvas wrapper for the emulator display + transcribe overlay.
 */

import { useRef, useEffect } from 'preact/hooks';
import { setCanvas, spectrum, transcribeMode, transcribeText, debugOverlay } from '../store/emulator.ts';

export function Screen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const natSizeRef = useRef({ w: 0, h: 0 });

  useEffect(() => {
    if (canvasRef.current) {
      setCanvas(canvasRef.current);
    }
  }, []);

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
  const dbg = debugOverlay.value;

  return (
    <div id="screen-wrap">
      <canvas id="screen" ref={canvasRef} class={active ? 'dimmed' : ''} />
      <pre
        id="transcribe-overlay"
        ref={overlayRef}
        class={active ? 'active' : ''}
      >{text}</pre>
      {dbg && <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        background: 'rgba(0,0,0,0.85)', color: '#0f0',
        fontFamily: 'monospace', fontSize: '22px', padding: '6px 8px',
        pointerEvents: 'none', zIndex: 10, whiteSpace: 'pre',
        letterSpacing: '0.5px'
      }}>{dbg}</div>}
    </div>
  );
}
