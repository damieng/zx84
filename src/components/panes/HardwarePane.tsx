import { useRef } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { HiCpuChip } from 'react-icons/hi2';
import { currentModel, romStatusText, switchModel, loadRomFiles } from '../../store/emulator.ts';
import type { SpectrumModel } from '../../spectrum.ts';

export function HardwarePane() {
  const romInputRef = useRef<HTMLInputElement>(null);

  return (
    <Pane id="hardware-panel" label="Hardware">
      <div id="model-row">
        <select
          id="model"
          value={currentModel.value}
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
        <button id="rom-btn" title="Load ROM" onClick={() => romInputRef.current?.click()}>
          <HiCpuChip />
        </button>
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
      {romStatusText.value && (
        <span class="rom-status" id="rom-status">{romStatusText.value}</span>
      )}
    </Pane>
  );
}
