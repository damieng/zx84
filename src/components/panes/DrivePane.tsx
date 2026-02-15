import { Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { DropDownMenuButton } from '@/components/DropDownMenuButton.tsx';
import { HiOutlineFolderOpen, HiOutlineEllipsisVertical } from 'solid-icons/hi';
import {
  driveAStatus, driveBStatus, trapLogHtml, showTrapLog, currentModel,
  currentDiskName, currentDiskNameB, currentDiskInfo, currentDiskInfoB,
  setDiskModeAction, ejectDisk, loadFile,
} from '@/emulator.ts';
import { diskMode, dualDrives, setDualDrives, persistSetting } from '@/store/settings.ts';
import { isPlus3 } from '@/spectrum.ts';
import type { DskImage } from '@/plus3/dsk.ts';

function renderDiskInfoStr(img: DskImage): string {
  const n = '<span class="reg-name">';
  const e = '</span>';
  const t0 = img.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 0;
  return [
    `${n}Sides${e} ${img.numSides}  ${n}Tracks${e} ${img.numTracks}  ${n}Sectors${e} ${spt}`,
    `${n}Format${e}   ${img.diskFormat}`,
    `${n}Protect${e}  ${img.protection || 'None'}`,
  ].join('\n');
}

function DiskInfo(props: { unit: number; name: string; diskInfo: DskImage | null; status: string; onInsert: () => void }) {
  const label = props.unit === 0 ? 'A:' : 'B:';
  return (
    <div class="disk-section">
      <div 
        class="disk-name" 
        classList={{ 'disk-name-clickable': !props.name }}
        onClick={() => !props.name && props.onInsert()}
      >
        <span class="disk-label">{label}</span>
        <span class="disk-name-text" title={props.name || ''}>
          {props.name || 'No disk inserted'}
        </span>
        <Show when={props.name}>
          <button class="tape-eject" title={`Eject disk ${label}`} onClick={(e) => { e.stopPropagation(); ejectDisk(props.unit); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z"/>
            </svg>
          </button>
        </Show>
      </div>
      <Show when={props.diskInfo}>
        <pre class="disk-info-output" innerHTML={renderDiskInfoStr(props.diskInfo!)} />
      </Show>
      <pre class="drive-status" innerHTML={props.status} />
    </div>
  );
}

export function DrivePane() {
  let fileInputRefA!: HTMLInputElement;
  let fileInputRefB!: HTMLInputElement;

  return (
    <Pane id="drive-panel" label="Drives" mono visible={isPlus3(currentModel())}>
      <div class="drive-toolbar">
        <div style="flex: 1" />
        <DropDownMenuButton
          icon={<HiOutlineEllipsisVertical />}
          title="Drive options"
          items={[
            { value: 'fdc', label: 'Emulate 765 FDC', checked: diskMode() === 'fdc' },
            { value: 'bios', label: 'Trap +3DOS calls', checked: diskMode() === 'bios' },
            { value: 'dual', label: 'Enable B: drive', checked: dualDrives() },
          ]}
          onSelect={(value) => {
            if (value === 'dual') {
              setDualDrives(!dualDrives());
              persistSetting('dual-drives', dualDrives() ? 'on' : 'off');
            } else {
              setDiskModeAction(value as 'fdc' | 'bios');
            }
          }}
        />
        <input
          type="file"
          ref={fileInputRefA}
          accept=".dsk,.zip"
          style="display:none"
          onChange={async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const data = new Uint8Array(await file.arrayBuffer());
            await loadFile(data, file.name, 0);
            (e.target as HTMLInputElement).value = '';
          }}
        />
        <Show when={dualDrives()}>
          <input
            type="file"
            ref={fileInputRefB}
            accept=".dsk,.zip"
            style="display:none"
            onChange={async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (!file) return;
              const data = new Uint8Array(await file.arrayBuffer());
              await loadFile(data, file.name, 1);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </Show>
      </div>
      <DiskInfo unit={0} name={currentDiskName()} diskInfo={currentDiskInfo()} status={driveAStatus()} onInsert={() => fileInputRefA?.click()} />
      <Show when={dualDrives()}>
        <DiskInfo unit={1} name={currentDiskNameB()} diskInfo={currentDiskInfoB()} status={driveBStatus()} onInsert={() => fileInputRefB?.click()} />
      </Show>
      <Show when={showTrapLog()}>
        <RawHtml id="trap-log" html={trapLogHtml} />
      </Show>
    </Pane>
  );
}
