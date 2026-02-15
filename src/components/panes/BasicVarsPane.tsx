import { Pane } from '@/components/Pane.tsx';
import { basicVarsHtml } from '@/emulator.ts';

export function BasicVarsPane() {
  return (
    <Pane id="basic-vars-panel" label="BASIC Variables" mono>
      <pre id="basic-vars-output" dangerouslySetInnerHTML={{ __html: basicVarsHtml.value }} />
    </Pane>
  );
}
