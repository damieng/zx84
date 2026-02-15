import { Pane } from '../Pane.tsx';
import { basicHtml } from '../../store/emulator.ts';

export function BasicPane() {
  return (
    <Pane id="basic-panel" label="BASIC Listing" mono>
      <pre id="basic-output" dangerouslySetInnerHTML={{ __html: basicHtml.value }} />
    </Pane>
  );
}
