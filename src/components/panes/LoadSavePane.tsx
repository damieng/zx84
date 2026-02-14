import { useRef } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { HiFolderOpen, HiArrowDownTray } from 'react-icons/hi2';
import { loadFile, saveSnapshot } from '../../store/emulator.ts';

export function LoadSavePane() {
  const snapInputRef = useRef<HTMLInputElement>(null);

  return (
    <Pane id="snapshot-panel" label="Load / Save">
      <div id="snap-row">
        <button id="snap-load-btn" title="Load file" onClick={() => snapInputRef.current?.click()}>
          <HiFolderOpen /> Load
        </button>
        <button id="snap-save-btn" title="Save snapshot" onClick={saveSnapshot}>
          <HiArrowDownTray /> Save
        </button>
        <input
          type="file"
          ref={snapInputRef}
          accept=".sna,.z80,.tap,.tzx,.dsk,.zip"
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
    </Pane>
  );
}
