import { signal } from '@preact/signals';
import { Pane } from '../Pane.tsx';
import { spectrum } from '../../store/emulator.ts';

const monitoring = signal(false);
const logLines = signal<string[]>([]);
const floatingBusCount = signal(0);
const contentionProbeCount = signal(0);

let pollTimer = 0;

function poll() {
  if (!spectrum) return;
  const newLines = spectrum.contentionLog.splice(0, spectrum.contentionLog.length);
  if (newLines.length > 0) {
    // Keep last 200 lines
    const all = logLines.value.concat(newLines);
    logLines.value = all.length > 200 ? all.slice(-200) : all;
  }
  floatingBusCount.value = spectrum.contentionFloatingBusReads;
  contentionProbeCount.value = spectrum.contentionProbes;
}

function toggle() {
  if (!spectrum) return;
  if (monitoring.value) {
    spectrum.stopContentionMonitor();
    monitoring.value = false;
    clearInterval(pollTimer);
    pollTimer = 0;
  } else {
    logLines.value = [];
    spectrum.startContentionMonitor();
    monitoring.value = true;
    pollTimer = window.setInterval(poll, 200);
  }
}

export function DeveloperPane() {
  const active = monitoring.value;

  return (
    <Pane id="developer-panel" label="Developer" mono>
      <div class="dev-controls">
        <button onClick={toggle} class={active ? 'active' : ''}>
          {active ? 'Stop' : 'Start'} contention monitor
        </button>
        {active && (
          <span class="dev-stats">
            fBus: {floatingBusCount.value} | cProbe: {contentionProbeCount.value}
          </span>
        )}
      </div>
      {logLines.value.length > 0 && (
        <pre class="dev-log">{logLines.value.join('\n')}</pre>
      )}
    </Pane>
  );
}
