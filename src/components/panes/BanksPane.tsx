import { Pane } from '@/components/Pane.tsx';
import { banksHtml, currentModel } from '@/emulator.ts';
import { is128kClass } from '@/spectrum.ts';

export function BanksPane() {
  return (
    <Pane id="banks-panel" label="Memory Layout" mono visible={is128kClass(currentModel.value)}>
      <pre id="banks-output" dangerouslySetInnerHTML={{ __html: banksHtml.value }} />
    </Pane>
  );
}
