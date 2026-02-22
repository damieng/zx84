import { Pane } from '@/components/Pane.tsx';

const CHANGELOG: { version: string; items: string[] }[] = [
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
      'Rewritten display engine for border effects',
      'ULA contention accuracy improvements',
      'SZX saving implemented/fixed',
      'Frame stepping in debugger added',
      'Text overlay with native fonts rewritten',
      'Tape auto-start/pause improvements',
      'Per-drive menus with New disk, save',
      'New 3.5" drive sounds & write-protect',
    ],
  },
];

export function ChangelogPane() {
  return (
    <Pane id="changelog-panel" label="Changelog">
      {CHANGELOG.map((release) => (
        <div class="changelog-release">
          <div class="changelog-version">v{release.version}</div>
          <ul class="changelog-list">
            {release.items.map((item) => <li>{item}</li>)}
          </ul>
        </div>
      ))}
    </Pane>
  );
}
