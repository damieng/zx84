import { createEffect, Show } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { DropDownMenuButton } from '@/components/DropDownMenuButton.tsx';
import { HiOutlineBackward, HiOutlinePlay, HiOutlinePause, HiOutlineStop, HiOutlineEllipsisVertical, HiOutlineChevronLeft, HiOutlineChevronRight } from 'solid-icons/hi';
import {
  tapeLoaded, tapeName, tapeBlocks, tapePosition, tapePlaying, tapePaused,
  tapeRewind, tapeTogglePlay, tapeTogglePause, tapeSetPosition, toggleAutoRewind,
  ejectTape, loadFile, tapePrev, tapeNext, applyDisplaySettings,
} from '@/emulator.ts';
import { tapeAutoRewind, tapeCollapseBlocks, setTapeCollapseBlocks, tapeInstantLoad, setTapeInstantLoad, tapeTurbo, setTapeTurbo } from '@/store/settings.ts';
import { persistSetting } from '@/store/settings.ts';
import type { TapeBlock, DataBlock } from '@/tape/tap.ts';

const HEADER_TYPES: Record<number, string> = { 0: 'Program', 1: 'Number array', 2: 'Character array', 3: 'Bytes' };

function sourceTag(block: DataBlock): string {
  if (block.source === 'standard') return ' [STD]';
  if (block.source === 'turbo') return ' [TURBO]';
  if (block.source === 'pure-data') return ' [PURE]';
  return '';
}

function dataTimingDetail(block: DataBlock): string {
  const parts: string[] = [`pause=${block.pause}ms`];
  if (block.pilotCount > 0) parts.push(`pilot=${block.pilotPulse}T x${block.pilotCount}`);
  if (block.syncPulse1 > 0) parts.push(`sync=${block.syncPulse1}/${block.syncPulse2}T`);
  parts.push(`bit=${block.bit0Pulse}/${block.bit1Pulse}T`);
  if (block.usedBits !== 8) parts.push(`used=${block.usedBits}bits`);
  return parts.join(' ');
}

function parseTapeBlockMeta(block: TapeBlock, index: number, blocks: TapeBlock[], collapseBlocks: boolean): { line: string; detail: string; hidden: boolean; control: boolean } {
  switch (block.kind) {
    case 'data': {
      const tag = sourceTag(block);
      const timing = block.source !== 'tap' ? dataTimingDetail(block) : '';
      if (block.source !== 'pure-data' && block.flag === 0x00 && block.data.length >= 15) {
        const typeId = block.data[0];
        const typeName = HEADER_TYPES[typeId] ?? `Type ${typeId}`;
        let filename = '';
        for (let i = 1; i <= 10; i++) filename += String.fromCharCode(block.data[i]);
        const dataLen = block.data[11] | (block.data[12] << 8);
        const param1 = block.data[13] | (block.data[14] << 8);
        const nextBlock = blocks[index + 1];
        const hasMatchingData = nextBlock && nextBlock.kind === 'data' && nextBlock.flag === 0xFF && nextBlock.data.length === dataLen;
        let displayType = typeName;
        if (hasMatchingData && collapseBlocks) {
          if (typeId === 0) displayType = 'PROGRAM';
          else if (typeId === 3) displayType = (dataLen === 6912 && param1 === 16384) ? 'SCREEN$' : 'CODE';
        }
        const line = (hasMatchingData && collapseBlocks)
          ? `${index}: ${displayType} "${filename.trimEnd()}"${tag}`
          : `${index}: Header "${filename.trimEnd()}"${tag}`;
        let detail = `${typeName} ${dataLen} bytes`;
        if (typeId === 0 && param1 < 10000) detail += ` LINE ${param1}`;
        else if (typeId === 3) detail += ` @ ${param1}`;
        if (timing) detail += `\n${timing}`;
        return { line, detail, hidden: false, control: false };
      }
      if (collapseBlocks) {
        const prevBlock = blocks[index - 1];
        if (prevBlock && prevBlock.kind === 'data' && prevBlock.flag === 0x00 && prevBlock.data.length >= 15) {
          const headerDataLen = prevBlock.data[11] | (prevBlock.data[12] << 8);
          if (block.data.length === headerDataLen) return { line: '', detail: '', hidden: true, control: false };
        }
      }
      const size = block.data.length;
      let detail = ''; if (timing) detail = timing;
      return { line: `${index}: Data ${size} bytes${tag}`, detail, hidden: false, control: false };
    }
    case 'tone': return { line: `${index}: Pure Tone`, detail: `${block.pulseLen}T × ${block.count} pulses`, hidden: false, control: true };
    case 'pulses': return { line: `${index}: Pulse Sequence`, detail: `${block.lengths.length} pulses`, hidden: false, control: true };
    case 'direct': return { line: `${index}: Direct Recording`, detail: `${block.tStatesPerSample}T/sample, ${block.data.length} bytes, pause=${block.pause}ms`, hidden: false, control: true };
    case 'pause': return { line: block.duration === 0 ? `${index}: Stop the tape` : `${index}: Pause ${block.duration}ms`, detail: '', hidden: false, control: true };
    case 'set-level': return { line: `${index}: Set Level ${block.level}`, detail: '', hidden: false, control: true };
    case 'stop-if-48k': return { line: `${index}: Stop if 48K`, detail: '', hidden: false, control: true };
    case 'group-start': return { line: `${index}: ▸ ${block.name}`, detail: '', hidden: false, control: true };
    case 'group-end': return { line: '', detail: '', hidden: true, control: true };
    case 'text': return { line: `${index}: ${block.text}`, detail: '', hidden: false, control: true };
    case 'archive-info': return { line: `${index}: Archive Info`, detail: block.entries.map(e => e.text).join(', '), hidden: false, control: true };
  }
}

