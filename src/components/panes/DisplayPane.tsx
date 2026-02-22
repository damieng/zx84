import { Show, For } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import {
  scale, setScale, brightness, setBrightness, contrast, setContrast,
  smoothing, setSmoothing, curvature, setCurvature, scanlines, setScanlines,
  maskType, setMaskType, dotPitch, setDotPitch, curvatureMode, setCurvatureMode,
  noise, setNoise, scalingMode, setScalingMode,
  monitor, setMonitor, borderSize, setBorderSize,
  renderer, colorMap, setColorMap, scanlineAccuracy, setScanlineAccuracy,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { spectrum, switchRenderer, applyDisplaySettings } from '@/emulator.ts';

interface MonitorPreset {
  maskType: number;
  dotPitch: number;
  curvature: number;
  curvatureMode: number;
  scanlines: number;
  smoothing: number;
  noise: number;
  brightness?: number;
  contrast?: number;
}

const MONITOR_PRESETS: Record<string, MonitorPreset> = {
  'raw': { maskType: 0, dotPitch: 10, curvature: 0, curvatureMode: 0, scanlines: 0, smoothing: 0, noise: 0, brightness: 0, contrast: 50 },
  'lcd': { maskType: 4, dotPitch: 10, curvature: 0, curvatureMode: 0, scanlines: 0, smoothing: 0, noise: 0, brightness: 0, contrast: 50 },
  'microvitec-cub': { maskType: 1, dotPitch: 20, curvature: 70, curvatureMode: 0, scanlines: 50, smoothing: 20, noise: 8 },
  'philips-cm8833': { maskType: 3, dotPitch: 20, curvature: 50, curvatureMode: 0, scanlines: 45, smoothing: 40, noise: 10 },
  'commodore-1080': { maskType: 1, dotPitch: 10, curvature: 50, curvatureMode: 0, scanlines: 45, smoothing: 20, noise: 8 },
  'amstrad-cm14': { maskType: 1, dotPitch: 20, curvature: 70, curvatureMode: 0, scanlines: 50, smoothing: 60, noise: 15 },
  'sony-trinitron': { maskType: 2, dotPitch: 10, curvature: 45, curvatureMode: 1, scanlines: 30, smoothing: 20, noise: 5, brightness: -5, contrast: 55 },
  'atari-sc1224': { maskType: 1, dotPitch: 10, curvature: 40, curvatureMode: 0, scanlines: 45, smoothing: 40, noise: 10 },
  'cheap-tv': { maskType: 1, dotPitch: 15, curvature: 80, curvatureMode: 0, scanlines: 65, smoothing: 70, noise: 30, brightness: -5, contrast: 55 },
};

function applyPreset(preset: MonitorPreset) {
  setMaskType(preset.maskType); if (spectrum) spectrum.display!.setMaskType(preset.maskType); persistSetting('mask-type', preset.maskType);
  setDotPitch(preset.dotPitch); if (spectrum) spectrum.display!.setDotPitch(preset.dotPitch / 10); persistSetting('dot-pitch', preset.dotPitch);
  setCurvature(preset.curvature); if (spectrum) spectrum.display!.setCurvature(preset.curvature / 100 * 0.15); persistSetting('curvature', preset.curvature);
  setCurvatureMode(preset.curvatureMode); if (spectrum) spectrum.display!.setCurvatureMode(preset.curvatureMode); persistSetting('curvature-mode', preset.curvatureMode);
  setScanlines(preset.scanlines); if (spectrum) spectrum.display!.setScanlines(preset.scanlines / 100); persistSetting('scanlines', preset.scanlines);
  setSmoothing(preset.smoothing); if (spectrum) spectrum.display!.setSmoothing(preset.smoothing / 100); persistSetting('smoothing', preset.smoothing);
  setNoise(preset.noise); if (spectrum) spectrum.display!.setNoise(preset.noise / 100); persistSetting('noise', preset.noise);
  if (preset.brightness != null) { setBrightness(preset.brightness); if (spectrum) spectrum.display!.setBrightness(preset.brightness / 50); persistSetting('brightness', preset.brightness); }
  if (preset.contrast != null) { setContrast(preset.contrast); if (spectrum) spectrum.display!.setContrast(preset.contrast / 50); persistSetting('contrast', preset.contrast); }
}

function SliderRow(props: {
  label: string; id: string; min: number; max: number;
  sig: Accessor<number>; setSig: Setter<number>; apply: (v: number) => void; settingKey: string;
}) {
  return (
    <div class="slider-row">
      <span class="slider-label">{props.label}</span>
      <input
        type="range" id={`${props.id}-slider`} min={props.min} max={props.max}
        value={props.sig()}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          props.setSig(v);
          props.apply(v);
          persistSetting(props.settingKey, v);
        }}
      />
      <span class="slider-value" id={`${props.id}-value`}>{props.sig()}</span>
    </div>
  );
}

// Scaling algorithms and their native scale factors.
// The algorithm IS the scaler — it takes 1x source pixels and produces
// NxN output blocks directly.  Only algorithms matching the current
// display scale are shown in the dropdown.
const SCALING_ALGOS: { mode: number; label: string; nativeScale: number }[] = [
  { mode: 0,  label: 'None',            nativeScale: 0 },  // 0 = any scale
  { mode: 1,  label: 'HQ2x',            nativeScale: 2 },
  { mode: 2,  label: 'HQ3x',            nativeScale: 3 },
  { mode: 3,  label: 'HQ4x',            nativeScale: 4 },
  { mode: 4,  label: 'xBR-lv2',         nativeScale: 0 },  // any scale
  { mode: 5,  label: 'xBR-lv3',         nativeScale: 0 },  // any scale
];

