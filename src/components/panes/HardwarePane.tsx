import { Pane } from '@/components/Pane.tsx';
import { HiOutlinePower } from 'solid-icons/hi';
import {
  currentModel, romStatusText, switchModel, loadRomFiles,
  turboMode, clockSpeedText, resetMachine, toggleTurbo,
  spectrum, triggerNMI, loadMultifaceROM,
} from '@/emulator.ts';
import type { SpectrumModel } from '@/spectrum.ts';
import { Show } from 'solid-js';
import { variantForModel, variantLabel } from '@/peripherals/multiface.ts';
import * as settings from '@/store/settings.ts';
import { resetSettingsGroup } from '@/store/settings.ts';

export function HardwarePane() {
  let romInputRef!: HTMLInputElement;

  return (
    <Pane id="hardware-panel" label="Hardware" onResetSettings={() => {
      resetSettingsGroup('hardware');
      if (spectrum) spectrum.multiface.enabled = false;
    }}>
      <div id="model-row">
        <select
          id="model"
          value={currentModel()}
          onChange={(e) => {
            switchModel((e.target as HTMLSelectElement).value as SpectrumModel);
            (e.target as HTMLSelectElement).blur();
          }}
        >
          <option value="48k">ZX Spectrum 48K</option>
          <option value="128k">ZX Spectrum 128K</option>
          <option value="+2">ZX Spectrum +2 (Grey)</option>
          <option value="+2a">ZX Spectrum +2A (Black)</option>
          <option value="+3">ZX Spectrum +3</option>
        </select>
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiOutlinePower /></button>
        <input
          type="file"
          ref={romInputRef}
          accept=".rom,.bin"
          multiple
          style="display:none"
          onChange={(e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files) loadRomFiles(files);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      </div>
      <div id="cpu-controls">
        <button class="btn btn-md" id="rom-btn" title="Load ROM" onClick={() => romInputRef?.click()}>ROM Select</button>
        <button
          id="cpu-mhz"
          title={turboMode() ? 'Switch to normal speed' : 'Toggle turbo speed'}
          class={`btn btn-md${turboMode() ? ' active' : ''}`}
          onClick={toggleTurbo}
        >{clockSpeedText()}</button>
      </div>
      <div class="multiface-row">
        <label class="mf-check">
          <input
            type="checkbox"
            checked={settings.multifaceEnabled()}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              settings.setMultifaceEnabled(on);
              settings.persistSetting('multiface', on ? 'on' : 'off');
              if (spectrum) {
                spectrum.multiface.enabled = on;
                if (on && !spectrum.multiface.romLoaded) {
                  loadMultifaceROM(spectrum);
                }
              }
            }}
          />
          {variantLabel(variantForModel(currentModel()))}
        </label>
        <button
          class="mf-nmi-btn"
          title="Trigger NMI (Multiface button)"
          disabled={!settings.multifaceEnabled()}
          onClick={triggerNMI}
        >NMI</button>
      </div>
      <Show when={romStatusText()}>
        <span class="rom-status" id="rom-status">{romStatusText()}</span>
      </Show>
    </Pane>
  );
}
