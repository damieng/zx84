/**
 * System variables display.
 * Builds DOM once, updates text nodes directly via sysvarRev signal.
 * Zero DOM churn, cached previous values to skip unchanged writes.
 */

import { createEffect, onCleanup } from 'solid-js';
import { spectrum, sysvarRev, currentModel } from '@/emulator.ts';
import { is128kClass, isPlus2AClass } from '@/spectrum.ts';
import { HEX8, HEX16 } from '@/utils/hex.ts';

/** Sysvar row definition */
interface SysVarDef {
  name: string;
  tip: string;
  addr: number;
  width: 8 | 16 | 'pair' | 'char';
}

// Row pairs: left sysvar, right sysvar
const BASE_ROWS: [SysVarDef, SysVarDef][] = [
  [{ name: 'ERR_NR',  tip: '1 less than error report code', addr: 0x5C3A, width: 8 },
   { name: 'FLAGS',   tip: 'Various flags to control the BASIC system', addr: 0x5C3B, width: 8 }],
  [{ name: 'FLAGS2',  tip: 'More flags', addr: 0x5C71, width: 8 },
   { name: 'TV_FLAG', tip: 'Flags associated with the TV', addr: 0x5C3C, width: 8 }],
  [{ name: 'MODE',    tip: 'Current cursor mode: K/L/C/E/G', addr: 0x5C41, width: 8 },
   { name: 'PPC',     tip: 'Line number of statement currently being executed', addr: 0x5C45, width: 16 }],
  [{ name: 'CHARS',   tip: 'Address of character set (256 less than actual)', addr: 0x5C36, width: 16 },
   { name: 'UDG',     tip: 'Address of first user-defined graphic', addr: 0x5C7B, width: 16 }],
  [{ name: 'DF_CC',   tip: 'Address in display file of PRINT position', addr: 0x5C84, width: 16 },
   { name: 'DFCCL',   tip: 'Like DF_CC for lower part of screen', addr: 0x5C86, width: 16 }],
  [{ name: 'S_POSN',  tip: 'Column and line number for PRINT position', addr: 0x5C88, width: 'pair' },
   { name: 'ATTR_P',  tip: 'Permanent current colours (as set by INK, PAPER etc.)', addr: 0x5C8D, width: 8 }],
  [{ name: 'ATTR_T',  tip: 'Temporary current colours (as used by PRINT items)', addr: 0x5C8F, width: 8 },
   { name: 'BORDCR',  tip: 'Border colour * 8; also attributes for lower screen', addr: 0x5C48, width: 8 }],
  [{ name: 'CHANS',   tip: 'Address of channel data area', addr: 0x5C4F, width: 16 },
   { name: 'CURCHL',  tip: 'Address of currently selected channel information', addr: 0x5C51, width: 16 }],
  [{ name: 'PROG',    tip: 'Address of BASIC program', addr: 0x5C53, width: 16 },
   { name: 'VARS',    tip: 'Address of variables area', addr: 0x5C4B, width: 16 }],
  [{ name: 'E_LINE',  tip: 'Address of command being typed in', addr: 0x5C59, width: 16 },
   { name: 'STKEND',  tip: 'Address of start of spare space (end of calculator stack)', addr: 0x5C65, width: 16 }],
  [{ name: 'RAMTOP',  tip: 'Address of last byte of BASIC system area', addr: 0x5CB2, width: 16 },
   { name: 'P_RAMT',  tip: 'Address of last byte of physical RAM', addr: 0x5CB4, width: 16 }],
  [{ name: 'DF_SZ',   tip: 'Number of lines in lower part of screen', addr: 0x5C6B, width: 8 },
   { name: 'SCR_CT',  tip: 'Scroll count \u2014 number of scrolls before "scroll?" message', addr: 0x5C8C, width: 8 }],
];

