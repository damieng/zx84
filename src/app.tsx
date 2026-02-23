/**
 * Root layout: sidebars, main screen, tooltip.
 */

import { onMount, onCleanup, createEffect, type JSX } from 'solid-js';
import { Sidebar } from '@/components/Sidebar.tsx';
import { Screen } from '@/components/Screen.tsx';
import { StatusBar } from '@/components/StatusBar.tsx';
import { Tooltip } from '@/components/Tooltip.tsx';

import { HardwarePane } from '@/components/panes/HardwarePane.tsx';
import { LoadSavePane } from '@/components/panes/LoadSavePane.tsx';
import { JoystickPane } from '@/components/panes/JoystickPane.tsx';
import { MousePane } from '@/components/panes/MousePane.tsx';
import { SoundPane } from '@/components/panes/SoundPane.tsx';
import { DisplayPane } from '@/components/panes/DisplayPane.tsx';
import { FontPane } from '@/components/panes/FontPane.tsx';
import { SysVarPane } from '@/components/panes/SysVarPane.tsx';
import { BasicPane } from '@/components/panes/BasicPane.tsx';
import { BasicVarsPane } from '@/components/panes/BasicVarsPane.tsx';
import { BanksPane } from '@/components/panes/BanksPane.tsx';
import { DiskInfoPane } from '@/components/panes/DiskInfoPane.tsx';
import { DrivePane } from '@/components/panes/DrivePane.tsx';
import { TapePane } from '@/components/panes/TapePane.tsx';
import { DisassemblyPane } from '@/components/panes/DisassemblyPane.tsx';
import { DevPane } from '@/components/panes/DevPane.tsx';
import { TextPane } from '@/components/panes/TextPane.tsx';
import { ChangelogPane } from '@/components/panes/ChangelogPane.tsx';
import { MemoryPane } from '@/components/panes/MemoryPane.tsx';

import { paneOrder } from '@/ui/panes.ts';
import { needsGamepadPolling } from '@/store/settings.ts';
import { initAudio, init, loadFile } from '@/emulator.ts';
import { configuringPlayer } from '@/components/panes/JoystickPane.tsx';
import { InputController } from '@/input-controller.ts';

// ── Pane registry ───────────────────────────────────────────────────────

const PANE_COMPONENTS: Record<string, () => JSX.Element> = {
  'hardware-panel': HardwarePane,
  'snapshot-panel': LoadSavePane,
  'joystick-panel': JoystickPane,
  'mouse-panel': MousePane,
  'sound-panel': SoundPane,
  'display-pane': DisplayPane,
  'font-panel': FontPane,
  'sysvar-panel': SysVarPane,
  'basic-panel': BasicPane,
  'basic-vars-panel': BasicVarsPane,
  'banks-panel': BanksPane,
  'disk-info-panel': DiskInfoPane,
  'drive-panel': DrivePane,
  'tape-panel': TapePane,
  'text-panel': TextPane,
  'disasm-panel': DisassemblyPane,
  'dev-panel': DevPane,
  'changelog-panel': ChangelogPane,
  'memory-panel': MemoryPane,
};

function renderPanes(side: 'left' | 'right') {
  return () => {
    const order = paneOrder();
    return order
      .filter(p => p.sidebar === side)
      .map(p => {
        const Component = PANE_COMPONENTS[p.id];
        return Component ? <Component /> : null;
      });
  };
}

// ── Input Controller ────────────────────────────────────────────────────

const inputController = new InputController();

export function App() {
  const leftPanes = renderPanes('left');
  const rightPanes = renderPanes('right');

  // Register global keyboard/audio/drag-drop handlers
  onMount(() => {
    document.addEventListener('keydown', inputController.onKeyDown);
    document.addEventListener('keyup', inputController.onKeyUp);
    document.addEventListener('click', initAudio, { once: true });

    function onDragOver(e: DragEvent) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      file.arrayBuffer().then(buf => loadFile(new Uint8Array(buf), file.name));
    }
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);

    onCleanup(() => {
      document.removeEventListener('keydown', inputController.onKeyDown);
      document.removeEventListener('keyup', inputController.onKeyUp);
      document.removeEventListener('click', initAudio);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    });
  });

  // Gamepad polling loop — auto-tracks needsGamepadPolling() and configuringPlayer()
  createEffect(() => {
    if (!needsGamepadPolling() && configuringPlayer() < 0) return;
    let rafId = 0;
    function loop() {
      inputController.pollGamepads();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    onCleanup(() => {
      cancelAnimationFrame(rafId);
      inputController.reset();
    });
  });

  // Init emulator on mount
  onMount(() => { init(); });

  return (
    <>
      <Sidebar id="sidebar" side="left" extra={
        <div id="toolbar">
          <h1>
            <span class="logo-stripe" />
            <span class="logo">ZX<span class="logo-num">84</span><span class="logo-version">v{__APP_VERSION__}</span></span>
            <span class="logo-stripe" />
          </h1>
        </div>
      }>
        {leftPanes()}
      </Sidebar>

      <div id="main">
        <Screen />
        <StatusBar />
        <div id="diag"><div id="diag-header" /></div>
      </div>

      <Sidebar id="right-sidebar" side="right">
        {rightPanes()}
      </Sidebar>

      <Tooltip />
    </>
  );
}
