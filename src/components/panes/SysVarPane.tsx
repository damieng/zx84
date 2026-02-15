import { Pane } from '@/components/Pane.tsx';
import { sysvarHtml } from '@/emulator.ts';

export function SysVarPane() {
  return (
    <Pane id="sysvar-panel" label="System Variables" mono>
      <pre id="sysvar-output" dangerouslySetInnerHTML={{ __html: sysvarHtml.value }} />
    </Pane>
  );
}
