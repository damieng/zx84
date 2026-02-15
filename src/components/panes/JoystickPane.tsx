import { Pane } from '@/components/Pane.tsx';
import { HiChevronUp, HiChevronDown, HiChevronLeft, HiChevronRight } from 'react-icons/hi2';
import { joyP1, joyP2, joyMapP1, joyMapP2, persistSetting, gamepadConfigP1, gamepadConfigP2 } from '@/store/settings.ts';
import { joyPressForType } from '@/emulator.ts';
import { signal } from '@preact/signals';

// Configuration mode state
export const configuringPlayer = signal<number>(-1); // -1 = not configuring, 0 = P1, 1 = P2
export const configuringStep = signal<string>(''); // 'deadzone', 'up', 'down', 'left', 'right', 'fire'
export const configuringProgress = signal<number>(0); // 0–1 progress

function cancelConfiguration(): void {
  configuringPlayer.value = -1;
  configuringStep.value = '';
  configuringProgress.value = 0;
}

function DpadButton({ dir, playerIdx }: { dir: string; playerIdx: number }) {
  const selectors = [joyP1, joyP2];
  const icons: Record<string, any> = {
    up: HiChevronUp, down: HiChevronDown, left: HiChevronLeft, right: HiChevronRight,
  };
  const Icon = icons[dir];

  const onPress = (e: Event) => {
    e.preventDefault();
    (e.target as HTMLElement).classList.add('pressed');
    joyPressForType(dir, true, selectors[playerIdx].value);
  };
  const onRelease = (e: Event) => {
    e.preventDefault();
    (e.target as HTMLElement).classList.remove('pressed');
    joyPressForType(dir, false, selectors[playerIdx].value);
  };
  const onLeave = (e: Event) => {
    (e.target as HTMLElement).classList.remove('pressed');
    joyPressForType(dir, false, selectors[playerIdx].value);
  };

  const isActive = configuringPlayer.value === playerIdx && configuringStep.value === dir;
  const progress = isActive ? configuringProgress.value : 0;

  const configStyle = isActive ? {
    background: progress > 0
      ? `conic-gradient(from 0deg, #3399ff ${progress * 360}deg, #e0e0e0 ${progress * 360}deg)`
      : undefined,
  } : undefined;

  const className = [
    'joy-btn',
    dir === 'fire' ? 'joy-fire' : '',
    isActive ? (progress > 0 ? 'joy-config-holding' : 'joy-config-waiting') : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      class={className}
      data-dir={dir}
      onMouseDown={onPress}
      onMouseUp={onRelease}
      onMouseLeave={onLeave}
      onTouchStart={onPress}
      onTouchEnd={onRelease}
      onTouchCancel={onLeave}
      style={configStyle}
    >{dir === 'fire' ? 'F1' : <Icon />}</div>
  );
}

function DeadZoneIndicator({ playerIdx }: { playerIdx: number }) {
  const isActive = configuringPlayer.value === playerIdx && configuringStep.value === 'deadzone';
  const progress = isActive ? configuringProgress.value : 0;

  const className = [
    'joy-deadzone',
    isActive ? (progress > 0 ? 'joy-config-holding' : 'joy-config-waiting') : '',
  ].filter(Boolean).join(' ');

  const style = isActive && progress > 0 ? {
    background: `conic-gradient(from 0deg, #3399ff ${progress * 360}deg, #e0e0e0 ${progress * 360}deg)`,
  } : undefined;

  return <div class={className} data-dir="deadzone" style={style} />;
}

function JoyColumn({ playerIdx, label }: { playerIdx: number; label: string }) {
  const joySel = playerIdx === 0 ? joyP1 : joyP2;
  const joyMapSel = playerIdx === 0 ? joyMapP1 : joyMapP2;
  const gamepadConfig = playerIdx === 0 ? gamepadConfigP1 : gamepadConfigP2;
  const joyKey = playerIdx === 0 ? 'joy-p1' : 'joy-p2';
  const mapKey = playerIdx === 0 ? 'joy-map-p1' : 'joy-map-p2';

  const hasGamepadConfig = gamepadConfig.value !== null;

  const handleMapChange = (e: Event) => {
    const newValue = (e.target as HTMLSelectElement).value;

    // Cancel any ongoing configuration for this player
    if (configuringPlayer.value === playerIdx) {
      cancelConfiguration();
    }

    if (newValue === 'gamepad-configure') {
      // Clear existing config and start configuration mode
      if (playerIdx === 0) gamepadConfigP1.value = null;
      else gamepadConfigP2.value = null;

      configuringPlayer.value = playerIdx;
      configuringStep.value = 'deadzone';
      configuringProgress.value = 0;
      // Show as gamepad in dropdown during config
      joyMapSel.value = 'gamepad';
    } else {
      joyMapSel.value = newValue;
      persistSetting(mapKey, newValue);
    }
  };

  return (
    <div class="joy-column">
      <label>{label}
        <select id={joyKey} value={joySel.value} onChange={(e) => {
          joySel.value = (e.target as HTMLSelectElement).value;
          persistSetting(joyKey, joySel.value);
        }}>
          <option value="kempston">Kempston</option>
          <option value="cursor">Cursor</option>
          <option value="sinclair1">Sinclair Port 1</option>
          <option value="sinclair2">Sinclair Port 2</option>
          <option value="none">None</option>
        </select>
      </label>
      <label>Map
        <select id={`joy-map-${label.toLowerCase()}`} value={joyMapSel.value} onChange={handleMapChange}>
          <option value="none">No mapping</option>
          <option value="keys">Cursor keys</option>
          {hasGamepadConfig && <option value="gamepad">Gamestick</option>}
          <option value="gamepad-configure">Configure Gamestick</option>
        </select>
      </label>
      <div class="joy-dpad" data-player={playerIdx + 1}>
        <DpadButton dir="fire" playerIdx={playerIdx} />
        <DpadButton dir="up" playerIdx={playerIdx} />
        <div class="joy-spacer" />
        <DpadButton dir="left" playerIdx={playerIdx} />
        <DeadZoneIndicator playerIdx={playerIdx} />
        <DpadButton dir="right" playerIdx={playerIdx} />
        <div class="joy-spacer" />
        <DpadButton dir="down" playerIdx={playerIdx} />
        <div class="joy-spacer" />
      </div>
    </div>
  );
}

export function JoystickPane() {
  return (
    <Pane id="joystick-panel" label="Joysticks">
      <div id="joy-columns">
        <JoyColumn playerIdx={0} label="P1" />
        <JoyColumn playerIdx={1} label="P2" />
      </div>
    </Pane>
  );
}
