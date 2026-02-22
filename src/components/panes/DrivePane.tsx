import { Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { DropDownMenuButton } from '@/components/DropDownMenuButton.tsx';
import { HiOutlineEllipsisVertical, HiOutlineDocumentPlus, HiOutlineArrowDownTray } from 'solid-icons/hi';
import {
  driveAStatus, driveBStatus, trapLogHtml, showTrapLog, currentModel,
  currentDiskName, currentDiskNameB, currentDiskInfo, currentDiskInfoB,
  ejectDisk, loadFile, insertBlankDisk, saveDisk, spectrum,
} from '@/emulator.ts';
import {
  diskSoundA, setDiskSoundA, diskSoundB, setDiskSoundB,
  writeProtectA, setWriteProtectA, writeProtectB, setWriteProtectB,
  driveBForceReady, setDriveBForceReady,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';
import { isPlus3 } from '@/spectrum.ts';
import { DISK_FORMATS, formatLabel, createBlankDisk, type DskImage } from '@/plus3/dsk.ts';
import type { DriveStatus } from '@/state/disk-state.ts';

const LED_COLORS: Record<DriveStatus['led'], string> = {
  off:   '#111',
  motor: '#2266ee',
  seek:  '#ddaa00',
  read:  '#22bb44',
  write: '#dd2222',
};

function renderDiskInfoStr(img: DskImage): string {
  const n = '<span class="reg-name">';
  const e = '</span>';
  const t0 = img.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 0;
  const sectorSize = t0?.sectors[0] ? (128 << t0.sectors[0].n) : 0;
  const capacityKB = (img.numSides * img.numTracks * spt * sectorSize) / 1024;
  return [
    `${n}Sides${e} ${img.numSides}  ${n}Tracks${e} ${img.numTracks}  ${n}Sectors${e} ${spt}`,
    `${n}Format${e}   ${img.diskFormat}   ${n}Capacity${e} ${capacityKB} KB`,
    `${n}Protect${e}  ${img.protection || 'None'}`,
  ].join('\n');
}

function DiskInfo(props: {
  unit: number;
  name: string;
  diskInfo: DskImage | null;
  status: DriveStatus;
  soundEnabled: boolean;
  writeProtected: boolean;
  forceReady?: boolean;
  onInsert: () => void;
  onToggleSound: () => void;
  onToggleWriteProtect: () => void;
  onToggleForceReady?: () => void;
}) {
  const label = props.unit === 0 ? 'A:' : 'B:';
  return (
    <div class="disk-section">
      <div class="drive-header">
        <span class="disk-label">{label}</span>
        <span class="drive-track-info">
          <span class="reg-name">Track</span>{' '}{props.status.track}
          {'  '}
          <span class="reg-name">Sector</span>{' '}{props.status.sector}
        </span>
        <DropDownMenuButton
          icon={<HiOutlineDocumentPlus />}
          title={`New disk in drive ${label}`}
          items={DISK_FORMATS.map((fmt, i) => ({ value: `new-${i}`, label: formatLabel(fmt) }))}
          onSelect={(value) => {
            const fmt = DISK_FORMATS[parseInt(value.slice(4))];
            if (fmt) insertBlankDisk(createBlankDisk(fmt), formatLabel(fmt), props.unit);
          }}
        />
        <button
          class="ddmenu-btn"
          title={`Save drive ${label} as DSK`}
          disabled={!props.diskInfo}
          onClick={() => saveDisk(props.unit)}
        >
          <HiOutlineArrowDownTray />
        </button>
        <DropDownMenuButton
          icon={<HiOutlineEllipsisVertical />}
          title={`Drive ${label} options`}
          items={[
            { value: 'sound', label: 'Drive sounds', checked: props.soundEnabled },
            { value: 'wp', label: 'Write protect', checked: props.writeProtected },
            ...(props.onToggleForceReady
              ? [{ value: 'force-ready', label: 'Present when empty', checked: props.forceReady }]
              : []),
          ]}
          onSelect={(value) => {
            if (value === 'sound') props.onToggleSound();
            else if (value === 'wp') props.onToggleWriteProtect();
            else if (value === 'force-ready') props.onToggleForceReady?.();
          }}
        />
      </div>
      <div class="disk-slot">
        <div
          class="disk-name"
          classList={{ 'disk-name-clickable': !props.name }}
          onClick={() => !props.name && props.onInsert()}
        >
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
        <span class="drive-led" style={{ background: LED_COLORS[props.status.led] }} title={props.status.led} />
      </div>
      <Show when={props.diskInfo}>
        <pre class="disk-info-output" innerHTML={renderDiskInfoStr(props.diskInfo!)} />
      </Show>
    </div>
  );
}

function syncWriteProtect(unit: number, value: boolean): void {
  if (spectrum) spectrum.fdc.writeProtect[unit] = value;
}

function syncForceReady(unit: number, value: boolean): void {
  if (spectrum) spectrum.fdc.forceReady[unit] = value;
}

export function DrivePane() {
  let fileInputRefA!: HTMLInputElement;
  let fileInputRefB!: HTMLInputElement;

  return (
    <Pane id="drive-panel" label="Drives" mono visible={isPlus3(currentModel())} onResetSettings={() => {
      resetSettingsGroup('drive');
      if (spectrum) {
        spectrum.fdc.writeProtect[0] = false; spectrum.fdc.writeProtect[1] = false;
        spectrum.fdc.forceReady[1] = false;
      }
    }}>
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
      <DiskInfo
        unit={0}
        name={currentDiskName()}
        diskInfo={currentDiskInfo()}
        status={driveAStatus()}
        soundEnabled={diskSoundA()}
        writeProtected={writeProtectA()}
        onInsert={() => fileInputRefA?.click()}
        onToggleSound={() => {
          setDiskSoundA(!diskSoundA());
          persistSetting('disk-sound-a', diskSoundA() ? 'on' : 'off');
        }}
        onToggleWriteProtect={() => {
          setWriteProtectA(!writeProtectA());
          persistSetting('write-protect-a', writeProtectA() ? 'on' : 'off');
          syncWriteProtect(0, writeProtectA());
        }}
      />
      <DiskInfo
        unit={1}
        name={currentDiskNameB()}
        diskInfo={currentDiskInfoB()}
        status={driveBStatus()}
        soundEnabled={diskSoundB()}
        writeProtected={writeProtectB()}
        forceReady={driveBForceReady()}
        onInsert={() => fileInputRefB?.click()}
        onToggleSound={() => {
          setDiskSoundB(!diskSoundB());
          persistSetting('disk-sound-b', diskSoundB() ? 'on' : 'off');
        }}
        onToggleWriteProtect={() => {
          setWriteProtectB(!writeProtectB());
          persistSetting('write-protect-b', writeProtectB() ? 'on' : 'off');
          syncWriteProtect(1, writeProtectB());
        }}
        onToggleForceReady={() => {
          setDriveBForceReady(!driveBForceReady());
          persistSetting('drive-b-force-ready', driveBForceReady() ? 'on' : 'off');
          syncForceReady(1, driveBForceReady());
        }}
      />
      <Show when={showTrapLog()}>
        <RawHtml id="trap-log" html={trapLogHtml} />
      </Show>
    </Pane>
  );
}
