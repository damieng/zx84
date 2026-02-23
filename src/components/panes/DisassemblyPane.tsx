import { Show, onMount, onCleanup } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { Registers } from '@/components/Registers.tsx';
import { DropDownMenuButton } from '@/components/DropDownMenuButton.tsx';
import {
  HiOutlinePlay, HiOutlinePause,
  HiOutlineArrowDownRight, HiOutlineArrowTrendingDown, HiOutlineArrowUpRight,
  HiOutlineForward, HiOutlinePencilSquare,
} from 'solid-icons/hi';
import {
  disasmText, tracing, emulationPaused,
  stepInto, stepOver, stepOut, stepFrame,
  startTrace, stopTrace, copyCpuState,
  togglePause, toggleBreakpoint, runTo,
} from '@/emulator.ts';

function addrFromEvent(e: MouseEvent): number | null {
  const line = (e.target as HTMLElement).closest('.d-line');
  if (!line) return null;
  const addr = (line as HTMLElement).dataset.addr;
  return addr != null ? Number(addr) : null;
}

export function DisassemblyPane() {
  let outputRef: HTMLElement | undefined;
  let menuRef!: HTMLDivElement;

  function setOutputRef(el: HTMLElement | null) { outputRef = el ?? undefined; }

  onMount(() => {
    function close() { if (menuRef) menuRef.style.display = 'none'; }
    document.addEventListener('click', close);
    onCleanup(() => document.removeEventListener('click', close));
  });

  function onDblClick(e: MouseEvent) {
    const addr = addrFromEvent(e);
    if (addr != null) toggleBreakpoint(addr);
  }

  function onContextMenu(e: MouseEvent) {
    const addr = addrFromEvent(e);
    if (addr == null) return;
    e.preventDefault();
    const menu = menuRef;
    if (!menu || !outputRef) return;
    const rect = outputRef.getBoundingClientRect();
    menu.style.left = `${e.clientX - rect.left}px`;
    menu.style.top = `${e.clientY - rect.top}px`;
    menu.style.display = 'block';
    menu.dataset.addr = String(addr);
  }

  function onMenuRunTo() {
    if (!menuRef) return;
    const addr = Number(menuRef.dataset.addr);
    menuRef.style.display = 'none';
    runTo(addr);
  }

  function onMenuToggleBp() {
    if (!menuRef) return;
    const addr = Number(menuRef.dataset.addr);
    menuRef.style.display = 'none';
    toggleBreakpoint(addr);
  }

  return (
    <Pane id="disasm-panel" label="Debugger" mono>
      <Registers />
      <div class="disasm-toolbar">
        <button
          title={emulationPaused() ? 'Resume emulation' : 'Pause emulation'}
          class={`btn btn-md${emulationPaused() ? ' active' : ''}`}
          onClick={togglePause}
        >{emulationPaused() ? <HiOutlinePlay /> : <HiOutlinePause />}</button>
        <button class="btn btn-md" title="Step Into (execute one instruction)" onClick={stepInto} disabled={!emulationPaused()}><HiOutlineArrowDownRight /></button>
        <button class="btn btn-md" title="Step Over (execute, stepping over CALLs)" onClick={stepOver} disabled={!emulationPaused()}><HiOutlineArrowTrendingDown /></button>
        <button class="btn btn-md" title="Step Out (run until RET)" onClick={stepOut} disabled={!emulationPaused()}><HiOutlineArrowUpRight /></button>
        <button class="btn btn-md" title="Step Frame (run to end of frame)" onClick={stepFrame} disabled={!emulationPaused()}><HiOutlineForward /></button>
        <Show when={tracing()} fallback={
          <DropDownMenuButton
            icon={<HiOutlinePencilSquare />}
            title="Start tracing (copies to clipboard on stop)"
            items={[
              { value: 'full', label: 'Full' },
              { value: 'contention', label: 'Contention' },
              { value: 'portio', label: 'Port IO' },
              { value: 'loopanalysis', label: 'Loop' },
            ]}
            onSelect={(mode) => {
              if (mode === 'loopanalysis') copyCpuState();
              else startTrace(mode as 'full' | 'contention' | 'portio');
            }}
          />
        }>
          <button class="btn btn-md active" title="Stop tracing and copy to clipboard" onClick={stopTrace}>Stop</button>
        </Show>
      </div>
      <Show when={emulationPaused()}>
        <RawHtml
          tag="div"
          class="disasm-output"
          style="position:relative"
          html={disasmText}
          innerRef={setOutputRef}
          onDblClick={onDblClick}
          onContextMenu={onContextMenu}
        />
        <div ref={menuRef} class="disasm-ctx-menu" style="display:none">
          <div class="disasm-ctx-item" onClick={onMenuRunTo}>Run to here</div>
          <div class="disasm-ctx-item" onClick={onMenuToggleBp}>Toggle breakpoint</div>
        </div>
      </Show>
    </Pane>
  );
}
