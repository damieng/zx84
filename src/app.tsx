/**
 * Root layout: sidebars, main screen, tooltip.
 */

import { useEffect } from 'preact/hooks';
import { Sidebar } from './components/Sidebar.tsx';
import { Screen } from './components/Screen.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Tooltip } from './components/Tooltip.tsx';

import { HardwarePane } from './components/panes/HardwarePane.tsx';
import { LoadSavePane } from './components/panes/LoadSavePane.tsx';
import { JoystickPane } from './components/panes/JoystickPane.tsx';
import { SoundPane } from './components/panes/SoundPane.tsx';
import { DisplayPane } from './components/panes/DisplayPane.tsx';
import { FontPane } from './components/panes/FontPane.tsx';
import { CpuPane } from './components/panes/CpuPane.tsx';
import { SysVarPane } from './components/panes/SysVarPane.tsx';
import { BanksPane } from './components/panes/BanksPane.tsx';
import { DiskInfoPane } from './components/panes/DiskInfoPane.tsx';
import { DrivePane } from './components/panes/DrivePane.tsx';
import { TapePane } from './components/panes/TapePane.tsx';
import { DeveloperPane } from './components/panes/DeveloperPane.tsx';
import { DisassemblyPane } from './components/panes/DisassemblyPane.tsx';

import { paneOrder } from './store/panes.ts';
import { joyP1, joyP2, joyMapP1, joyMapP2, needsGamepadPolling } from './store/settings.ts';
import {
  spectrum, cancelAutoType, joyPressForType, initAudio, init, loadFile,
} from './store/emulator.ts';

// ── Pane registry ───────────────────────────────────────────────────────

const PANE_COMPONENTS: Record<string, () => preact.JSX.Element> = {
  'hardware-panel': HardwarePane,
  'snapshot-panel': LoadSavePane,
  'joystick-panel': JoystickPane,
  'sound-panel': SoundPane,
  'display-pane': DisplayPane,
  'font-panel': FontPane,
  'regs-panel': CpuPane,
  'sysvar-panel': SysVarPane,
  'banks-panel': BanksPane,
  'disk-info-panel': DiskInfoPane,
  'drive-panel': DrivePane,
  'tape-panel': TapePane,
  'developer-panel': DeveloperPane,
  'disasm-panel': DisassemblyPane,
};

function renderPanes(side: 'left' | 'right') {
  const order = paneOrder.value;
  return order
    .filter(p => p.sidebar === side)
    .map(p => {
      const Component = PANE_COMPONENTS[p.id];
      return Component ? <Component key={p.id} /> : null;
    });
}

// ── Keyboard ────────────────────────────────────────────────────────────

const HOST_KEY_TO_JOY: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  AltRight: 'fire', Space: 'fire',
};

function setDpadHighlight(player: number, dir: string, pressed: boolean): void {
  const dpad = document.querySelector(`.joy-dpad[data-player="${player + 1}"]`);
  const btn = dpad?.querySelector(`[data-dir="${dir}"]`);
  btn?.classList.toggle('pressed', pressed);
}

function onKeyDown(e: KeyboardEvent): void {
  if (!spectrum) return;
  cancelAutoType();

  const joyDir = HOST_KEY_TO_JOY[e.code];
  if (joyDir) {
    const joySelectors = [joyP1, joyP2];
    const joyMapSelectors = [joyMapP1, joyMapP2];
    let handled = false;
    for (let p = 0; p < 2; p++) {
      if (joyMapSelectors[p].value === 'keys' && joySelectors[p].value !== 'none') {
        joyPressForType(joyDir, true, joySelectors[p].value);
        setDpadHighlight(p, joyDir, true);
        handled = true;
      }
    }
    if (handled) { e.preventDefault(); return; }
  }

  if (spectrum.keyboard.handleKeyEvent(e.code, true, e.key)) {
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!spectrum) return;

  const joyDir = HOST_KEY_TO_JOY[e.code];
  if (joyDir) {
    const joySelectors = [joyP1, joyP2];
    const joyMapSelectors = [joyMapP1, joyMapP2];
    let handled = false;
    for (let p = 0; p < 2; p++) {
      if (joyMapSelectors[p].value === 'keys' && joySelectors[p].value !== 'none') {
        joyPressForType(joyDir, false, joySelectors[p].value);
        setDpadHighlight(p, joyDir, false);
        handled = true;
      }
    }
    if (handled) { e.preventDefault(); return; }
  }

  if (spectrum.keyboard.handleKeyEvent(e.code, false, e.key)) {
    e.preventDefault();
  }
}

// ── Gamepad polling ─────────────────────────────────────────────────────

const GAMEPAD_DEADZONE = 0.4;
const gamepadPrevState: Array<Record<string, boolean>> = [{}, {}];

function pollGamepads(): void {
  if (!spectrum) return;
  const joySelectors = [joyP1, joyP2];
  const joyMapSelectors = [joyMapP1, joyMapP2];
  const gamepads = navigator.getGamepads();
  for (let p = 0; p < 2; p++) {
    if (joyMapSelectors[p].value !== 'gamepad') continue;
    const gp = gamepads[p] ?? null;
    const prev = gamepadPrevState[p];
    const mode = joySelectors[p].value;
    if (!gp || mode === 'none') {
      for (const dir of ['up', 'down', 'left', 'right', 'fire']) {
        if (prev[dir]) {
          joyPressForType(dir, false, mode);
          setDpadHighlight(p, dir, false);
          prev[dir] = false;
        }
      }
      continue;
    }

    const axisX = gp.axes[0] ?? 0;
    const axisY = gp.axes[1] ?? 0;
    const dirs: Record<string, boolean> = {
      left: axisX < -GAMEPAD_DEADZONE,
      right: axisX > GAMEPAD_DEADZONE,
      up: axisY < -GAMEPAD_DEADZONE,
      down: axisY > GAMEPAD_DEADZONE,
      fire: gp.buttons[0]?.pressed ?? false,
    };

    for (const dir of ['up', 'down', 'left', 'right', 'fire'] as const) {
      if (dirs[dir] !== (prev[dir] ?? false)) {
        joyPressForType(dir, dirs[dir], mode);
        setDpadHighlight(p, dir, dirs[dir]);
        prev[dir] = dirs[dir];
      }
    }
  }
}

export function App() {
  // Register global keyboard/audio/drag-drop handlers
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
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

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('click', initAudio);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, []);

  // Gamepad polling loop
  useEffect(() => {
    if (!needsGamepadPolling.value) return;
    let rafId = 0;
    function loop() {
      pollGamepads();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [needsGamepadPolling.value]);

  // Init emulator on mount
  useEffect(() => { init(); }, []);

  return (
    <>
      <Sidebar id="sidebar" side="left" extra={
        <div id="toolbar">
          <h1>
            <span class="logo-stripe" />
            <span class="logo">ZX<span class="logo-num">84</span></span>
            <span class="logo-stripe" />
          </h1>
        </div>
      }>
        {renderPanes('left')}
      </Sidebar>

      <div id="main">
        <Screen />
        <StatusBar />
        <div id="diag"><div id="diag-header" /></div>
      </div>

      <Sidebar id="right-sidebar" side="right">
        {renderPanes('right')}
      </Sidebar>

      <Tooltip />
    </>
  );
}
