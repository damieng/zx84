import { Pane } from '../Pane.tsx';
import { driveHtml, trapLogHtml, showTrapLog, currentModel, setDiskMode } from '../../store/emulator.ts';
import { diskMode } from '../../store/settings.ts';
import { isPlus3 } from '../../spectrum.ts';

export function DrivePane() {
  const mode = diskMode.value;

  return (
    <Pane id="drive-panel" label="Drive" mono visible={isPlus3(currentModel.value)}>
      <div id="disk-mode-toggle">
        <span class="disk-mode-label">Mode</span>
        <button
          class={mode === 'fdc' ? 'active' : ''}
          onClick={() => setDiskMode('fdc')}
        >FDC</button>
        <button
          class={mode === 'bios' ? 'active' : ''}
          onClick={() => setDiskMode('bios')}
        >BIOS</button>
      </div>
      <pre id="drive-output" dangerouslySetInnerHTML={{ __html: driveHtml.value }} />
      {showTrapLog.value && (
        <pre id="trap-log" dangerouslySetInnerHTML={{ __html: trapLogHtml.value }} />
      )}
    </Pane>
  );
}
