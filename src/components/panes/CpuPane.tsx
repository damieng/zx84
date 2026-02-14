import { Pane } from '../Pane.tsx';
import { HiPlay, HiPause, HiPower, HiClipboardDocument } from 'react-icons/hi2';
import {
  regsHtml, emulationPaused, turboMode, clockSpeedText,
  togglePause, resetMachine, toggleTurbo, copyCpuState,
} from '../../store/emulator.ts';

export function CpuPane() {
  const paused = emulationPaused.value;

  return (
    <Pane id="regs-panel" label="CPU" mono>
      <div id="cpu-controls">
        <button
          id="cpu-play"
          title={paused ? 'Resume emulation' : 'Pause emulation'}
          class={paused ? 'active' : ''}
          onClick={togglePause}
        >{paused ? <HiPlay /> : <HiPause />}</button>
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}><HiPower /></button>
        <button id="cpu-loop" title="Copy CPU state to clipboard" onClick={copyCpuState}>
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
