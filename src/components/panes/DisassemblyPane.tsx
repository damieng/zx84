import { Pane } from '../Pane.tsx';
import { HiArrowDownRight, HiArrowTrendingDown, HiArrowUpRight, HiClipboardDocument } from 'react-icons/hi2';
import {
  disasmText, tracing,
  stepInto, stepOver, stepOut,
  startTrace, stopTrace, copyCpuState,
  type TraceMode,
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
        <button title="Copy CPU state + disassembly to clipboard" onClick={copyCpuState}>
          <HiClipboardDocument />
        </button>
        {isTracing ? (
          <button
            class="active"
            title="Stop tracing and copy to clipboard"
            onClick={stopTrace}
          >Stop</button>
        ) : (
          <select
            title="Start tracing (copies to clipboard on stop)"
            onChange={(e) => {
              const sel = e.currentTarget;
              const mode = sel.value as TraceMode;
              if (mode) startTrace(mode);
              sel.selectedIndex = 0;
            }}
          >
            <option value="" disabled selected>Trace ▾</option>
            <option value="full">Full</option>
            <option value="contention">Contention</option>
            <option value="portio">Port IO</option>
          </select>
        )}
      </div>
      <div class="disasm-output" dangerouslySetInnerHTML={{ __html: disasmText.value }} />
    </Pane>
  );
}
