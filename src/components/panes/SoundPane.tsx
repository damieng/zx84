import { Pane } from '@/components/Pane.tsx';
import { volume, ayMix, ayStereo, persistSetting } from '@/store/settings.ts';
import { spectrum, applyDisplaySettings } from '@/emulator.ts';

export function SoundPane() {
  return (
    <Pane id="sound-panel" label="Sound">
      <div class="slider-row">
        <span class="slider-label">Volume</span>
        <input
          type="range" id="volume-slider" min="0" max="100"
          value={volume.value}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            volume.value = v;
            if (spectrum) spectrum['audio'].setVolume(v / 100);
            persistSetting('volume', v);
          }}
        />
        <span class="slider-value" id="volume-value">{volume.value}</span>
      </div>
      <div class="slider-row">
        <span class="slider-label">Mixer</span>
        <span class="slider-end-label">Beep</span>
        <input
          type="range" id="ay-mix-slider" min="0" max="100"
          value={ayMix.value}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            ayMix.value = v;
            persistSetting('ay-mix', v);
            applyDisplaySettings();
          }}
        />
        <span class="slider-end-label">AY</span>
      </div>
      <div class="slider-row">
        <span class="slider-label">AY Channels</span>
        <select
          id="ay-stereo-select"
          value={ayStereo.value}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as 'MONO' | 'ABC' | 'BCA' | 'CBA';
            ayStereo.value = mode;
            if (spectrum) spectrum.ay.setStereoMode(mode);
            persistSetting('ay-stereo', mode);
          }}
        >
          <option value="MONO">Mono</option>
          <option value="ABC">Stereo ABC</option>
          <option value="BCA">Stereo BCA</option>
          <option value="CBA">Stereo CBA</option>
        </select>
      </div>
    </Pane>
  );
}
