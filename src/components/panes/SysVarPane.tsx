import { Pane } from '@/components/Pane.tsx';
import { SysVars } from '@/components/SysVars.tsx';

export function SysVarPane() {
  return (
    <Pane id="sysvar-panel" label="System Variables" mono>
      <SysVars />
    </Pane>
  );
}
