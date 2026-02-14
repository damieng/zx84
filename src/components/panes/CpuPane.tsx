import { Pane } from '../Pane.tsx';
import { HiPower } from 'react-icons/hi2';
import {
  regsHtml, turboMode, clockSpeedText,
  resetMachine, toggleTurbo,
} from '../../store/emulator.ts';

export function CpuPane() {
  return (
    <Pane id="regs-panel" label="CPU" mono>
      <div id="cpu-controls">
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiPower /></button>
        <button
          id="cpu-mhz"
          title={turboMode.value ? 'Switch to normal speed' : 'Toggle turbo speed'}
          class={turboMode.value ? 'active' : ''}
          onClick={toggleTurbo}
        >{clockSpeedText.value}</button>
      </div>
      <pre id="regs-output" dangerouslySetInnerHTML={{ __html: regsHtml.value }} />
    </Pane>
  );
}
