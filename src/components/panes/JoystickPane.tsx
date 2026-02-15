import { createSignal, Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { HiOutlineChevronUp, HiOutlineChevronDown, HiOutlineChevronLeft, HiOutlineChevronRight } from 'solid-icons/hi';
import { joyP1, joyP2, joyMapP1, joyMapP2, setJoyP1, setJoyP2, setJoyMapP1, setJoyMapP2, persistSetting, gamepadConfigP1, gamepadConfigP2, setGamepadConfigP1, setGamepadConfigP2 } from '@/store/settings.ts';
import { joyPressForType } from '@/emulator.ts';

// Configuration mode state
export const [configuringPlayer, setConfiguringPlayer] = createSignal<number>(-1);
export const [configuringStep, setConfiguringStep] = createSignal<string>('');
export const [configuringProgress, setConfiguringProgress] = createSignal<number>(0);

function cancelConfiguration(): void {
  setConfiguringPlayer(-1);
  setConfiguringStep('');
  setConfiguringProgress(0);
}

function DpadButton(props: { dir: string; playerIdx: number }) {
  const selectors = [joyP1, joyP2];
  const icons: Record<string, any> = {
    up: HiOutlineChevronUp, down: HiOutlineChevronDown, left: HiOutlineChevronLeft, right: HiOutlineChevronRight,
  };
  const Icon = icons[props.dir];

  const onPress = (e: Event) => {
    e.preventDefault();
    (e.target as HTMLElement).classList.add('pressed');
    joyPressForType(props.dir, true, selectors[props.playerIdx]());
  };
  const onRelease = (e: Event) => {
    e.preventDefault();
    (e.target as HTMLElement).classList.remove('pressed');
    joyPressForType(props.dir, false, selectors[props.playerIdx]());
  };
  const onLeave = (e: Event) => {
    (e.target as HTMLElement).classList.remove('pressed');
    joyPressForType(props.dir, false, selectors[props.playerIdx]());
  };

  const isActive = () => configuringPlayer() === props.playerIdx && configuringStep() === props.dir;
  const progress = () => isActive() ? configuringProgress() : 0;

  const configStyle = () => isActive() ? {
    background: progress() > 0
      ? `conic-gradient(from 0deg, #3399ff ${progress() * 360}deg, #e0e0e0 ${progress() * 360}deg)`
      : undefined,
  } : undefined;

  const className = () => [
    'joy-btn',
    props.dir === 'fire' ? 'joy-fire' : '',
    isActive() ? (progress() > 0 ? 'joy-config-holding' : 'joy-config-waiting') : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      class={className()}
      data-dir={props.dir}
      onMouseDown={onPress}
      onMouseUp={onRelease}
      onMouseLeave={onLeave}
      onTouchStart={onPress}
      onTouchEnd={onRelease}
      onTouchCancel={onLeave}
      style={configStyle()}
    >{props.dir === 'fire' ? 'F1' : <Icon />}</div>
  );
}

function DeadZoneIndicator(props: { playerIdx: number }) {
  const isActive = () => configuringPlayer() === props.playerIdx && configuringStep() === 'deadzone';
  const progress = () => isActive() ? configuringProgress() : 0;

  const className = () => [
    'joy-deadzone',
    isActive() ? (progress() > 0 ? 'joy-config-holding' : 'joy-config-waiting') : '',
  ].filter(Boolean).join(' ');

  const style = () => isActive() && progress() > 0 ? {
    background: `conic-gradient(from 0deg, #3399ff ${progress() * 360}deg, #e0e0e0 ${progress() * 360}deg)`,
  } : undefined;

  return <div class={className()} data-dir="deadzone" style={style()} />;
}

function JoyColumn(props: { playerIdx: number; label: string }) {
  const joySel = () => props.playerIdx === 0 ? joyP1 : joyP2;
  const setJoySel = () => props.playerIdx === 0 ? setJoyP1 : setJoyP2;
  const joyMapSel = () => props.playerIdx === 0 ? joyMapP1 : joyMapP2;
  const setJoyMapSel = () => props.playerIdx === 0 ? setJoyMapP1 : setJoyMapP2;
  const gamepadConfig = () => props.playerIdx === 0 ? gamepadConfigP1 : gamepadConfigP2;
  const joyKey = () => props.playerIdx === 0 ? 'joy-p1' : 'joy-p2';
  const mapKey = () => props.playerIdx === 0 ? 'joy-map-p1' : 'joy-map-p2';

  const hasGamepadConfig = () => gamepadConfig()() !== null;

  const handleMapChange = (e: Event) => {
    const newValue = (e.target as HTMLSelectElement).value;

    if (configuringPlayer() === props.playerIdx) {
      cancelConfiguration();
    }

    if (newValue === 'gamepad-configure') {
      if (props.playerIdx === 0) setGamepadConfigP1(null);
      else setGamepadConfigP2(null);

      setConfiguringPlayer(props.playerIdx);
      setConfiguringStep('deadzone');
      setConfiguringProgress(0);
      setJoyMapSel()('gamepad');
    } else {
      setJoyMapSel()(newValue);
      persistSetting(mapKey(), newValue);
    }
  };

  return (
    <div class="joy-column">
      <label>{props.label}
        <select id={joyKey()} value={joySel()()} onChange={(e) => {
          setJoySel()((e.target as HTMLSelectElement).value);
          persistSetting(joyKey(), joySel()());
        }}>
          <option value="kempston">Kempston</option>
          <option value="cursor">Cursor</option>
          <option value="sinclair1">Sinclair Port 1</option>
          <option value="sinclair2">Sinclair Port 2</option>
          <option value="none">None</option>
        </select>
      </label>
      <label>Map
        <select id={`joy-map-${props.label.toLowerCase()}`} value={joyMapSel()()} onChange={handleMapChange}>
          <option value="none">No mapping</option>
          <option value="keys">Cursor keys</option>
          <option value="wasd">WASD + Space</option>
          <Show when={hasGamepadConfig()}><option value="gamepad">Gamestick</option></Show>
          <option value="gamepad-configure">Configure Gamestick</option>
        </select>
      </label>
      <div class="joy-dpad" data-player={props.playerIdx + 1}>
        <DpadButton dir="fire" playerIdx={props.playerIdx} />
        <DpadButton dir="up" playerIdx={props.playerIdx} />
        <div class="joy-spacer" />
        <DpadButton dir="left" playerIdx={props.playerIdx} />
        <DeadZoneIndicator playerIdx={props.playerIdx} />
        <DpadButton dir="right" playerIdx={props.playerIdx} />
        <div class="joy-spacer" />
        <DpadButton dir="down" playerIdx={props.playerIdx} />
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
