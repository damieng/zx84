import { Pane } from '@/components/Pane.tsx';
import { volume, setVolume, ayMix, setAyMix, ayStereo, setAyStereo, persistSetting, resetSettingsGroup } from '@/store/settings.ts';
import { spectrum, applyDisplaySettings } from '@/emulator.ts';

export function SoundPane() {
  return (
    <Pane id="sound-panel" label="Sound" onResetSettings={() => {
      resetSettingsGroup('sound');
      if (spectrum) {
        spectrum['audio'].setVolume(70 / 100);
        spectrum.ay.setStereoMode('ABC');
      }
      applyDisplaySettings();
    }}>
      <div class="slider-row">
        <span class="slider-label">Volume</span>
        <input
          type="range" id="volume-slider" min="0" max="100"
          value={volume()}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setVolume(v);
            if (spectrum) spectrum['audio'].setVolume(v / 100);
            persistSetting('volume', v);
          }}
        />
        <span class="slider-value" id="volume-value">{volume()}</span>
      </div>
      <div class="slider-row">
        <span class="slider-label">Mixer</span>
        <span class="slider-end-label">Beep</span>
        <input
          type="range" id="ay-mix-slider" min="0" max="100"
          value={ayMix()}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setAyMix(v);
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
          value={ayStereo()}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as 'MONO' | 'ABC' | 'BCA' | 'CBA';
            setAyStereo(mode);
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
