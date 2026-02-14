import { Pane } from '../Pane.tsx';
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
        >{paused ? '\u25B6' : '\u23F8'}</button>
        <button id="cpu-reset" title="Reset machine" onClick={resetMachine}>&#x27F3;</button>
        <button id="cpu-loop" title="Copy CPU state to clipboard" onClick={copyCpuState}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="5" y="3" width="8" height="11" rx="1"/><path d="M3 12V3a1 1 0 0 1 1-1h6"/>
          </svg>
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
