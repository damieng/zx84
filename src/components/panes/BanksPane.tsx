import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { banksHtml, currentModel } from '@/emulator.ts';
import { is128kClass } from '@/spectrum.ts';

export function BanksPane() {
  return (
    <Pane id="banks-panel" label="Memory Layout" mono visible={is128kClass(currentModel())}>
      <RawHtml id="banks-output" html={banksHtml} />
    </Pane>
  );
}
