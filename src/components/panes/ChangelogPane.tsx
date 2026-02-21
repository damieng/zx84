import { Pane } from '@/components/Pane.tsx';

const CHANGELOG: { version: string; items: string[] }[] = [
  {
    version: '0.2.0',
    items: [
      'Multiface 1 / 128 / 3 support',
      'Rewritten display engine for border effects',
      'Full-size border rendering',
      'ULA contention timing accuracy (48K, 128K, +2A/+3)',
      'Text/OCR screen overlay with custom fonts',
      'Improved tape auto-start/pause',
      'Improved drive pane with drive-specific menus',
      'Save DSK support for +2A/+3',
      'New disk/format support for +2A/+3'
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
