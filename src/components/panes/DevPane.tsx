import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Pane } from '@/components/Pane.tsx';

const memoryUsage = signal('');
const errorCount = signal(0);

// Intercept console.error
const _origError = console.error;
console.error = function (...args: unknown[]) {
  errorCount.value++;
  _origError.apply(console, args);
};

// Also catch unhandled errors
window.addEventListener('error', () => { errorCount.value++; });
window.addEventListener('unhandledrejection', () => { errorCount.value++; });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateMemory(): void {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
  if (perf.memory) {
    const m = perf.memory;
    memoryUsage.value = `${formatBytes(m.usedJSHeapSize)} / ${formatBytes(m.totalJSHeapSize)}`;
  } else {
    memoryUsage.value = 'N/A';
  }
}

export function DevPane() {
  useEffect(() => {
    updateMemory();
    const id = setInterval(updateMemory, 2000);
    return () => clearInterval(id);
  }, []);

  const errors = errorCount.value;

  return (
    <Pane id="dev-panel" label="Developer">
      <div class="dev-row">
        <span class="dev-label">Heap</span>
        <span class="dev-value">{memoryUsage.value}</span>
      </div>
      <div class="dev-row">
        <span class={`dev-error-tri${errors > 0 ? ' has-errors' : ''}`}>&#9650;</span>
        <span class="dev-value">{errors > 0 ? errors : ''}</span>
      </div>
    </Pane>
  );
}
