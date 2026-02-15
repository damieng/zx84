import { createSignal, onMount, onCleanup } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';

const [memoryUsage, setMemoryUsage] = createSignal('');
const [errorCount, setErrorCount] = createSignal(0);

// Intercept console.error
const _origError = console.error;
console.error = function (...args: unknown[]) {
  setErrorCount(v => v + 1);
  _origError.apply(console, args);
};

// Also catch unhandled errors
window.addEventListener('error', () => { setErrorCount(v => v + 1); });
window.addEventListener('unhandledrejection', () => { setErrorCount(v => v + 1); });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateMemory(): void {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
  if (perf.memory) {
    const m = perf.memory;
    setMemoryUsage(`${formatBytes(m.usedJSHeapSize)} / ${formatBytes(m.totalJSHeapSize)}`);
  } else {
    setMemoryUsage('N/A');
  }
}

export function DevPane() {
  onMount(() => {
    updateMemory();
    const id = setInterval(updateMemory, 2000);
    onCleanup(() => clearInterval(id));
  });

  return (
    <Pane id="dev-panel" label="Developer">
      <div class="dev-row">
        <span class="dev-label">Heap</span>
        <span class="dev-value">{memoryUsage()}</span>
      </div>
      <div class={`dev-row${errorCount() > 0 ? ' dev-errors-active' : ''}`}>
        <span class="dev-label">Errors</span>
        <span class="dev-value">{errorCount()}</span>
      </div>
    </Pane>
  );
}
