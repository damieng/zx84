import { onMount, onCleanup } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { HiOutlineFolderOpen, HiOutlineArrowDownTray } from 'solid-icons/hi';
import { loadFile, saveSnapshot, saveScreenshot, saveRAM } from '@/emulator.ts';

export function LoadSavePane() {
  let snapInputRef!: HTMLInputElement;
  let menuRef!: HTMLDivElement;
  let saveButtonRef!: HTMLButtonElement;

  onMount(() => {
    function close(e: MouseEvent) {
      if (menuRef && !menuRef.contains(e.target as Node) &&
          !saveButtonRef?.contains(e.target as Node)) {
        menuRef.style.display = 'none';
      }
    }
    document.addEventListener('click', close);
    onCleanup(() => document.removeEventListener('click', close));
  });

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    const menu = menuRef;
    const button = saveButtonRef;
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
      if (menuRef) menuRef.style.display = 'none';
      action();
    };
  }

  return (
    <Pane id="snapshot-panel" label="Load / Save">
      <div id="snap-row">
        <button id="snap-load-btn" title="Load file" onClick={() => snapInputRef?.click()}>
          <HiOutlineFolderOpen /> Load
        </button>
        <button
          ref={saveButtonRef}
          id="snap-save-btn"
          title="Save..."
          onClick={toggleMenu}
        >
          <HiOutlineArrowDownTray /> Save
        </button>
        <div ref={menuRef} class="save-menu" style="display:none">
          <div class="save-menu-item" onClick={handleSave(() => saveSnapshot('szx'))}>Snapshot (.szx)</div>
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
