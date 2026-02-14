import { Pane } from '../Pane.tsx';
import { HiChevronUp, HiChevronDown, HiChevronLeft, HiChevronRight, HiXMark } from 'react-icons/hi2';
import { joyP1, joyP2, joyMapP1, joyMapP2, persistSetting } from '../../store/settings.ts';
import { joyPressForType } from '../../store/emulator.ts';

function DpadButton({ dir, playerIdx }: { dir: string; playerIdx: number }) {
  const selectors = [joyP1, joyP2];
  const icons: Record<string, any> = {
    up: HiChevronUp, down: HiChevronDown, left: HiChevronLeft, right: HiChevronRight, fire: HiXMark,
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

  return (
    <div
      class={`joy-btn${dir === 'fire' ? ' joy-fire' : ''}`}
      data-dir={dir}
      onMouseDown={onPress}
      onMouseUp={onRelease}
      onMouseLeave={onLeave}
      onTouchStart={onPress}
      onTouchEnd={onRelease}
      onTouchCancel={onLeave}
    ><Icon /></div>
  );
}

function JoyColumn({ playerIdx, label }: { playerIdx: number; label: string }) {
  const joySel = playerIdx === 0 ? joyP1 : joyP2;
  const joyMapSel = playerIdx === 0 ? joyMapP1 : joyMapP2;
  const joyKey = playerIdx === 0 ? 'joy-p1' : 'joy-p2';
  const mapKey = playerIdx === 0 ? 'joy-map-p1' : 'joy-map-p2';

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
        <select id={`joy-map-${label.toLowerCase()}`} value={joyMapSel.value} onChange={(e) => {
          joyMapSel.value = (e.target as HTMLSelectElement).value;
          persistSetting(mapKey, joyMapSel.value);
        }}>
          <option value="none">No mapping</option>
          <option value="keys">Cursor keys</option>
          <option value="gamepad">Gamepad</option>
        </select>
      </label>
      <div class="joy-dpad" data-player={playerIdx + 1}>
        <div class="joy-spacer" />
        <DpadButton dir="up" playerIdx={playerIdx} />
        <div class="joy-spacer" />
        <DpadButton dir="left" playerIdx={playerIdx} />
        <DpadButton dir="fire" playerIdx={playerIdx} />
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
    <Pane id="joystick-panel" label="Joystick">
      <div id="joy-columns">
        <JoyColumn playerIdx={0} label="P1" />
        <JoyColumn playerIdx={1} label="P2" />
      </div>
    </Pane>
  );
}
