/**
 * Modal file-selection dialog for ZIP archives containing multiple loadable files.
 * Creates its own DOM overlay — nothing in index.html needed.
 */

/** Show a modal picker for the given filenames. Resolves with the chosen name, or null if cancelled. */
export function showFilePicker(filenames: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value: string | null): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    }

    // ── Overlay ──────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '10000',
    } as CSSStyleDeclaration);

    // ── Panel ────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#1a1a2e', border: '1px solid #555', borderRadius: '8px',
      padding: '16px', minWidth: '280px', maxWidth: '420px',
      maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: '10px',
    } as CSSStyleDeclaration);

    const title = document.createElement('div');
    title.textContent = 'Select a file to load';
    Object.assign(title.style, {
      color: '#c0c0ff', fontSize: '1rem', fontWeight: 'bold',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
    } as CSSStyleDeclaration);
    panel.appendChild(title);

    // ── File list ────────────────────────────────────────────────────
    const list = document.createElement('div');
    Object.assign(list.style, {
      overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px',
    } as CSSStyleDeclaration);

    for (const name of filenames) {
      const item = document.createElement('div');
      item.textContent = name;
      Object.assign(item.style, {
        background: '#2a2a3e', color: '#e0e0e0', padding: '8px 12px',
        borderRadius: '4px', cursor: 'pointer',
        fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: '0.85rem',
      } as CSSStyleDeclaration);
      item.addEventListener('mouseenter', () => { item.style.background = '#3a3a5e'; });
      item.addEventListener('mouseleave', () => { item.style.background = '#2a2a3e'; });
      item.addEventListener('click', () => finish(name));
      list.appendChild(item);
    }
    panel.appendChild(list);

    // ── Cancel button ────────────────────────────────────────────────
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, {
      padding: '6px 14px', border: '1px solid #555', borderRadius: '4px',
      background: '#2a2a3e', color: '#e0e0e0', fontSize: '0.85rem',
      cursor: 'pointer', alignSelf: 'flex-end',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
    } as CSSStyleDeclaration);
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = '#3a3a5e'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = '#2a2a3e'; });
    cancelBtn.addEventListener('click', () => finish(null));
    panel.appendChild(cancelBtn);

    overlay.appendChild(panel);

    // ── Dismiss via overlay click / Escape ────────────────────────────
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // ── Cleanup ──────────────────────────────────────────────────────
    function cleanup(): void {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    }

    document.body.appendChild(overlay);
  });
}
