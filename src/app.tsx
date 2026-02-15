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

import { paneOrder } from '@/ui/panes.ts';
import { joyP1, joyP2, joyMapP1, setJoyMapP1, joyMapP2, setJoyMapP2, needsGamepadPolling, gamepadConfigP1, gamepadConfigP2, saveGamepadConfig, persistSetting, type GamepadConfig, type GamepadBinding } from '@/store/settings.ts';
import {
  spectrum, joyPressForType, initAudio, init, loadFile,
} from '@/emulator.ts';
import {
  configuringPlayer, setConfiguringPlayer,
  configuringStep, setConfiguringStep,
  setConfiguringProgress,
} from '@/components/panes/JoystickPane.tsx';

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
  'disasm-panel': DisassemblyPane,
  'dev-panel': DevPane,
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

// ── Keyboard ────────────────────────────────────────────────────────────

const CURSOR_KEY_TO_JOY: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  AltRight: 'fire', Space: 'fire',
};

const WASD_KEY_TO_JOY: Record<string, string> = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Space: 'fire',
};

const KEY_MAP_FOR_MODE: Record<string, Record<string, string>> = {
  keys: CURSOR_KEY_TO_JOY,
  wasd: WASD_KEY_TO_JOY,
};

function setDpadHighlight(player: number, dir: string, pressed: boolean): void {
  const dpad = document.querySelector(`.joy-dpad[data-player="${player + 1}"]`);
  const btn = dpad?.querySelector(`[data-dir="${dir}"]`);
  btn?.classList.toggle('pressed', pressed);
}

function handleJoyKey(e: KeyboardEvent, pressed: boolean): boolean {
  const joySelectors = [joyP1, joyP2];
  const joyMapSelectors = [joyMapP1, joyMapP2];
  let handled = false;
  for (let p = 0; p < 2; p++) {
    const mapMode = joyMapSelectors[p]();
    const keyMap = KEY_MAP_FOR_MODE[mapMode];
    if (!keyMap || joySelectors[p]() === 'none') continue;
    const joyDir = keyMap[e.code];
    if (joyDir) {
      joyPressForType(joyDir, pressed, joySelectors[p]());
      setDpadHighlight(p, joyDir, pressed);
      handled = true;
    }
  }
  return handled;
}

function onKeyDown(e: KeyboardEvent): void {
  if (!spectrum) return;
  if (handleJoyKey(e, true)) { e.preventDefault(); return; }
  if (spectrum.keyboard.handleKeyEvent(e.code, true, e.key)) {
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!spectrum) return;
  if (handleJoyKey(e, false)) { e.preventDefault(); return; }
  if (spectrum.keyboard.handleKeyEvent(e.code, false, e.key)) {
    e.preventDefault();
  }
}

// ── Gamepad polling ─────────────────────────────────────────────────────

const GAMEPAD_DEADZONE = 0.4;
const gamepadPrevState: Array<Record<string, boolean>> = [{}, {}];
const gamepadDetected: boolean[] = [false, false];

// Helper to detect if a binding is currently active
function isBindingActive(gp: Gamepad, binding: GamepadBinding, neutralAxes?: number[]): boolean {
  if (binding.type === 'button') {
    return gp.buttons[binding.index]?.pressed ?? false;
  }
  const value = gp.axes[binding.index] ?? 0;
  const neutral = neutralAxes?.[binding.index] ?? 0;
  const deviation = value - neutral;
  return binding.direction === 'positive'
    ? deviation > GAMEPAD_DEADZONE
    : deviation < -GAMEPAD_DEADZONE;
}

// Detect any input relative to neutral axes, return a binding
function detectInput(gp: Gamepad, neutralAxes: number[]): GamepadBinding | null {
  for (let i = 0; i < gp.buttons.length; i++) {
    if (gp.buttons[i].pressed) return { type: 'button', index: i };
  }
  for (let i = 0; i < gp.axes.length; i++) {
    const deviation = (gp.axes[i] ?? 0) - (neutralAxes[i] ?? 0);
    if (deviation > GAMEPAD_DEADZONE) return { type: 'axis', index: i, direction: 'positive' };
    if (deviation < -GAMEPAD_DEADZONE) return { type: 'axis', index: i, direction: 'negative' };
  }
  return null;
}

function bindingsEqual(a: GamepadBinding, b: GamepadBinding): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'button' && b.type === 'button') return a.index === b.index;
  if (a.type === 'axis' && b.type === 'axis') return a.index === b.index && a.direction === b.direction;
  return false;
}

function isBindingAlreadyUsed(binding: GamepadBinding, config: Partial<GamepadConfig>): boolean {
  for (const dir of ['up', 'down', 'left', 'right', 'fire'] as const) {
    const existing = config[dir];
    if (existing && bindingsEqual(binding, existing)) return true;
  }
  return false;
}

// ── Configuration state ─────────────────────────────────────────────────

const CONFIG_STEPS = ['deadzone', 'up', 'down', 'left', 'right', 'fire'] as const;
const DEADZONE_DURATION = 2000;
const BIND_HOLD_DURATION = 500;

