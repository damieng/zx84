/**
 * ZX84 - ZX Spectrum Emulator
 * Entry point: render Preact app, HMR dispose.
 */

import { render } from 'preact';
import { App } from './app.tsx';
import { destroy } from './store/emulator.ts';
import './styles.css';

const root = document.getElementById('app')!;
render(<App />, root);

// ── Vite HMR cleanup ─────────────────────────────────────────────────

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
    destroy();
    render(null, root);
  });
  import.meta.hot.accept();
}
