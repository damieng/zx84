import { createSignal, Show } from 'solid-js';

const CHANGELOG: { version: string; items: string[] }[] = [
  {
    version: '0.2.8',
    items: [
      'Held keys no longer get stuck (OS auto-repeat was incrementing reference counts the single keyup could not undo)',
      'Alt-tabbing while a key is held now releases it (window blur resets keyboard and joystick state)',
    ]
  }, {
    version: '0.2.7',
    items: [
      'Flat memory mode for simplified debugging',
      'MCP tooling improvements',
      'FDC bugs fixed: wrong R after EOT, missing ND flag, stale exN on advance',
      'Snapshot bugs fixed: SNA overflow, memory corruption, SP offset, IM mask',
      'MCP disassembler now reads correct memory bank',
      'Disk writing fixes',
    ]
  }, {
    version: '0.2.6',
    items: [
      'Right Shift now maps to Symbol Shift for direct symbol access',
      'Combo keys (DEL, arrows, etc.) stagger modifier by one frame for reliable detection',
    ]
  }, {
    version: '0.2.5',
    items: [
      'VTX5000 modem emulation',
      'Pane drag reordering',
      'ZXTL tracing format',
      'BASIC viewer fix token spaces',
    ]
  }, {
    version: '0.2.4',
    items: [
      '+3 copy protection detection improved',
      '+3 Paul Owens protection bypassed',
      '+3 Hexagon protection bypassed',
      'Drive pane simplification'
    ]
  }, {
    version: '0.2.3',
    items: [
      'ROMs loaded from own domain',
      '+3 v4.1 option added',
      'Turn off minification',
      'CORS improvements for Cloudflare'
    ]
  }, {
    version: '0.2.2',
    items: [
      '128K/+3 memory bank paging fixed',
      'Memory viewer pane added',
      'Drive pane UX improvements including LED',
      'CPC disk format detection fix',
      '+3 B: force-presence when empty option',
      '+3 FORMAT command support',
      'Keyboard shift/ctrl keys stuck/failing fixed',
      '48K timings fixed for Shock, Bifrost and Nirvana+'
    ],
  },
  {
    version: '0.2.1',
    items: [
      'Fractional scaling prevention',
      'Scanline accuracy option',
      'HQx and XBR upscalers added',
      'Keyboard mapping improvements',
      'Hardware Pane reworked',
      'Noise display pattern for that retro vibe',
      'Reset per pane option'
    ]
  },
  {
    version: '0.2.0',
    items: [
      'Multiface 1 / 128 / 3 support',
      'Border effects improved',
      'ULA contention accuracy improvements',
      'SZX saving implemented/fixed',
      'Frame stepping in debugger added',
      'Text overlay with native fonts rewritten',
      'Tape auto-start/pause improvements',
      'Per-drive menus with New disk, save',
      '3.5" drive sounds & write-protect',
    ],
  },
];

const [changelogOpen, setChangelogOpen] = createSignal(false);
export { changelogOpen };

export function toggleChangelog() {
  setChangelogOpen(v => !v);
}

export function ChangelogOverlay() {
  return (
    <Show when={changelogOpen()}>
      <div class="changelog-backdrop" onClick={() => setChangelogOpen(false)} />
      <div class="changelog-overlay">
        {CHANGELOG.map((release) => (
          <div class="changelog-release">
            <div class="changelog-version">v{release.version}</div>
            <ul class="changelog-list">
              {release.items.map((item) => <li>{item}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </Show>
  );
}
