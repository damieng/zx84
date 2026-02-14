import { Pane } from '../Pane.tsx';
import { HiArrowDownRight, HiArrowTrendingDown, HiArrowUpRight } from 'react-icons/hi2';
import {
  disasmText, tracing,
  stepInto, stepOver, stepOut,
  startTrace, stopTrace,
} from '../../store/emulator.ts';

export function DisassemblyPane() {
  const isTracing = tracing.value;

  return (
    <Pane id="disasm-panel" label="Disassembly" mono>
      <div class="disasm-toolbar">
        <button
          title="Step Into (execute one instruction)"
          onClick={stepInto}
        ><HiArrowDownRight /></button>
        <button
          title="Step Over (execute, stepping over CALLs)"
          onClick={stepOver}
        ><HiArrowTrendingDown /></button>
        <button
          title="Step Out (run until RET)"
          onClick={stepOut}
        ><HiArrowUpRight /></button>
        <button
          title={isTracing ? 'Stop tracing and copy to clipboard' : 'Trace execution (copies to clipboard on stop)'}
          class={isTracing ? 'active' : ''}
          onClick={isTracing ? stopTrace : startTrace}
        >{isTracing ? 'Stop' : 'Trace'}</button>
      </div>
      <div class="disasm-output" dangerouslySetInnerHTML={{ __html: disasmText.value }} />
    </Pane>
  );
}
