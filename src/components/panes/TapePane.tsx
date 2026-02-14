import { useEffect, useRef } from 'preact/hooks';
import { Pane } from '../Pane.tsx';
import { HiBackward, HiPlay, HiPause, HiArrowPath } from 'react-icons/hi2';
import {
  tapeLoaded, tapeBlocks, tapePosition, tapePaused,
  tapeRewind, tapeTogglePause, tapeSetPosition, toggleAutoRewind,
} from '../../store/emulator.ts';
import { tapeAutoRewind } from '../../store/settings.ts';
import type { TAPBlock } from '../../formats/tap.ts';

const HEADER_TYPES: Record<number, string> = {
  0: 'Program',
  1: 'Number array',
  2: 'Character array',
  3: 'Bytes',
};

function tzxTag(block: TAPBlock): string {
  if (!block.tzx) return '';
  const t = block.tzx.type;
  if (t === 'standard') return ' [STD]';
  if (t === 'turbo') return ' [TURBO]';
  if (t === 'pure-data') return ' [PURE]';
  return '';
}

function tzxTimingDetail(block: TAPBlock): string {
  if (!block.tzx) return '';
  const m = block.tzx;
  const parts: string[] = [`pause=${m.pause}ms`];
  if (m.pilotPulse !== undefined) parts.push(`pilot=${m.pilotPulse}T x${m.pilotCount}`);
  if (m.syncPulse1 !== undefined) parts.push(`sync=${m.syncPulse1}/${m.syncPulse2}T`);
  if (m.bit0Pulse !== undefined) parts.push(`bit=${m.bit0Pulse}/${m.bit1Pulse}T`);
  if (m.usedBits !== undefined && m.usedBits !== 8) parts.push(`used=${m.usedBits}bits`);
  return parts.join(' ');
}

function parseTapeBlockMeta(block: TAPBlock, index: number, blocks: TAPBlock[]): { line: string; detail: string; hidden: boolean } {
  const tag = tzxTag(block);
  const timing = tzxTimingDetail(block);

  if (block.flag === 0x00 && block.data.length >= 15) {
    const typeId = block.data[0];
    const typeName = HEADER_TYPES[typeId] ?? `Type ${typeId}`;
    let filename = '';
    for (let i = 1; i <= 10; i++) filename += String.fromCharCode(block.data[i]);
    const dataLen = block.data[11] | (block.data[12] << 8);
    const param1 = block.data[13] | (block.data[14] << 8);

    // Check if next block is matching data
    const nextBlock = blocks[index + 1];
    const hasMatchingData = nextBlock && nextBlock.flag === 0xFF && nextBlock.data.length === dataLen;

    // Determine display type
    let displayType = typeName;
    if (hasMatchingData) {
      if (typeId === 0) {
        displayType = 'PROGRAM';
      } else if (typeId === 3) {
        if (dataLen === 6912 && param1 === 16384) {
          displayType = 'SCREEN$';
        } else {
          displayType = 'CODE';
        }
      }
    }

    const line = hasMatchingData
      ? `${index}: ${displayType} "${filename.trimEnd()}"${tag}`
      : `${index}: Header "${filename.trimEnd()}"${tag}`;
    let detail = `${typeName} ${dataLen} bytes`;
    if (typeId === 0 && param1 < 10000) detail += ` LINE ${param1}`;
    else if (typeId === 3) detail += ` @ ${param1}`;
    if (timing) detail += `\n${timing}`;
    return { line, detail, hidden: false };
  }

  // Check if this is a data block following a matching header
  const prevBlock = blocks[index - 1];
  if (prevBlock && prevBlock.flag === 0x00 && prevBlock.data.length >= 15) {
    const headerDataLen = prevBlock.data[11] | (prevBlock.data[12] << 8);
    if (block.data.length === headerDataLen) {
      // Hide this data block - it's merged with the header
      return { line: '', detail: '', hidden: true };
    }
  }

  const size = block.data.length;
  let detail = '';
  if (timing) detail = timing;
  return { line: `${index}: Data ${size} bytes${tag}`, detail, hidden: false };
}

export function TapePane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const blocks = tapeBlocks.value;
  const pos = tapePosition.value;
  const paused = tapePaused.value;
  const loaded = tapeLoaded.value;

  // Auto-scroll current block into view
  useEffect(() => {
    if (!containerRef.current) return;
    const current = containerRef.current.querySelector('.tape-block.current') as HTMLElement;
    if (current) current.scrollIntoView({ block: 'nearest' });
  }, [pos]);

  return (
    <Pane id="tape-panel" label="Tape" mono>
      <div id="tape-controls">
        <button id="tape-rewind" title="Rewind" onClick={tapeRewind}><HiBackward /></button>
        <button
          id="tape-pause"
          title={paused ? 'Resume' : 'Pause'}
          class={paused ? 'active' : ''}
          onClick={tapeTogglePause}
        >{paused ? <HiPlay /> : <HiPause />}</button>
        <button
          id="tape-auto-rewind"
          title="Auto-rewind when tape ends"
          class={tapeAutoRewind.value ? 'active' : ''}
          onClick={toggleAutoRewind}
        ><HiArrowPath /></button>
      </div>
      <div id="tape-blocks" class="mono-block" ref={containerRef}>
        {!loaded ? (
          <div class="tape-empty">No tape loaded</div>
        ) : (
          blocks.map((block, i) => {
            const meta = parseTapeBlockMeta(block, i, blocks);
            if (meta.hidden) return null;
            const className = `tape-block${i < pos ? ' played' : ''}${i === pos ? ' current' : ''}`;
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
