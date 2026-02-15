import { useRef, useEffect } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { DropDownMenuButton } from '../DropDownMenuButton.tsx';
import {
  HiPlay, HiPause,
  HiArrowDownRight, HiArrowTrendingDown, HiArrowUpRight,
  HiPencilSquare,
} from 'react-icons/hi2';
import {
  disasmText, regsHtml, tracing, emulationPaused,
  stepInto, stepOver, stepOut,
  startTrace, stopTrace, copyCpuState,
  togglePause, toggleBreakpoint, runTo,
} from '../../store/emulator.ts';

/** Find the data-addr from a click target inside .disasm-output */
function addrFromEvent(e: MouseEvent): number | null {
  const line = (e.target as HTMLElement).closest('.d-line');
  if (!line) return null;
  const addr = (line as HTMLElement).dataset.addr;
  return addr != null ? Number(addr) : null;
}

export function DisassemblyPane() {
  const isTracing = tracing.value;
  const paused = emulationPaused.value;
  const outputRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on any click
  useEffect(() => {
    function close() { if (menuRef.current) menuRef.current.style.display = 'none'; }
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  function onDblClick(e: MouseEvent) {
    const addr = addrFromEvent(e);
    if (addr != null) toggleBreakpoint(addr);
  }

  function onContextMenu(e: MouseEvent) {
    const addr = addrFromEvent(e);
    if (addr == null) return;
    e.preventDefault();
    const menu = menuRef.current;
    if (!menu) return;
    const rect = outputRef.current!.getBoundingClientRect();
    menu.style.left = `${e.clientX - rect.left}px`;
    menu.style.top = `${e.clientY - rect.top}px`;
    menu.style.display = 'block';
    menu.dataset.addr = String(addr);
  }

  function onMenuRunTo() {
    const menu = menuRef.current;
    if (!menu) return;
    const addr = Number(menu.dataset.addr);
    menu.style.display = 'none';
    runTo(addr);
  }

  function onMenuToggleBp() {
    const menu = menuRef.current;
    if (!menu) return;
    const addr = Number(menu.dataset.addr);
    menu.style.display = 'none';
    toggleBreakpoint(addr);
  }

  return (
    <Pane id="disasm-panel" label="Debugger" mono>
      <pre id="regs-output" dangerouslySetInnerHTML={{ __html: regsHtml.value }} />
      <div class="disasm-toolbar">
        <button
          title={paused ? 'Resume emulation' : 'Pause emulation'}
          class={paused ? 'active' : ''}
          onClick={togglePause}
        >{paused ? <HiPlay /> : <HiPause />}</button>
        <button
          title="Step Into (execute one instruction)"
          onClick={stepInto}
          disabled={!paused}
        ><HiArrowDownRight /></button>
        <button
          title="Step Over (execute, stepping over CALLs)"
          onClick={stepOver}
          disabled={!paused}
        ><HiArrowTrendingDown /></button>
        <button
          title="Step Out (run until RET)"
          onClick={stepOut}
          disabled={!paused}
        ><HiArrowUpRight /></button>
        {isTracing ? (
          <button
            class="active"
            title="Stop tracing and copy to clipboard"
            onClick={stopTrace}
          >Stop</button>
        ) : (
          <DropDownMenuButton
            icon={<HiPencilSquare />}
            title="Start tracing (copies to clipboard on stop)"
            items={[
              { value: 'full', label: 'Full' },
              { value: 'contention', label: 'Contention' },
              { value: 'portio', label: 'Port IO' },
              { value: 'loopanalysis', label: 'Loop' },
            ]}
            onSelect={(mode) => {
              if (mode === 'loopanalysis') {
                copyCpuState();
              } else {
                startTrace(mode as 'full' | 'contention' | 'portio');
              }
            }}
          />
        )}
      </div>
      {paused && (
        <>
          <div
            class="disasm-output"
            ref={outputRef}
            style="position:relative"
            dangerouslySetInnerHTML={{ __html: disasmText.value }}
            onDblClick={onDblClick}
            onContextMenu={onContextMenu}
          />
          <div ref={menuRef} class="disasm-ctx-menu" style="display:none">
            <div class="disasm-ctx-item" onClick={onMenuRunTo}>Run to here</div>
            <div class="disasm-ctx-item" onClick={onMenuToggleBp}>Toggle breakpoint</div>
          </div>
        </>
      )}
    </Pane>
  );
}