export function DisplayPane() {
  // Filter algorithms to those compatible with the current display scale
  const availableAlgos = () => SCALING_ALGOS.filter(
    a => a.nativeScale === 0 || a.nativeScale === scale()
  );

  return (
    <Pane id="display-pane" label="Display" onResetSettings={() => { resetSettingsGroup('display'); applyDisplaySettings(); }}>
      <div id="display-controls">
        <label>
          Scale
          <select id="scale" value={scale()} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value);
            setScale(v);
            if (spectrum) spectrum.display!.setScale(v);
            persistSetting('scale', v);
            // Reset scaling algorithm if it doesn't match the new scale
            const cur = scalingMode();
            const algo = SCALING_ALGOS.find(a => a.mode === cur);
            if (algo && algo.nativeScale !== 0 && algo.nativeScale !== v) {
              setScalingMode(0);
              if (spectrum) spectrum.display!.setScalingMode(0);
              persistSetting('scaling-mode', 0);
            }
          }}>
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="4">4x</option>
          </select>
        </label>
        <label>
          Border
          <select id="border-size" value={borderSize()} onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value) as 0 | 1 | 2;
            setBorderSize(v);
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
        <select value={colorMap()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'basic' | 'measured' | 'vivid';
          setColorMap(v);
          persistSetting('color-map', v);
          applyDisplaySettings();
        }}>
          <option value="basic">Basic</option>
          <option value="measured">Measured</option>
          <option value="vivid">Vivid</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Accuracy</span>
        <select value={scanlineAccuracy()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'high' | 'mid' | 'low';
          setScanlineAccuracy(v);
          persistSetting('scanline-accuracy', v);
          if (spectrum) spectrum.scanlineAccuracy = v;
        }}>
          <option value="high">High (per t-state)</option>
          <option value="mid">Mid (per scanline)</option>
          <option value="low">Low (per 8-scanlines/cell)</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Renderer</span>
        <select id="renderer-select" value={renderer()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value as 'webgl' | 'canvas';
          switchRenderer(v);
        }}>
          <option value="webgl">WebGL</option>
          <option value="canvas">Canvas</option>
        </select>
      </div>
      <Show when={renderer() === 'webgl'}>
      <div class="slider-row">
        <span class="slider-label">Monitor</span>
        <select id="monitor-select" value={monitor()} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          setMonitor(v);
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
          <option value="sony-trinitron">Sony PVM/Trinitron</option>
          <option value="atari-sc1224">Atari SC1224</option>
          <option value="cheap-tv">Cheap TV</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Upscaler</span>
        <select id="scaling-mode-select" value={scalingMode()} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setScalingMode(v);
          if (spectrum) spectrum.display!.setScalingMode(v);
          persistSetting('scaling-mode', v);
        }}>
          <For each={availableAlgos()}>
            {(a) => <option value={a.mode}>{a.label}</option>}
          </For>
        </select>
      </div>
      <SliderRow label="Brightness" id="brightness" min={-50} max={50} sig={brightness} setSig={setBrightness}
        apply={(v) => spectrum?.display?.setBrightness(v / 50)} settingKey="brightness" />
      <SliderRow label="Contrast" id="contrast" min={0} max={100} sig={contrast} setSig={setContrast}
        apply={(v) => spectrum?.display?.setContrast(v / 50)} settingKey="contrast" />
      <SliderRow label="Scanlines" id="scanlines" min={0} max={100} sig={scanlines} setSig={setScanlines}
        apply={(v) => spectrum?.display?.setScanlines(v / 100)} settingKey="scanlines" />
      <Show when={scalingMode() === 0}>
      <SliderRow label="Smoothing" id="smoothing" min={0} max={100} sig={smoothing} setSig={setSmoothing}
        apply={(v) => spectrum?.display?.setSmoothing(v / 100)} settingKey="smoothing" />
      </Show>
      <SliderRow label="Noise" id="noise" min={0} max={100} sig={noise} setSig={setNoise}
        apply={(v) => spectrum?.display?.setNoise(v / 100)} settingKey="noise" />
      <SliderRow label="Curvature" id="curvature" min={0} max={100} sig={curvature} setSig={setCurvature}
        apply={(v) => spectrum?.display?.setCurvature(v / 100 * 0.15)} settingKey="curvature" />
      <div class="slider-row">
        <span class="slider-label">Curv. mode</span>
        <select id="curvature-mode-select" value={curvatureMode()} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setCurvatureMode(v);
          if (spectrum) spectrum.display!.setCurvatureMode(v);
          persistSetting('curvature-mode', v);
        }}>
          <option value="0">Spherical</option>
          <option value="1">Cylindrical</option>
        </select>
      </div>
      <div class="slider-row">
        <span class="slider-label">Mask type</span>
        <select id="mask-type-select" value={maskType()} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setMaskType(v);
          if (spectrum) spectrum.display!.setMaskType(v);
          persistSetting('mask-type', v);
        }}>
          <option value="0">None</option>
          <option value="1">Shadow Mask</option>
          <option value="2">Aperture Grille</option>
          <option value="3">Slot Mask</option>
          <option value="4">LCD Grid</option>
          <option value="5">Attr Mask</option>
        </select>
      </div>
      <Show when={maskType() !== 4 && maskType() !== 5 && maskType() !== 0}>
      <SliderRow label="Dot pitch" id="dot-pitch" min={10} max={40} sig={dotPitch} setSig={setDotPitch}
        apply={(v) => spectrum?.display?.setDotPitch(v / 10)} settingKey="dot-pitch" />
      </Show>
      </Show>
    </Pane>
  );
}
