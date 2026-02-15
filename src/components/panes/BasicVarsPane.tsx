import { Pane } from '../Pane.tsx';
import { basicVarsHtml } from '../../store/emulator.ts';

export function BasicVarsPane() {
  return (
    <Pane id="basic-vars-panel" label="BASIC Variables" mono>
      <pre id="basic-vars-output" dangerouslySetInnerHTML={{ __html: basicVarsHtml.value }} />
    </Pane>
  );
}
