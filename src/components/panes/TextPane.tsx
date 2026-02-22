import type { Accessor, Setter } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import '@/fonts/monospace-fonts.css';
import {
  ocrFont, setOcrFont, ocrFontSize, setOcrFontSize,
  ocrLineHeight, setOcrLineHeight, ocrTracking, setOcrTracking,
  ocrOffsetX, setOcrOffsetX, ocrOffsetY, setOcrOffsetY,
  ocrScaleX, setOcrScaleX, ocrScaleY, setOcrScaleY,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';

const MONO_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'Inconsolata',
  'Space Mono',
  'Courier Prime',
  'Overpass Mono',
  'Anonymous Pro',
  'DM Mono',
  'Noto Sans Mono',
  'Cascadia Code',
  'Victor Mono',
];

function SliderRow(props: {
  label: string; id: string; min: number; max: number; step?: number;
  sig: Accessor<number>; setSig: Setter<number>; settingKey: string;
  format?: (v: number) => string;
}) {
  return (
    <div class="slider-row">
      <span class="slider-label">{props.label}</span>
      <input
        type="range" id={`${props.id}-slider`}
        min={props.min} max={props.max} step={props.step ?? 1}
        value={props.sig()}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          props.setSig(v);
          persistSetting(props.settingKey, v);
        }}
      />
      <span class="slider-value">{props.format ? props.format(props.sig()) : props.sig()}</span>
    </div>
  );
}

export function TextPane() {
  return (
    <Pane id="text-panel" label="Text" onResetSettings={() => resetSettingsGroup('text')}>
      <div class="slider-row">
        <span class="slider-label">Font</span>
        <select
          value={ocrFont()}
          onChange={(e) => {
            setOcrFont(e.currentTarget.value);
            persistSetting('ocr-font', e.currentTarget.value);
          }}
        >
          {MONO_FONTS.map(f => <option value={f}>{f}</option>)}
        </select>
      </div>

      <SliderRow label="Size" id="ocr-size" min={4} max={24}
        sig={ocrFontSize} setSig={setOcrFontSize} settingKey="ocr-font-size"
        format={v => `${v}px`}
      />

      <SliderRow label="Line height" id="ocr-lh" min={80} max={160}
        sig={ocrLineHeight} setSig={setOcrLineHeight} settingKey="ocr-line-height"
        format={v => (v / 100).toFixed(2)}
      />

      <SliderRow label="Tracking" id="ocr-track" min={-20} max={20}
        sig={ocrTracking} setSig={setOcrTracking} settingKey="ocr-tracking"
        format={v => `${(v / 10).toFixed(1)}px`}
      />

      <SliderRow label="Offset X" id="ocr-ox" min={-10} max={20}
        sig={ocrOffsetX} setSig={setOcrOffsetX} settingKey="ocr-offset-x"
        format={v => `${v}px`}
      />

      <SliderRow label="Offset Y" id="ocr-oy" min={-10} max={20}
        sig={ocrOffsetY} setSig={setOcrOffsetY} settingKey="ocr-offset-y"
        format={v => `${v}px`}
      />

      <SliderRow label="Scale X" id="ocr-sx" min={90} max={110} step={0.1}
        sig={ocrScaleX} setSig={setOcrScaleX} settingKey="ocr-scale-x"
        format={v => `${v.toFixed(1)}%`}
      />

      <SliderRow label="Scale Y" id="ocr-sy" min={90} max={110} step={0.1}
        sig={ocrScaleY} setSig={setOcrScaleY} settingKey="ocr-scale-y"
        format={v => `${v.toFixed(1)}%`}
      />
    </Pane>
  );
}
