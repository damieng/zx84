/**
 * Status text + 10 activity LEDs.
 */

import {
  statusText, ledKbd, ledKemp, ledEar, ledLoad, ledRst16, ledText,
  ledBeep, ledAy, ledDsk, ledRainbow, toggleTranscribeMode, spectrum,
} from '@/emulator.ts';

function Led({ id, kind, label, tip, on, onClick }: {
  id: string; kind: string; label: string; tip: string; on: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      id={id}
      class={`led${on ? ' on' : ''}`}
      data-kind={kind}
      onClick={onClick}
      style={onClick ? 'cursor:pointer' : undefined}
      title={tip}
    >
      <span class="led-dot" />{label}
    </div>
  );
}

export function StatusBar() {
  return (
    <div id="status-bar" class="status-controls">
      <div id="activity">
        <Led id="led-kbd" kind="kbd" label="KEYBOARD" on={ledKbd.value}
          tip="Reading the keyboard via the ULA port" />
        <Led id="led-kemp" kind="kemp" label="KEMPSTON" on={ledKemp.value}
          tip="Reading the Kempston joystick port" />
        <Led id="led-ear" kind="ear" label="EAR" on={ledEar.value}
          tip="Sampling the EAR port (tape playback)" />
        <Led id="led-load" kind="load" label="LOAD" on={ledLoad.value}
          tip="ROM tape-load routine is active (LD-BYTES at 0556h)" />
        <Led id="led-rst16" kind="rst16" label="RST16" on={ledRst16.value}
          tip="RST 16 character output — click to toggle capture overlay"
          onClick={() => spectrum && toggleTranscribeMode('rst16')} />
        <Led id="led-text" kind="text" label="TEXT" on={ledText.value}
          tip="Pixel-based screen OCR — click to toggle overlay"
          onClick={() => spectrum && toggleTranscribeMode('text')} />
        <Led id="led-beep" kind="beep" label="BEEPER" on={ledBeep.value}
          tip="Beeper bit is toggling (producing sound)" />
        <Led id="led-ay" kind="ay" label="AY-3-8912" on={ledAy.value}
          tip="Writing to the AY sound chip registers" />
        <Led id="led-dsk" kind="dsk" label="DISK" on={ledDsk.value}
          tip="Floppy disk controller is being accessed" />
        <Led id="led-rainbow" kind="rainbow" label="RAINBOW" on={ledRainbow.value}
          tip="Attribute area is being rewritten mid-frame (rainbow/colour-cycling effect)" />
      </div>
      <div id="status">{statusText.value}</div>
    </div>
  );
}
