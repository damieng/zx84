import { Pane } from '@/components/Pane.tsx';
import {
  scale, brightness, contrast, smoothing, curvature, scanlines,
  maskType, dotPitch, curvatureMode, monitor, borderSize, subFrameRendering, renderer, colorMap, persistSetting,
} from '@/store/settings.ts';
import { spectrum, switchRenderer, applyDisplaySettings } from '@/emulator.ts';

interface MonitorPreset {
  maskType: number;
  dotPitch: number;
  curvature: number;
  curvatureMode: number;
  scanlines: number;
  smoothing: number;
  brightness?: number;
  contrast?: number;
}

const MONITOR_PRESETS: Record<string, MonitorPreset> = {
  'raw': {
    maskType: 0, dotPitch: 10, curvature: 0, curvatureMode: 0, scanlines: 0, smoothing: 0,
    brightness: 0, contrast: 50,
  },
  'lcd': {
    maskType: 4, dotPitch: 10, curvature: 0, curvatureMode: 0, scanlines: 0, smoothing: 0,
    brightness: 0, contrast: 50,
  },
  'microvitec-cub': {
    maskType: 1, dotPitch: 20, curvature: 70, curvatureMode: 0, scanlines: 50, smoothing: 20,
  },
  'philips-cm8833': {
    maskType: 3, dotPitch: 20, curvature: 50, curvatureMode: 0, scanlines: 45, smoothing: 40,
  },
  'commodore-1080': {
    maskType: 1, dotPitch: 10, curvature: 50, curvatureMode: 0, scanlines: 45, smoothing: 20,
  },
  'amstrad-cm14': {
    maskType: 1, dotPitch: 20, curvature: 70, curvatureMode: 0, scanlines: 50, smoothing: 60,
  },
  'sony-trinitron': {
    maskType: 2, dotPitch: 10, curvature: 45, curvatureMode: 1, scanlines: 30, smoothing: 20,
    brightness: -5, contrast: 55,
  },
  'atari-sc1224': {
    maskType: 1, dotPitch: 10, curvature: 40, curvatureMode: 0, scanlines: 45, smoothing: 40,
  },
  'cheap-tv': {
    maskType: 1, dotPitch: 30, curvature: 80, curvatureMode: 0, scanlines: 65, smoothing: 70,
    brightness: -5, contrast: 55,
  },
};

function applyPreset(preset: MonitorPreset) {
  maskType.value = preset.maskType;
  if (spectrum) spectrum.display!.setMaskType(preset.maskType);
  persistSetting('mask-type', preset.maskType);

  dotPitch.value = preset.dotPitch;
  if (spectrum) spectrum.display!.setDotPitch(preset.dotPitch / 10);
  persistSetting('dot-pitch', preset.dotPitch);

  curvature.value = preset.curvature;
  if (spectrum) spectrum.display!.setCurvature(preset.curvature / 100 * 0.15);
  persistSetting('curvature', preset.curvature);

  curvatureMode.value = preset.curvatureMode;
  if (spectrum) spectrum.display!.setCurvatureMode(preset.curvatureMode);
  persistSetting('curvature-mode', preset.curvatureMode);

  scanlines.value = preset.scanlines;
  if (spectrum) spectrum.display!.setScanlines(preset.scanlines / 100);
  persistSetting('scanlines', preset.scanlines);

  smoothing.value = preset.smoothing;
  if (spectrum) spectrum.display!.setSmoothing(preset.smoothing / 100);
  persistSetting('smoothing', preset.smoothing);

  if (preset.brightness != null) {
    brightness.value = preset.brightness;
    if (spectrum) spectrum.display!.setBrightness(preset.brightness / 50);
    persistSetting('brightness', preset.brightness);
  }

  if (preset.contrast != null) {
    contrast.value = preset.contrast;
    if (spectrum) spectrum.display!.setContrast(preset.contrast / 50);
    persistSetting('contrast', preset.contrast);
  }
}

