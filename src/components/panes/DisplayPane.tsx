import { Pane } from '../Pane.tsx';
import {
  scale, brightness, contrast, smoothing, curvature, scanlines,
  dotmask, borderSize, persistSetting,
} from '../../store/settings.ts';
import { spectrum } from '../../store/emulator.ts';

export function DisplayPane() {
  return (
    <Pane id="display-pane" label="Display">
      <div id="display-controls">
        <label>
          Scale
          <select id="scale" value={scale.value} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value);
            scale.value = v;
            if (spectrum) spectrum.display.setScale(v);
            persistSetting('scale', v);
          }}>
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="4">4x</option>
          </select>
        </label>
        <label>
          Border
          <select id="border-size" value={borderSize.value} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value) as 0 | 1 | 2;
            borderSize.value = v;
            if (spectrum) spectrum.setBorderSize(v);
            persistSetting('border-size', v);
            (e.target as HTMLSelectElement).blur();
          }}>
            <option value="2">Normal</option>
            <option value="1">Small</option>
            <option value="0">None</option>
          </select>
        </label>
      </div>
      <SliderRow label="Brightness" id="brightness" min={-50} max={50} sig={brightness}
        apply={(v) => spectrum?.display.setBrightness(v / 50)} settingKey="brightness" />
      <SliderRow label="Contrast" id="contrast" min={0} max={100} sig={contrast}
        apply={(v) => spectrum?.display.setContrast(v / 50)} settingKey="contrast" />
      <SliderRow label="Smoothing" id="smoothing" min={0} max={100} sig={smoothing}
        apply={(v) => spectrum?.display.setSmoothing(v / 100)} settingKey="smoothing" />
      <SliderRow label="Curvature" id="curvature" min={0} max={100} sig={curvature}
        apply={(v) => spectrum?.display.setCurvature(v / 100 * 0.15)} settingKey="curvature" />
      <SliderRow label="Scanlines" id="scanlines" min={0} max={100} sig={scanlines}
        apply={(v) => spectrum?.display.setScanlines(v / 100)} settingKey="scanlines" />
      <div class="slider-row">
        <span class="slider-label">Dotmask</span>
        <select id="dotmask-select" value={dotmask.value} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          dotmask.value = v;
          if (spectrum) spectrum.display.setDotmask(v);
          persistSetting('dotmask', v);
        }}>
          <option value="0">None</option>
          <option value="2">Trinitron</option>
          <option value="3">Amstrad CTM</option>
          <option value="4">Cheap TV</option>
          <option value="5">Microvitec CUB</option>
        </select>
      </div>
    </Pane>
  );
}

import type { Signal } from '@preact/signals';

function SliderRow({ label, id, min, max, sig, apply, settingKey }: {
  label: string; id: string; min: number; max: number;
  sig: Signal<number>; apply: (v: number) => void; settingKey: string;
}) {
  return (
    <div class="slider-row">
      <span class="slider-label">{label}</span>
      <input
        type="range" id={`${id}-slider`} min={min} max={max}
        value={sig.value}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          sig.value = v;
          apply(v);
          persistSetting(settingKey, v);
        }}
      />
      <span class="slider-value" id={`${id}-value`}>{sig.value}</span>
    </div>
  );
}
