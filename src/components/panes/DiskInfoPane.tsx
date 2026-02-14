import { Pane } from '../Pane.tsx';
import { diskInfoHtml, currentModel, currentDiskInfo } from '../../store/emulator.ts';
import { isPlus3 } from '../../spectrum.ts';

export function DiskInfoPane() {
  return (
    <Pane id="disk-info-panel" label="Disk" mono visible={isPlus3(currentModel.value) && !!currentDiskInfo}>
      <pre id="disk-info-output" dangerouslySetInnerHTML={{ __html: diskInfoHtml.value }} />
    </Pane>
  );
}
