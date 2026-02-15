import { useRef, useEffect } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { HiFolderOpen, HiArrowDownTray } from 'react-icons/hi2';
import { loadFile, saveSnapshot, saveScreenshot, saveRAM } from '../../emulator.ts';

export function LoadSavePane() {
  const snapInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // Close menu on any click outside
  useEffect(() => {
    function close(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          !saveButtonRef.current?.contains(e.target as Node)) {
        menuRef.current.style.display = 'none';
      }
    }
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    const menu = menuRef.current;
    const button = saveButtonRef.current;
    if (!menu || !button) return;

    if (menu.style.display === 'block') {
      menu.style.display = 'none';
    } else {
      const rect = button.getBoundingClientRect();
      const parent = button.offsetParent as HTMLElement;
      const parentRect = parent?.getBoundingClientRect();

      menu.style.left = `${rect.left - (parentRect?.left || 0)}px`;
      menu.style.top = `${rect.bottom - (parentRect?.top || 0)}px`;
      menu.style.display = 'block';
    }
  }

  function handleSave(action: () => void) {
    return () => {
      if (menuRef.current) menuRef.current.style.display = 'none';
      action();
    };
  }

  return (
    <Pane id="snapshot-panel" label="Load / Save">
      <div id="snap-row">
        <button id="snap-load-btn" title="Load file" onClick={() => snapInputRef.current?.click()}>
          <HiFolderOpen /> Load
        </button>
        <button
          ref={saveButtonRef}
          id="snap-save-btn"
          title="Save..."
          onClick={toggleMenu}
        >
          <HiArrowDownTray /> Save
        </button>
        <div ref={menuRef} class="save-menu" style="display:none">
          <div class="save-menu-item" onClick={handleSave(() => saveSnapshot('sna'))}>Snapshot (.sna)</div>
          <div class="save-menu-item" onClick={handleSave(() => saveSnapshot('z80'))}>Snapshot (.z80)</div>
          <div class="save-menu-item" onClick={handleSave(() => saveScreenshot('png'))}>Screenshot (.png)</div>
          <div class="save-menu-item" onClick={handleSave(() => saveScreenshot('scr'))}>Screen (.scr)</div>
          <div class="save-menu-item" onClick={handleSave(saveRAM)}>RAM (.bin)</div>
        </div>
        <input
          type="file"
          ref={snapInputRef}
          accept=".sna,.z80,.szx,.sp,.tap,.tzx,.dsk,.zip"
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
