import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { sysvarHtml } from '@/emulator.ts';

export function SysVarPane() {
  return (
    <Pane id="sysvar-panel" label="System Variables" mono>
      <RawHtml id="sysvar-output" html={sysvarHtml} />
    </Pane>
  );
}
