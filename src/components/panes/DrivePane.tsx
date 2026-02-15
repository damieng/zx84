import { useRef } from 'preact/hooks';
import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { DropDownMenuButton } from '@/components/DropDownMenuButton.tsx';
import { HiFolderOpen, HiEllipsisVertical } from 'react-icons/hi2';
import {
  driveHtml, trapLogHtml, showTrapLog, currentModel,
  currentDiskName, currentDiskNameB, currentDiskInfo, currentDiskInfoB,
  setDiskMode, ejectDisk, loadDiskToUnit,
} from '@/emulator.ts';
import { diskMode, dualDrives, persistSetting } from '@/store/settings.ts';
import { isPlus3 } from '@/spectrum.ts';
import type { DskImage } from '@/plus3/dsk.ts';

function renderDiskInfo(img: DskImage): string {
  const n = '<span class="reg-name">';
  const e = '</span>';
  const t0 = img.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 0;
  return [
    `${n}Sides${e} ${img.numSides}  ${n}Tracks${e} ${img.numTracks}  ${n}Sectors${e} ${spt}`,
    `${n}Format${e} ${img.diskFormat}`,
    `${n}Prot.${e}  ${img.protection || 'None'}`,
  ].join('\n');
}

function DiskInfo({ unit, name, diskInfo }: { unit: number; name: string; diskInfo: DskImage | null }) {
  if (!name) return null;

  return (
    <div class="disk-section">
      <div class="disk-name">
        <span class="disk-label">{unit === 0 ? 'A:' : 'B:'}</span>
        <span class="disk-name-text" title={name}>{name}</span>
        <button class="tape-eject" title={`Eject disk ${unit === 0 ? 'A:' : 'B:'}`} onClick={() => ejectDisk(unit)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z"/>
          </svg>
        </button>
      </div>
      {diskInfo && (
        <pre class="disk-info-output" dangerouslySetInnerHTML={{ __html: renderDiskInfo(diskInfo) }} />
      )}
    </div>
  );
}

export function DrivePane() {
  const mode = diskMode.value;
  const dual = dualDrives.value;
  const fileInputRefA = useRef<HTMLInputElement>(null);
  const fileInputRefB = useRef<HTMLInputElement>(null);
  const nameA = currentDiskName.value;
  const nameB = currentDiskNameB.value;

  return (
    <Pane id="drive-panel" label="Drives" mono visible={isPlus3(currentModel.value)}>
      <div class="drive-toolbar">
        <button title="Open disk A:" onClick={() => fileInputRefA.current?.click()}><HiFolderOpen /> A:</button>
        {dual && (
          <button title="Open disk B:" onClick={() => fileInputRefB.current?.click()}><HiFolderOpen /> B:</button>
        )}
        <DropDownMenuButton
          icon={<HiEllipsisVertical />}
          title="Drive options"
          items={[
            { value: 'fdc', label: 'Emulate 765 FDC', checked: mode === 'fdc' },
            { value: 'bios', label: 'Trap +3DOS calls', checked: mode === 'bios' },
            { value: 'dual', label: 'Enable B: drive', checked: dual },
          ]}
          onSelect={(value) => {
            if (value === 'dual') {
              dualDrives.value = !dual;
              persistSetting('dual-drives', dualDrives.value ? 'on' : 'off');
            } else {
              setDiskMode(value as 'fdc' | 'bios');
            }
          }}
        />
        <input
          type="file"
          ref={fileInputRefA}
          accept=".dsk"
          style="display:none"
          onChange={async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const data = new Uint8Array(await file.arrayBuffer());
            loadDiskToUnit(data, file.name, 0);
            (e.target as HTMLInputElement).value = '';
          }}
        />
        {dual && (
          <input
            type="file"
            ref={fileInputRefB}
            accept=".dsk"
            style="display:none"
            onChange={async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (!file) return;
              const data = new Uint8Array(await file.arrayBuffer());
              loadDiskToUnit(data, file.name, 1);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        )}
      </div>
      <DiskInfo unit={0} name={nameA} diskInfo={currentDiskInfo.value} />
      {dual && <DiskInfo unit={1} name={nameB} diskInfo={currentDiskInfoB.value} />}
      <RawHtml id="drive-output" html={driveHtml} />
      {showTrapLog.value && (
        <RawHtml id="trap-log" html={trapLogHtml} />
      )}
    </Pane>
  );
}
