import { useEffect, useRef } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { DropDownMenuButton } from '../DropDownMenuButton.tsx';
import { HiFolderOpen, HiArrowUpTray, HiBackward, HiPlay, HiPause, HiEllipsisVertical } from 'react-icons/hi2';
import {
  tapeLoaded, tapeBlocks, tapePosition, tapePaused,
  tapeRewind, tapeTogglePause, tapeSetPosition, toggleAutoRewind,
  ejectTape, loadFile,
} from '../../store/emulator.ts';
import { tapeAutoRewind, tapeCollapseBlocks } from '../../store/settings.ts';
import { persistSetting } from '../../store/settings.ts';
import type { TapeBlock, DataBlock } from '../../formats/tap.ts';

const HEADER_TYPES: Record<number, string> = {
  0: 'Program',
  1: 'Number array',
  2: 'Character array',
  3: 'Bytes',
};

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

        // Check if next block is matching data
        const nextBlock = blocks[index + 1];
        const hasMatchingData = nextBlock && nextBlock.kind === 'data' && nextBlock.flag === 0xFF && nextBlock.data.length === dataLen;

        let displayType = typeName;
        if (hasMatchingData && collapseBlocks) {
          if (typeId === 0) displayType = 'PROGRAM';
          else if (typeId === 3) {
            displayType = (dataLen === 6912 && param1 === 16384) ? 'SCREEN$' : 'CODE';
          }
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

      // Check if this is a data block following a matching header
      if (collapseBlocks) {
        const prevBlock = blocks[index - 1];
        if (prevBlock && prevBlock.kind === 'data' && prevBlock.flag === 0x00 && prevBlock.data.length >= 15) {
          const headerDataLen = prevBlock.data[11] | (prevBlock.data[12] << 8);
          if (block.data.length === headerDataLen) {
            return { line: '', detail: '', hidden: true, control: false };
          }
        }
      }

      const size = block.data.length;
      let detail = '';
      if (timing) detail = timing;
      return { line: `${index}: Data ${size} bytes${tag}`, detail, hidden: false, control: false };
    }

    case 'tone':
      return { line: `${index}: Pure Tone`, detail: `${block.pulseLen}T × ${block.count} pulses`, hidden: false, control: true };

    case 'pulses':
      return { line: `${index}: Pulse Sequence`, detail: `${block.lengths.length} pulses`, hidden: false, control: true };

    case 'direct':
      return { line: `${index}: Direct Recording`, detail: `${block.tStatesPerSample}T/sample, ${block.data.length} bytes, pause=${block.pause}ms`, hidden: false, control: true };

    case 'pause':
      return {
        line: block.duration === 0 ? `${index}: Stop the tape` : `${index}: Pause ${block.duration}ms`,
        detail: '', hidden: false, control: true,
      };

    case 'set-level':
      return { line: `${index}: Set Level ${block.level}`, detail: '', hidden: false, control: true };

    case 'stop-if-48k':
      return { line: `${index}: Stop if 48K`, detail: '', hidden: false, control: true };

    case 'group-start':
      return { line: `${index}: ▸ ${block.name}`, detail: '', hidden: false, control: true };

    case 'group-end':
      return { line: '', detail: '', hidden: true, control: true };

    case 'text':
      return { line: `${index}: ${block.text}`, detail: '', hidden: false, control: true };

    case 'archive-info':
      return {
        line: `${index}: Archive Info`,
        detail: block.entries.map(e => e.text).join(', '),
        hidden: false, control: true,
      };
  }
}

export function TapePane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blocks = tapeBlocks.value;
  const pos = tapePosition.value;
  const paused = tapePaused.value;
  const loaded = tapeLoaded.value;
  const autoRewind = tapeAutoRewind.value;
  const collapseBlocks = tapeCollapseBlocks.value;

  // Auto-scroll current block into view
  useEffect(() => {
    if (!containerRef.current) return;
    const current = containerRef.current.querySelector('.tape-block.current') as HTMLElement;
    if (current) current.scrollIntoView({ block: 'nearest' });
  }, [pos]);

  return (
    <Pane id="tape-panel" label="Tape" mono>
      <div id="tape-controls">
        <button title="Open tape" onClick={() => fileInputRef.current?.click()}><HiFolderOpen /></button>
        <button title="Eject tape" onClick={ejectTape}><HiArrowUpTray /></button>
        <button title="Rewind" onClick={tapeRewind}><HiBackward /></button>
        <button
          title={paused ? 'Resume' : 'Pause'}
          class={paused ? 'active' : ''}
          onClick={tapeTogglePause}
        >{paused ? <HiPlay /> : <HiPause />}</button>
        <DropDownMenuButton
          icon={<HiEllipsisVertical />}
          title="Tape options"
          items={[
            { value: 'auto-rewind', label: 'Auto-rewind', checked: autoRewind },
            { value: 'collapse-blocks', label: 'Collapse matching blocks', checked: collapseBlocks },
          ]}
          onSelect={(value) => {
            if (value === 'auto-rewind') {
              toggleAutoRewind();
            } else if (value === 'collapse-blocks') {
              tapeCollapseBlocks.value = !tapeCollapseBlocks.value;
              persistSetting('tape-collapse-blocks', tapeCollapseBlocks.value ? 'on' : 'off');
            }
          }}
        />
        <input
          type="file"
          ref={fileInputRef}
          accept=".tap,.tzx"
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
      <div id="tape-blocks" class="mono-block" ref={containerRef}>
        {!loaded ? (
          <div class="tape-empty">No tape loaded</div>
        ) : (
          blocks.map((block, i) => {
            const meta = parseTapeBlockMeta(block, i, blocks, collapseBlocks);
            if (meta.hidden) return null;
            const className = `tape-block${i < pos ? ' played' : ''}${i === pos ? ' current' : ''}${meta.control ? ' control' : ''}`;
            return (
              <div key={i} class={className} onClick={() => tapeSetPosition(i)}>
                {meta.line}
                {meta.detail && meta.detail.split('\n').map((line, j) => (
                  <div key={j} class="tb-detail">{line}</div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </Pane>
  );
}
