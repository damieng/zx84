/**
 * Status text + 10 activity LEDs.
 */

import {
  statusText, ledKbd, ledKemp, ledEar, ledLoad, ledRst16, ledText,
  ledBeep, ledAy, ledDsk, ledRainbow, ledMouse, toggleTranscribeMode, spectrum,
} from '@/emulator.ts';

function Led(props: {
  id: string; kind: string; label: string; tip: string; on: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      id={props.id}
      class={`led${props.on ? ' on' : ''}`}
      data-kind={props.kind}
      onClick={props.onClick}
      style={props.onClick ? 'cursor:pointer' : undefined}
      title={props.tip}
    >
      <span class="led-dot" />{props.label}
    </div>
  );
}

export function StatusBar() {
  return (
    <div id="status-bar" class="status-controls">
      <div id="activity">
        <Led id="led-kbd" kind="kbd" label="KEYBOARD" on={ledKbd()}
          tip="Reading the keyboard via the ULA port" />
        <Led id="led-kemp" kind="kemp" label="KEMPSTON" on={ledKemp()}
          tip="Reading the Kempston joystick port" />
        <Led id="led-mouse" kind="mouse" label="MOUSE" on={ledMouse()}
          tip="Reading the Kempston mouse ports" />
        <Led id="led-ear" kind="ear" label="EAR" on={ledEar()}
          tip="Sampling the EAR port (tape playback)" />
        <Led id="led-load" kind="load" label="LOAD" on={ledLoad()}
          tip="ROM tape-load routine is active (LD-BYTES at 0556h)" />
        <Led id="led-rst16" kind="rst16" label="RST16" on={ledRst16()}
          tip="RST 16 character output — click to toggle capture overlay"
          onClick={() => spectrum && toggleTranscribeMode('rst16')} />
        <Led id="led-text" kind="text" label="TEXT" on={ledText()}
          tip="Pixel-based screen OCR — click to toggle overlay"
          onClick={() => spectrum && toggleTranscribeMode('text')} />
        <Led id="led-beep" kind="beep" label="BEEPER" on={ledBeep()}
          tip="Beeper bit is toggling (producing sound)" />
        <Led id="led-ay" kind="ay" label="AY-3-8912" on={ledAy()}
          tip="Writing to the AY sound chip registers" />
        <Led id="led-dsk" kind="dsk" label="DISK" on={ledDsk()}
          tip="Floppy disk controller is being accessed" />
        <Led id="led-rainbow" kind="rainbow" label="RAINBOW" on={ledRainbow()}
          tip="Attribute area is being rewritten mid-frame (rainbow/colour-cycling effect)" />
      </div>
      <div id="status">{statusText()}</div>
    </div>
  );
}
