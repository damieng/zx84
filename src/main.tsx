/**
 * ZX84 - ZX Spectrum Emulator
 * Entry point: render Solid app, HMR dispose.
 * Test 2
 */

import { render } from 'solid-js/web';
import { App } from '@/app.tsx';
import { destroy, saveHMRState } from '@/emulator.ts';
import '@/styles.css';

const root = document.getElementById('app')!;
const dispose = render(() => <App />, root);

// ── Vite HMR cleanup ─────────────────────────────────────────────────

// Save state before page unload (for full reloads)
window.addEventListener('beforeunload', () => {
  saveHMRState();
});

if (import.meta.hot) {
  import.meta.hot.on('hmr-freeze', () => {
    const btns = document.getElementById('toolbar-btns');
    if (btns && !btns.querySelector('.hmr-spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'hmr-spinner';
      btns.insertBefore(spinner, btns.firstChild);
    }
  });

  import.meta.hot.on('hmr-thaw', () => {
    document.querySelector('.hmr-spinner')?.remove();
  });

  import.meta.hot.dispose(() => {
    saveHMRState();
    destroy();
    dispose();
  });
  import.meta.hot.accept();
}