export function DisplayPane() {
  return (
    <Pane id="display-pane" label="Display">
      <div id="display-controls">
        <label>
          Scale
          <select id="scale" value={scale.value} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value);
            scale.value = v;
            if (spectrum) spectrum.display!.setScale(v);
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
      <div class="slider-row">
        <span class="slider-label">Color map</span>
        <select value={colorMap.value} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'basic' | 'measured' | 'vivid';
          colorMap.value = v;
          persistSetting('color-map', v);
          applyDisplaySettings();
        }}>
          <option value="basic">Basic</option>
          <option value="measured">Measured</option>
          <option value="vivid">Vivid</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Precision</span>
        <select value={subFrameRendering.value ? 'scanline' : 'frame'} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value === 'scanline';
          subFrameRendering.value = v;
          persistSetting('sub-frame-rendering', v ? 'on' : 'off');
          if (spectrum) {
            spectrum.subFrameRendering = v;
          }
        }}>
          <option value="frame">Per frame (50 Hz)</option>
          <option value="scanline">Per scanline (15.6 kHz)</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Renderer</span>
        <select id="renderer-select" value={renderer.value} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'webgl' | 'canvas';
          switchRenderer(v);
        }}>
          <option value="webgl">WebGL</option>
          <option value="canvas">Canvas</option>
        </select>
      </div>
      {renderer.value === 'webgl' && (<>
      <div class="slider-row">
        <span class="slider-label">Monitor</span>
        <select id="monitor-select" value={monitor.value} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          monitor.value = v;
          persistSetting('monitor', v);
          const preset = MONITOR_PRESETS[v];
          if (preset) applyPreset(preset);
        }}>
          <option value="raw">Raw</option>
          <option value="lcd">LCD</option>
          <option value="microvitec-cub">Microvitec CUB</option>
          <option value="philips-cm8833">Philips CM8833</option>
          <option value="commodore-1080">Commodore 1080</option>
          <option value="amstrad-cm14">Amstrad CM14</option>
          <option value="sony-trinitron">Sony Trinitron</option>
          <option value="atari-sc1224">Atari SC1224</option>
          <option value="cheap-tv">Cheap TV</option>
        </select>
      </div>
      <SliderRow label="Brightness" id="brightness" min={-50} max={50} sig={brightness}
        apply={(v) => spectrum?.display?.setBrightness(v / 50)} settingKey="brightness" />
      <SliderRow label="Contrast" id="contrast" min={0} max={100} sig={contrast}
        apply={(v) => spectrum?.display?.setContrast(v / 50)} settingKey="contrast" />
      <SliderRow label="Scanlines" id="scanlines" min={0} max={100} sig={scanlines}
        apply={(v) => spectrum?.display?.setScanlines(v / 100)} settingKey="scanlines" />
      <SliderRow label="Smoothing" id="smoothing" min={0} max={100} sig={smoothing}
        apply={(v) => spectrum?.display?.setSmoothing(v / 100)} settingKey="smoothing" />
      <SliderRow label="Curvature" id="curvature" min={0} max={100} sig={curvature}
        apply={(v) => spectrum?.display?.setCurvature(v / 100 * 0.15)} settingKey="curvature" />
      <div class="slider-row">
        <span class="slider-label">Curv. mode</span>
        <select id="curvature-mode-select" value={curvatureMode.value} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          curvatureMode.value = v;
          if (spectrum) spectrum.display!.setCurvatureMode(v);
          persistSetting('curvature-mode', v);
        }}>
          <option value="0">Spherical</option>
          <option value="1">Cylindrical</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Mask type</span>
        <select id="mask-type-select" value={maskType.value} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          maskType.value = v;
          if (spectrum) spectrum.display!.setMaskType(v);
          persistSetting('mask-type', v);
        }}>
          <option value="0">None</option>
          <option value="1">Shadow Mask</option>
          <option value="2">Aperture Grille</option>
          <option value="3">Slot Mask</option>
          <option value="4">LCD Grid</option>
        </select>
      </div>
      {maskType.value !== 4 && maskType.value !== 0 && (
      <SliderRow label="Dot pitch" id="dot-pitch" min={10} max={40} sig={dotPitch}
        apply={(v) => spectrum?.display?.setDotPitch(v / 10)} settingKey="dot-pitch" />
      )}
      </>)}
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
