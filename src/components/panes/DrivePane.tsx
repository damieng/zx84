import { useRef } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { DropDownMenuButton } from '../DropDownMenuButton.tsx';
import { HiFolderOpen, HiArrowUpTray, HiEllipsisVertical } from 'react-icons/hi2';
import {
  driveHtml, trapLogHtml, showTrapLog, currentModel,
  setDiskMode, ejectDisk, loadFile,
} from '../../store/emulator.ts';
import { diskMode } from '../../store/settings.ts';
import { isPlus3 } from '../../spectrum.ts';

export function DrivePane() {
  const mode = diskMode.value;
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <Pane id="drive-panel" label="Drive" mono visible={isPlus3(currentModel.value)}>
      <div class="drive-toolbar">
        <button title="Open disk" onClick={() => fileInputRef.current?.click()}><HiFolderOpen /></button>
        <button title="Eject disk" onClick={ejectDisk}><HiArrowUpTray /></button>
        <DropDownMenuButton
          icon={<HiEllipsisVertical />}
          title="Drive options"
          items={[
            { value: 'fdc', label: 'Emulate 765 FDC', checked: mode === 'fdc' },
            { value: 'bios', label: 'Trap +3DOS calls', checked: mode === 'bios' },
          ]}
          onSelect={(value) => setDiskMode(value as 'fdc' | 'bios')}
        />
        <input
          type="file"
          ref={fileInputRef}
          accept=".dsk"
          style="display:none"
          onChange={async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const data = new Uint8Array(await file.arrayBuffer());
            await loadFile(data, file.name);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      </div>
      <pre id="drive-output" dangerouslySetInnerHTML={{ __html: driveHtml.value }} />
      {showTrapLog.value && (
        <pre id="trap-log" dangerouslySetInnerHTML={{ __html: trapLogHtml.value }} />
      )}
    </Pane>
  );
}