const ROWS_128K: [SysVarDef, SysVarDef][] = [
  [{ name: 'BANKM',  tip: 'Copy of port 7FFD (paging control)', addr: 0x5B5C, width: 8 },
   { name: 'BAUD',   tip: 'RS232 bit period in T-states/26', addr: 0x5B5F, width: 16 }],
  [{ name: 'SERFL',  tip: 'RS232 second-char-received flag and data', addr: 0x5B61, width: 'pair' },
   { name: 'COL',    tip: 'Current column from 1 to WIDTH', addr: 0x5B63, width: 8 }],
  [{ name: 'WIDTH',  tip: 'Paper column width (default 80)', addr: 0x5B64, width: 8 },
   { name: 'TVPARS', tip: 'Number of inline RS232 parameters expected', addr: 0x5B65, width: 8 }],
  [{ name: 'FLAGS3', tip: 'Printer/device flags (bit 3: RS232, bit 4: disk)', addr: 0x5B66, width: 8 },
   { name: 'OLDSP',  tip: 'Old stack pointer when TSTACK in use', addr: 0x5B6A, width: 16 }],
];

const ROWS_PLUS2A: [SysVarDef, SysVarDef][] = [
  [{ name: 'BNK678', tip: 'Copy of port 1FFD (ext. paging, disk motor, strobe)', addr: 0x5B67, width: 8 },
   { name: 'LODDRV', tip: 'Default device for LOAD/VERIFY/MERGE', addr: 0x5B79, width: 'char' }],
  [{ name: 'SAVDRV', tip: 'Default device for SAVE', addr: 0x5B7A, width: 'char' },
   { name: 'DUMPLF', tip: 'Line feed units for COPY EXP (normally 9)', addr: 0x5B7B, width: 8 }],
];

interface SlotInfo {
  node: Text;
  def: SysVarDef;
  prev: number;
}

function makeLabelEl(name: string, tip: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'reg-name';
  el.dataset.tip = tip;
  el.textContent = name;
  return el;
}

function padName(name: string): string {
  return name.length < 7 ? name + ' '.repeat(7 - name.length) : name;
}

function readVal(mem: Uint8Array, def: SysVarDef): { num: number; str: string } {
  const a = def.addr;
  if (def.width === 16) {
    const v = mem[a] | (mem[a + 1] << 8);
    return { num: v, str: '  ' + HEX16[v] };
  } else if (def.width === 'pair') {
    const v = (mem[a] << 8) | mem[a + 1];
    return { num: v, str: ' ' + HEX8[mem[a]] + ',' + HEX8[mem[a + 1]] };
  } else if (def.width === 'char') {
    const v = mem[a] || 0x54;
    return { num: v, str: '     ' + String.fromCharCode(v) };
  } else {
    return { num: mem[a], str: '    ' + HEX8[mem[a]] };
  }
}

function buildRow(pre: HTMLElement, left: SysVarDef, right: SysVarDef): [SlotInfo, SlotInfo] {
  const t = (s: string) => document.createTextNode(s);
  const lSlot = document.createTextNode('');
  const rSlot = document.createTextNode('');

  pre.append(
    makeLabelEl(padName(left.name), left.tip), t(' '), lSlot,
    t('       '),
    makeLabelEl(padName(right.name), right.tip), t('  '), rSlot,
    t('\n'),
  );

  return [
    { node: lSlot, def: left, prev: -1 },
    { node: rSlot, def: right, prev: -1 },
  ];
}

export function SysVars() {
  let ref!: HTMLPreElement;

  // Rebuild DOM when model changes
  createEffect(() => {
    const model = currentModel(); // track
    const pre = ref;
    if (!pre) return;
    pre.textContent = ''; // clear previous content

    const is128k = is128kClass(model);
    const isPlus2A = isPlus2AClass(model);

    // Build all rows
    const allRows = [...BASE_ROWS];
    if (is128k) allRows.push(...ROWS_128K);
    if (isPlus2A) allRows.push(...ROWS_PLUS2A);

    const slots: SlotInfo[] = [];
    for (const [left, right] of allRows) {
      const [l, r] = buildRow(pre, left, right);
      slots.push(l, r);
    }
    // Remove trailing newline
    if (pre.lastChild) pre.removeChild(pre.lastChild);

    createEffect(() => {
      sysvarRev(); // track
      const mem = spectrum?.memory.snapshot();
      if (!mem) return;
      for (const slot of slots) {
        const { num, str } = readVal(mem, slot.def);
        if (num !== slot.prev) {
          slot.node.data = str;
          slot.prev = num;
        }
      }
    });

    onCleanup(() => {
      pre.textContent = '';
    });
  });

  return <pre id="sysvar-output" ref={ref} />;
}