let configPending: Partial<GamepadConfig> = {};
let configStartTime = 0;           // when current step started (deadzone) or candidate detected
let configCandidate: GamepadBinding | null = null;

function configReset(): void {
  configPending = {};
  configStartTime = 0;
  configCandidate = null;
  setConfiguringProgress(0);
}

function advanceConfig(): void {
  const p = configuringPlayer();
  const currentStep = configuringStep();
  const idx = CONFIG_STEPS.indexOf(currentStep as any);

  configStartTime = 0;
  configCandidate = null;
  setConfiguringProgress(0);

  if (idx < CONFIG_STEPS.length - 1) {
    // Brief pause, then next step
    setConfiguringStep('');
    setTimeout(() => { setConfiguringStep(CONFIG_STEPS[idx + 1]); }, 250);
  } else {
    // All done — save configuration
    const finalConfig = configPending as GamepadConfig;
    saveGamepadConfig((p + 1) as 1 | 2, finalConfig);
    if (p === 0) {
      setJoyMapP1('gamepad');
    } else {
      setJoyMapP2('gamepad');
    }
    persistSetting(p === 0 ? 'joy-map-p1' : 'joy-map-p2', 'gamepad');
    setConfiguringPlayer(-1);
    setConfiguringStep('');
    configPending = {};
  }
}

// ── Main poll function ──────────────────────────────────────────────────

function pollGamepads(): void {
  if (!spectrum) return;
  const joySelectors = [joyP1, joyP2];
  const joyMapSelectors = [joyMapP1, joyMapP2];
  const gamepads = navigator.getGamepads();

  // ── Configuration mode ──────────────────────────────────────────────
  if (configuringPlayer() >= 0 && configuringStep()) {
    const p = configuringPlayer();
    const gp = gamepads[p] ?? gamepads[0] ?? null;
    if (!gp) return;

    const step = configuringStep();

    // Deadzone: just snapshot whatever the axes read right now after a timer
    if (step === 'deadzone') {
      if (!configStartTime) configStartTime = Date.now();
      const elapsed = Date.now() - configStartTime;
      setConfiguringProgress(Math.min(1, elapsed / DEADZONE_DURATION));

      if (elapsed >= DEADZONE_DURATION) {
        configPending.deadzone = Array.from(gp.axes);
        advanceConfig();
      }
      return;
    }

    // Direction / fire binding steps
    const neutralAxes = configPending.deadzone ?? [];
    const input = detectInput(gp, neutralAxes);

    if (input) {
      // Reject duplicates
      if (isBindingAlreadyUsed(input, configPending)) {
        configCandidate = null;
        configStartTime = 0;
        setConfiguringProgress(0);
        return;
      }

      if (configCandidate && bindingsEqual(input, configCandidate)) {
        // Still holding same input
        const elapsed = Date.now() - configStartTime;
        setConfiguringProgress(Math.min(1, elapsed / BIND_HOLD_DURATION));

        if (elapsed >= BIND_HOLD_DURATION) {
          (configPending as any)[step] = input;
          advanceConfig();
        }
      } else {
        // New candidate
        configCandidate = input;
        configStartTime = Date.now();
        setConfiguringProgress(0);
      }
    } else {
      // Released — reset
      if (configCandidate) {
        configCandidate = null;
        configStartTime = 0;
        setConfiguringProgress(0);
      }
    }

    return; // skip normal polling during config
  }

  // ── Normal gamepad polling ──────────────────────────────────────────
  for (let p = 0; p < 2; p++) {
    const gp = gamepads[p] ?? null;

    if (gp && !gamepadDetected[p]) {
      gamepadDetected[p] = true;
    } else if (!gp && gamepadDetected[p]) {
      gamepadDetected[p] = false;
    }
    if (!gp) continue;

    const mapValue = joyMapSelectors[p]();
    if (mapValue !== 'gamepad') continue;

    const config = (p === 0 ? gamepadConfigP1 : gamepadConfigP2)();
    if (!config) continue;

    const prev = gamepadPrevState[p];
    const mode = joySelectors[p]();

    if (mode === 'none') {
      for (const dir of ['up', 'down', 'left', 'right', 'fire']) {
        if (prev[dir]) {
          joyPressForType(dir, false, mode);
          setDpadHighlight(p, dir, false);
          prev[dir] = false;
        }
      }
      continue;
    }

    const dirs: Record<string, boolean> = {
      up: isBindingActive(gp, config.up, config.deadzone),
      down: isBindingActive(gp, config.down, config.deadzone),
      left: isBindingActive(gp, config.left, config.deadzone),
      right: isBindingActive(gp, config.right, config.deadzone),
      fire: isBindingActive(gp, config.fire, config.deadzone),
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
  const leftPanes = renderPanes('left');
  const rightPanes = renderPanes('right');

  // Register global keyboard/audio/drag-drop handlers
  onMount(() => {
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

    onCleanup(() => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
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
      pollGamepads();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    onCleanup(() => {
      cancelAnimationFrame(rafId);
      configReset();
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
            <span class="logo">ZX<span class="logo-num">84</span></span>
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
