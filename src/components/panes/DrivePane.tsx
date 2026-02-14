import { Pane } from '../Pane.tsx';
import { driveHtml, trapLogHtml, showTrapLog, currentModel, setDiskMode } from '../../store/emulator.ts';
import { diskMode } from '../../store/settings.ts';
import { isPlus3 } from '../../spectrum.ts';

export function DrivePane() {
  const labelExtra = (
    <select
      id="disk-mode"
      value={diskMode.value}
      onChange={(e) => {
        setDiskMode((e.target as HTMLSelectElement).value as 'fdc' | 'bios');
        (e.target as HTMLSelectElement).blur();
      }}
    >
      <option value="fdc">FDC</option>
      <option value="bios">BIOS</option>
    </select>
  );

  return (
    <Pane id="drive-panel" label="Drive" mono visible={isPlus3(currentModel.value)} labelExtra={labelExtra}>
      <pre id="drive-output" dangerouslySetInnerHTML={{ __html: driveHtml.value }} />
      {showTrapLog.value && (
        <pre id="trap-log" dangerouslySetInnerHTML={{ __html: trapLogHtml.value }} />
      )}
    </Pane>
  );
}
