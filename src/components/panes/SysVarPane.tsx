import { Pane } from '../Pane.tsx';
import { sysvarHtml } from '../../store/emulator.ts';

export function SysVarPane() {
  return (
    <Pane id="sysvar-panel" label="System" mono>
      <pre id="sysvar-output" dangerouslySetInnerHTML={{ __html: sysvarHtml.value }} />
    </Pane>
  );
}
