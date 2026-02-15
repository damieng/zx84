import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { basicVarsHtml } from '@/emulator.ts';

export function BasicVarsPane() {
  return (
    <Pane id="basic-vars-panel" label="BASIC Variables" mono>
      <RawHtml id="basic-vars-output" html={basicVarsHtml} />
    </Pane>
  );
}
