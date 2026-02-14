import { Pane } from '../Pane.tsx';
import { HiPower, HiPlay, HiPause, HiClipboardDocument } from 'react-icons/hi2';
import {
  regsHtml, emulationPaused, turboMode, clockSpeedText,
  resetMachine, togglePause, copyCpuState, toggleTurbo,
} from '../../store/emulator.ts';

export function CpuPane() {
  const paused = emulationPaused.value;

  return (
    <Pane id="regs-panel" label="CPU" mono>
      <div id="cpu-controls">
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiPower /></button>
        <button
          title={paused ? 'Resume emulation' : 'Pause emulation'}
          class={paused ? 'active' : ''}
          onClick={togglePause}
        >{paused ? <HiPlay /> : <HiPause />}</button>
        <button title="Copy CPU state to clipboard" onClick={copyCpuState}>
          <HiClipboardDocument />
        </button>
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
