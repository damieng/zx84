/**
 * CPU register & flag display.
 * Builds the DOM once, then updates text nodes directly via createEffect.
 * Solid never re-renders this component after mount — zero DOM churn.
 */

import { createEffect, onMount, onCleanup } from 'solid-js';
import { spectrum, regsRev } from '@/emulator.ts';
import { Z80 } from '@/cores/z80.ts';
import { HEX8, HEX16 } from '@/utils/hex.ts';

/** Update text node only if numeric value changed; returns new prev */
function set16(node: Text, val: number, prev: number): number {
  if (val !== prev) node.data = HEX16[val];
  return val;
}
function set8x2(node: Text, hi: number, lo: number, prev: number): number {
  const val = (hi << 8) | lo;
  if (val !== prev) node.data = HEX8[hi] + HEX8[lo];
  return val;
}
function setStr(node: Text, val: string, prev: string): string {
  if (val !== prev) node.data = val;
  return val;
}

/** Create a <span class="reg-name" data-tip="...">label</span> */
function makeLabel(label: string, tip: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'reg-name';
  el.dataset.tip = tip;
  el.textContent = label;
  return el;
}

/** Create a text node we'll update each frame */
function makeSlot(): Text {
  return document.createTextNode('');
}

/** Create a flag span: check/unchecked + label */
function makeFlag(label: string, tip: string): { el: HTMLSpanElement; update: (f: number, mask: number) => void } {
  const el = document.createElement('span');
  el.dataset.tip = tip;
  const txt = document.createTextNode('');
  el.appendChild(txt);
  let prevOn: boolean | null = null;
  return {
    el,
    update(f: number, mask: number) {
      const on = (f & mask) !== 0;
      if (on === prevOn) return;
      prevOn = on;
      el.className = on ? 'flag-on' : 'flag-off';
      txt.data = on ? `\u2611 ${label}` : `\u2610 ${label}`;
    },
  };
}

