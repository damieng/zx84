import { useRef, useEffect } from 'preact/hooks';
import { Pane } from '@/components/Pane.tsx';
import { HiPlus, HiArrowDownTray } from 'react-icons/hi2';
import { fontName, persistSetting } from '@/store/settings.ts';
import {
  setStatus, updateFontPreview, loadFontStore, saveFontStore, capturedFontData,
} from '@/emulator.ts';

function renderFontToCanvas(cvs: HTMLCanvasElement, fontData: Uint8Array): void {
  const cols = 32, rows = 3;
  const w = cols * 8;
  const h = rows * 8;
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;

  for (let c = 0; c < 96; c++) {
    const col = c % cols;
    const row = (c / cols) | 0;
    const off = c * 8;
    for (let py = 0; py < 8; py++) {
      const byte = fontData[off + py];
      for (let px = 0; px < 8; px++) {
        if (byte & (0x80 >> px)) {
          const idx = ((row * 8 + py) * w + col * 8 + px) * 4;
          d[idx] = 0; d[idx + 1] = 0; d[idx + 2] = 0; d[idx + 3] = 0xFF;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function FontPane() {
  const fontInputRef = useRef<HTMLInputElement>(null);
  const fontPreviewRef = useRef<HTMLCanvasElement>(null);
  const romFontPreviewRef = useRef<HTMLCanvasElement>(null);

  // Render font preview per-frame
  useEffect(() => {
    const result = updateFontPreview();
    if (!result) return;

    if (result.type === 'custom' && fontPreviewRef.current) {
      renderFontToCanvas(fontPreviewRef.current, result.data);
      fontPreviewRef.current.style.display = 'block';
      if (romFontPreviewRef.current) romFontPreviewRef.current.style.display = 'none';
    } else if (result.type === 'rom' && romFontPreviewRef.current) {
      renderFontToCanvas(romFontPreviewRef.current, result.data);
      romFontPreviewRef.current.style.display = 'block';
      if (fontPreviewRef.current) fontPreviewRef.current.style.display = 'none';
    }
  });

  const store = loadFontStore();
  const fontNames = Object.keys(store).sort();

  return (
    <Pane id="font-panel" label="Font">
      <div class="slider-row" id="font-row">
        <select id="font-select" value={fontName.value} onChange={(e) => {
          fontName.value = (e.target as HTMLSelectElement).value;
          persistSetting('font', fontName.value);
          (e.target as HTMLSelectElement).blur();
        }}>
          <option value="">Current</option>
          {fontNames.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button id="font-add-btn" title="Add font (.ch8, 768 bytes)" onClick={() => fontInputRef.current?.click()}><HiPlus /></button>
        <button id="font-save-btn" title="Save displayed font as .ch8" onClick={() => {
          let data: Uint8Array | null = null;
          const name = fontName.value;
          if (name) {
            const s = loadFontStore();
            const b64 = s[name];
            if (b64) {
              const binary = atob(b64);
              data = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
            }
          } else {
            data = capturedFontData;
          }
          if (!data || data.length !== 768) {
            setStatus('No font data to save');
            return;
          }
          const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (name || 'font') + '.ch8';
          a.click();
          URL.revokeObjectURL(a.href);
        }}><HiArrowDownTray /></button>
      </div>
      <canvas id="font-preview" ref={fontPreviewRef} width="128" height="16" style="display:none" />
      <canvas id="rom-font-preview" ref={romFontPreviewRef} width="128" height="16" style="display:none" />
      <input
        type="file"
        ref={fontInputRef}
        accept=".ch8,.bin"
        style="display:none"
        onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const data = new Uint8Array(reader.result as ArrayBuffer);
            if (data.length !== 768) {
              setStatus(`Font must be 768 bytes (got ${data.length})`);
              (e.target as HTMLInputElement).value = '';
              return;
            }
            const name = file.name.replace(/\.[^.]+$/, '');
            let binary = '';
            for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
            const s = loadFontStore();
            s[name] = btoa(binary);
            saveFontStore(s);
            fontName.value = name;
            persistSetting('font', name);
            setStatus(`Font "${name}" added`);
            (e.target as HTMLInputElement).value = '';
          };
          reader.readAsArrayBuffer(file);
        }}
      />
    </Pane>
  );
}
