import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { basicHtml } from '@/emulator.ts';

export function BasicPane() {
  return (
    <Pane id="basic-panel" label="BASIC Listing" mono>
      <RawHtml id="basic-output" html={basicHtml} />
    </Pane>
  );
}