export function Registers() {
  let ref!: HTMLPreElement;

  onMount(() => {
    const pre = ref;

    // Build DOM structure once
    const s = {
      af: makeSlot(), af_: makeSlot(), bc: makeSlot(), bc_: makeSlot(),
      de: makeSlot(), de_: makeSlot(), hl: makeSlot(), hl_: makeSlot(),
      ix: makeSlot(), iy: makeSlot(), sp: makeSlot(), pc: makeSlot(),
      ir: makeSlot(), tpf: makeSlot(), iff: makeSlot(), im: makeSlot(), halt: makeSlot(),
      fSign: makeFlag('Sign', 'Set if result is negative (bit 7 of result)'),
      fZero: makeFlag('Zero', 'Set if result is zero'),
      fHalf: makeFlag('Half', 'Half-carry: set on carry from bit 3 to bit 4'),
      fPrty: makeFlag('Prty', 'Parity/Overflow: set on even parity or arithmetic overflow'),
      fSubt: makeFlag('Subt', 'Subtract: set if last operation was a subtraction'),
      fCrry: makeFlag('Crry', 'Carry: set on carry from bit 7 or borrow'),
    };

    const t = (str: string) => document.createTextNode(str);

    // Row 1: AF  xxxx  AF' xxxx   Sign Zero
    pre.append(
      makeLabel('AF', 'Accumulator and Flags'), t('  '), s.af, t('  '),
      makeLabel("AF'", 'Shadow Accumulator and Flags'), t(' '), s.af_, t('   '),
      s.fSign.el, t(' '), s.fZero.el, t('\n'),
    );
    // Row 2: BC  xxxx  BC' xxxx   Half Prty
    pre.append(
      makeLabel('BC', 'General-purpose register pair B and C'), t('  '), s.bc, t('  '),
      makeLabel("BC'", 'Shadow BC'), t(' '), s.bc_, t('   '),
      s.fHalf.el, t(' '), s.fPrty.el, t('\n'),
    );
    // Row 3: DE  xxxx  DE' xxxx   Subt Crry
    pre.append(
      makeLabel('DE', 'General-purpose register pair D and E'), t('  '), s.de, t('  '),
      makeLabel("DE'", 'Shadow DE'), t(' '), s.de_, t('   '),
      s.fSubt.el, t(' '), s.fCrry.el, t('\n'),
    );
    // Row 4: HL  xxxx  HL' xxxx   T\F nnn
    pre.append(
      makeLabel('HL', 'General-purpose register pair H and L'), t('  '), s.hl, t('  '),
      makeLabel("HL'", 'Shadow HL'), t(' '), s.hl_, t('   '),
      makeLabel('T/F', 'T-states per frame'), t(' '), s.tpf, t('\n'),
    );
    // Row 5: IX  xxxx  IY  xxxx   EI  IMn HALT
    pre.append(
      makeLabel('IX', 'Index register X'), t('  '), s.ix, t('  '),
      makeLabel('IY', 'Index register Y'), t('  '), s.iy, t('   '),
      s.iff, t('  '), makeLabel('IM', 'Interrupt mode'), s.im, s.halt, t('\n'),
    );
    // Row 6: SP  xxxx  PC  xxxx   IR  xxxx
    pre.append(
      makeLabel('SP', 'Stack pointer'), t('  '), s.sp, t('  '),
      makeLabel('PC', 'Program counter'), t('  '), s.pc, t('   '),
      makeLabel('IR', 'Interrupt vector + Refresh counter'), t('  '), s.ir,
    );

    // Previous values — skip DOM writes when unchanged
    let pAF = -1, pAF_ = -1, pBC = -1, pBC_ = -1, pDE = -1, pDE_ = -1;
    let pHL = -1, pHL_ = -1, pIX = -1, pIY = -1, pSP = -1, pPC = -1;
    let pIR = -1, pTPF = '', pIFF = '', pIM = '', pHALT = '';

    createEffect(() => {
      regsRev(); // track the signal
      const cpu = spectrum?.cpu;
      if (!cpu) return;
      pAF = set16(s.af, cpu.af, pAF);
      pAF_ = set16(s.af_, (cpu.a_ << 8) | cpu.f_, pAF_);
      pBC = set16(s.bc, cpu.bc, pBC);
      pBC_ = set16(s.bc_, (cpu.b_ << 8) | cpu.c_, pBC_);
      pDE = set16(s.de, cpu.de, pDE);
      pDE_ = set16(s.de_, (cpu.d_ << 8) | cpu.e_, pDE_);
      pHL = set16(s.hl, cpu.hl, pHL);
      pHL_ = set16(s.hl_, (cpu.h_ << 8) | cpu.l_, pHL_);
      pIX = set16(s.ix, cpu.ix, pIX);
      pIY = set16(s.iy, cpu.iy, pIY);
      pSP = set16(s.sp, cpu.sp, pSP);
      pPC = set16(s.pc, cpu.pc, pPC);
      pIR = set8x2(s.ir, cpu.i, cpu.r, pIR);
      const tpf = spectrum!.tStatesPerFrame.toLocaleString();
      pTPF = setStr(s.tpf, tpf, pTPF);
      pIFF = setStr(s.iff, cpu.iff1 ? 'EI' : 'DI', pIFF);
      pIM = setStr(s.im, String(cpu.im), pIM);
      pHALT = setStr(s.halt, cpu.halted ? ' HALT' : '', pHALT);
      const f = cpu.f;
      s.fSign.update(f, Z80.FLAG_S);
      s.fZero.update(f, Z80.FLAG_Z);
      s.fHalf.update(f, Z80.FLAG_H);
      s.fPrty.update(f, Z80.FLAG_PV);
      s.fSubt.update(f, Z80.FLAG_N);
      s.fCrry.update(f, Z80.FLAG_C);
    });

    onCleanup(() => {
      pre.textContent = '';
    });
  });

  return <pre id="regs-output" ref={ref} />;
}
