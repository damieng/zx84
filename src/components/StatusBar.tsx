/**
 * Status text + 9 activity LEDs.
 */

import {
  statusText, ledKbd, ledKemp, ledEar, ledLoad, ledRst16, ledText,
  ledBeep, ledAy, ledDsk, toggleTranscribeMode, spectrum,
} from '../store/emulator.ts';

function Led({ id, kind, label, on, onClick }: {
  id: string; kind: string; label: string; on: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      id={id}
      class={`led${on ? ' on' : ''}`}
      data-kind={kind}
      onClick={onClick}
      style={onClick ? 'cursor:pointer' : undefined}
      title={onClick ? (kind === 'rst16' ? 'RST 16 capture overlay' : 'Pixel OCR overlay') : undefined}
    >
      <span class="led-dot" />{label}
    </div>
  );
}

export function StatusBar() {
  return (
    <div id="status-bar" class="status-controls">
      <div id="status">{statusText.value}</div>
      <div id="activity">
        <Led id="led-kbd" kind="kbd" label="KBD" on={ledKbd.value} />
        <Led id="led-kemp" kind="kemp" label="KEMP" on={ledKemp.value} />
        <Led id="led-ear" kind="ear" label="EAR" on={ledEar.value} />
        <Led id="led-load" kind="load" label="LOAD" on={ledLoad.value} />
        <Led id="led-rst16" kind="rst16" label="RST16" on={ledRst16.value}
          onClick={() => spectrum && toggleTranscribeMode('rst16')} />
        <Led id="led-text" kind="text" label="TEXT" on={ledText.value}
          onClick={() => spectrum && toggleTranscribeMode('text')} />
        <Led id="led-beep" kind="beep" label="BEEP" on={ledBeep.value} />
        <Led id="led-ay" kind="ay" label="AY-3" on={ledAy.value} />
        <Led id="led-dsk" kind="dsk" label="DISK" on={ledDsk.value} />
      </div>
    </div>
  );
}
