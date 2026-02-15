import { createSignal, onCleanup } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { setMouseEnabled, updateMousePosition, setMouseButton } from '@/emulator.ts';

export function MousePane() {
  const [captured, setCaptured] = createSignal(false);

  function onMouseMove(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    updateMousePosition(e.movementX, -e.movementY);
  }

  function onMouseDown(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    setMouseButton(e.button, true);
  }

  function onMouseUp(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    setMouseButton(e.button, false);
  }

  function onPointerLockChange() {
    const locked = !!document.pointerLockElement;
    setCaptured(locked);
    setMouseEnabled(locked);
    if (locked) {
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mouseup', onMouseUp);
    } else {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    }
  }

  document.addEventListener('pointerlockchange', onPointerLockChange);
  onCleanup(() => {
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    setMouseEnabled(false);
  });

  function capture() {
    const canvas = document.getElementById('screen') as HTMLCanvasElement | null;
    if (canvas) canvas.requestPointerLock();
  }

  function release() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  return (
    <Pane id="mouse-panel" label="Mouse">
      <div class="mouse-pane">
        <div class="mouse-controls">
          <button
            class="mouse-capture-btn"
            onClick={captured() ? release : capture}
          >
            {captured() ? 'Release Kempston Mouse' : 'Capture as Kempston'}
          </button>
        </div>
        <div class="mouse-hint">
          {captured() ? 'Mouse captured — press ESC to release' : 'Captures pointer and emulates Kempston Mouse'}
        </div>
      </div>
    </Pane>
  );
}
