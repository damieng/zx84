import { Pane } from '../Pane.tsx';
import { HiPlay, HiPause, HiClipboardDocument } from 'react-icons/hi2';
import {
  disasmText, emulationPaused,
  togglePause, stepInto, stepOver, copyCpuState,
} from '../../store/emulator.ts';

export function DisassemblyPane() {
  const paused = emulationPaused.value;

  return (
    <Pane id="disasm-panel" label="Disassembly" mono>
      <div class="disasm-toolbar">
        <button
          title={paused ? 'Resume emulation' : 'Pause emulation'}
          class={paused ? 'active' : ''}
          onClick={togglePause}
        >{paused ? <HiPlay /> : <HiPause />}</button>
        <button
          title="Step into (execute one instruction)"
          onClick={stepInto}
        >Into</button>
        <button
          title="Step over (execute, stepping over CALLs)"
          onClick={stepOver}
        >Over</button>
        <button title="Copy CPU state to clipboard" onClick={copyCpuState}>
          <HiClipboardDocument />
        </button>
      </div>
      <div class="disasm-output" dangerouslySetInnerHTML={{ __html: disasmText.value }} />
    </Pane>
  );
}
