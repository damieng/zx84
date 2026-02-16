/**
 * Manages keyboard and gamepad input for the emulator.
 * Handles joystick emulation via keyboard/gamepad and gamepad configuration.
 */

import {
  joyP1, joyP2, joyMapP1, setJoyMapP1, joyMapP2, setJoyMapP2,
  gamepadConfigP1, gamepadConfigP2, saveGamepadConfig, persistSetting,
  type GamepadConfig, type GamepadBinding
} from '@/store/settings.ts';
import {
  spectrum, joyPressForType,
} from '@/emulator.ts';
import {
  configuringPlayer, setConfiguringPlayer,
  configuringStep, setConfiguringStep,
  setConfiguringProgress,
} from '@/components/panes/JoystickPane.tsx';

// ── Keyboard mappings ───────────────────────────────────────────────────

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

// ── Gamepad constants ───────────────────────────────────────────────────

const GAMEPAD_DEADZONE = 0.4;
const CONFIG_STEPS = ['deadzone', 'up', 'down', 'left', 'right', 'fire'] as const;
const DEADZONE_DURATION = 2000;
const BIND_HOLD_DURATION = 500;

// ── Helper functions ────────────────────────────────────────────────────

function setDpadHighlight(player: number, dir: string, pressed: boolean): void {
  const dpad = document.querySelector(`.joy-dpad[data-player="${player + 1}"]`);
  const btn = dpad?.querySelector(`[data-dir="${dir}"]`);
  btn?.classList.toggle('pressed', pressed);
}

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

// ── InputController class ───────────────────────────────────────────────

export class InputController {
  private gamepadPrevState: Array<Record<string, boolean>> = [{}, {}];
  private gamepadDetected: boolean[] = [false, false];

  // Configuration state
  private configPending: Partial<GamepadConfig> = {};
  private configStartTime = 0;
  private configCandidate: GamepadBinding | null = null;

  // ── Keyboard handling ─────────────────────────────────────────────────

  private handleJoyKey(e: KeyboardEvent, pressed: boolean): boolean {
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

  onKeyDown = (e: KeyboardEvent): void => {
    if (!spectrum) return;
    if (this.handleJoyKey(e, true)) { e.preventDefault(); return; }
    if (spectrum.keyboard.handleKeyEvent(e.code, true, e.key)) {
      e.preventDefault();
    }
  };

  onKeyUp = (e: KeyboardEvent): void => {
    if (!spectrum) return;
    if (this.handleJoyKey(e, false)) { e.preventDefault(); return; }
    if (spectrum.keyboard.handleKeyEvent(e.code, false, e.key)) {
      e.preventDefault();
    }
  };

  // ── Gamepad configuration ─────────────────────────────────────────────

  private configReset(): void {
    this.configPending = {};
    this.configStartTime = 0;
    this.configCandidate = null;
    setConfiguringProgress(0);
  }

  private advanceConfig(): void {
    const p = configuringPlayer();
    const currentStep = configuringStep();
    const idx = CONFIG_STEPS.indexOf(currentStep as any);

    this.configStartTime = 0;
    this.configCandidate = null;
    setConfiguringProgress(0);

    if (idx < CONFIG_STEPS.length - 1) {
      setConfiguringStep('');
      setTimeout(() => { setConfiguringStep(CONFIG_STEPS[idx + 1]); }, 250);
    } else {
      const finalConfig = this.configPending as GamepadConfig;
      saveGamepadConfig((p + 1) as 1 | 2, finalConfig);
      if (p === 0) {
        setJoyMapP1('gamepad');
      } else {
        setJoyMapP2('gamepad');
      }
      persistSetting(p === 0 ? 'joy-map-p1' : 'joy-map-p2', 'gamepad');
      setConfiguringPlayer(-1);
      setConfiguringStep('');
      this.configPending = {};
    }
  }

  // ── Gamepad polling ───────────────────────────────────────────────────

  pollGamepads(): void {
    if (!spectrum) return;
    const joySelectors = [joyP1, joyP2];
    const joyMapSelectors = [joyMapP1, joyMapP2];
    const gamepads = navigator.getGamepads();

    // Configuration mode
    if (configuringPlayer() >= 0 && configuringStep()) {
      const p = configuringPlayer();
      const gp = gamepads[p] ?? gamepads[0] ?? null;
      if (!gp) return;

      const step = configuringStep();

      if (step === 'deadzone') {
        if (!this.configStartTime) this.configStartTime = Date.now();
        const elapsed = Date.now() - this.configStartTime;
        setConfiguringProgress(Math.min(1, elapsed / DEADZONE_DURATION));

        if (elapsed >= DEADZONE_DURATION) {
          this.configPending.deadzone = Array.from(gp.axes);
          this.advanceConfig();
        }
        return;
      }

      const neutralAxes = this.configPending.deadzone ?? [];
      const input = detectInput(gp, neutralAxes);

      if (input) {
        if (isBindingAlreadyUsed(input, this.configPending)) {
          this.configCandidate = null;
          this.configStartTime = 0;
          setConfiguringProgress(0);
          return;
        }

        if (this.configCandidate && bindingsEqual(input, this.configCandidate)) {
          const elapsed = Date.now() - this.configStartTime;
          setConfiguringProgress(Math.min(1, elapsed / BIND_HOLD_DURATION));

          if (elapsed >= BIND_HOLD_DURATION) {
            (this.configPending as any)[step] = input;
            this.advanceConfig();
          }
        } else {
          this.configCandidate = input;
          this.configStartTime = Date.now();
          setConfiguringProgress(0);
        }
      } else {
        if (this.configCandidate) {
          this.configCandidate = null;
          this.configStartTime = 0;
          setConfiguringProgress(0);
        }
      }

      return;
    }

    // Normal gamepad polling
    for (let p = 0; p < 2; p++) {
      const gp = gamepads[p] ?? null;

      if (gp && !this.gamepadDetected[p]) {
        this.gamepadDetected[p] = true;
      } else if (!gp && this.gamepadDetected[p]) {
        this.gamepadDetected[p] = false;
      }
      if (!gp) continue;

      const mapValue = joyMapSelectors[p]();
      if (mapValue !== 'gamepad') continue;

      const config = (p === 0 ? gamepadConfigP1 : gamepadConfigP2)();
      if (!config) continue;

      const prev = this.gamepadPrevState[p];
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

  reset(): void {
    this.configReset();
  }
}