export function TapePane() {
  let containerRef!: HTMLDivElement;
  let fileInputRef!: HTMLInputElement;

  // Auto-scroll current block into view
  createEffect(() => {
    tapePosition(); // track
    if (!containerRef) return;
    const current = containerRef.querySelector('.tape-block.current') as HTMLElement;
    if (current) current.scrollIntoView({ block: 'nearest' });
  });

  return (
    <Pane id="tape-panel" label="Tape" mono>
      <div id="tape-controls">
        <button title="Rewind" onClick={tapeRewind}><HiOutlineBackward /></button>
        <button title="Previous block" onClick={tapePrev}><HiOutlineChevronLeft /></button>
        <button
          title={tapePlaying() ? 'Stop' : 'Play'}
          class={tapePlaying() ? 'active' : ''}
          onClick={tapeTogglePlay}
        >{tapePlaying() ? <HiOutlineStop /> : <HiOutlinePlay />}</button>
        <button
          title="Pause"
          class={tapePaused() ? 'active' : ''}
          onClick={tapeTogglePause}
        ><HiOutlinePause /></button>
        <button title="Next block" onClick={tapeNext}><HiOutlineChevronRight /></button>
        <DropDownMenuButton
          icon={<HiOutlineEllipsisVertical />}
          title="Tape options"
          items={[
            { value: 'instant-load', label: 'Instant ROM loaders', checked: tapeInstantLoad() },
            { value: 'tape-turbo', label: 'Accelerate custom loaders', checked: tapeTurbo() },
            { value: 'auto-rewind', label: 'Auto-rewind', checked: tapeAutoRewind() },
            { value: 'collapse-blocks', label: 'Collapse matching blocks', checked: tapeCollapseBlocks() },
          ]}
          onSelect={(value) => {
            if (value === 'instant-load') {
              setTapeInstantLoad(!tapeInstantLoad());
              persistSetting('tape-instant-load', tapeInstantLoad() ? 'on' : 'off');
              applyDisplaySettings();
            } else if (value === 'tape-turbo') {
              setTapeTurbo(!tapeTurbo());
              persistSetting('tape-turbo', tapeTurbo() ? 'on' : 'off');
              applyDisplaySettings();
            } else if (value === 'auto-rewind') {
              toggleAutoRewind();
            } else if (value === 'collapse-blocks') {
              setTapeCollapseBlocks(!tapeCollapseBlocks());
              persistSetting('tape-collapse-blocks', tapeCollapseBlocks() ? 'on' : 'off');
            }
          }}
        />
        <input
          type="file"
          ref={fileInputRef}
          accept=".tap,.tzx,.zip"
          style="display:none"
          onChange={async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const data = new Uint8Array(await file.arrayBuffer());
            await loadFile(data, file.name);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      </div>
      <div 
        id="tape-name" 
        classList={{ 'tape-name-clickable': !tapeLoaded() }}
        onClick={() => !tapeLoaded() && fileInputRef?.click()}
      >
        <span class="tape-label">T:</span>
        <span class="tape-name-text" title={tapeLoaded() ? tapeName() : ''}>
          {tapeLoaded() ? tapeName() : 'No tape inserted'}
        </span>
        <Show when={tapeLoaded()}>
          <button class="tape-eject" title="Eject tape" onClick={(e) => { e.stopPropagation(); ejectTape(); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 2L2 10h12L8 2zM2 12v2h12v-2H2z"/>
            </svg>
          </button>
        </Show>
      </div>
      <Show when={tapeLoaded()}>
        <div id="tape-blocks" class="mono-block" ref={containerRef}>
          {tapeBlocks().map((block, i) => {
            const meta = parseTapeBlockMeta(block, i, tapeBlocks(), tapeCollapseBlocks());
            if (meta.hidden) return null;
            const className = `tape-block${i < tapePosition() ? ' played' : ''}${i === tapePosition() ? ' current' : ''}${meta.control ? ' control' : ''}`;
            return (
              <div class={className} onClick={() => tapeSetPosition(i)}>
                {meta.line}
                {meta.detail && meta.detail.split('\n').map((line) => (
                  <div class="tb-detail">{line}</div>
                ))}
              </div>
            );
          })}
        </div>
      </Show>
    </Pane>
  );
}
