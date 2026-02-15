import type { JSX } from 'solid-js';
import { createSignal, createEffect, Show, onCleanup } from 'solid-js';

export interface MenuItem {
  value: string;
  label: string;
  /** If defined (true or false), renders as a checkable toggle item. */
  checked?: boolean;
}

interface Props {
  icon: JSX.Element;
  title?: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
}

export function DropDownMenuButton(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  let btnRef!: HTMLButtonElement;
  let menuRef!: HTMLDivElement;

  function close() { setOpen(false); }

  // Close on click outside or Escape
  createEffect(() => {
    if (!open()) return;
    function onMouseDown(e: MouseEvent) {
      if (
        menuRef && !menuRef.contains(e.target as Node) &&
        btnRef && !btnRef.contains(e.target as Node)
      ) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    });
  });

  // Position the menu using fixed positioning to escape overflow:hidden parents
  createEffect(() => {
    if (!open() || !btnRef) return;
    const rect = btnRef.getBoundingClientRect();
    setPos({ top: rect.bottom + 2, left: rect.left });
  });

  function handleClick(item: MenuItem) {
    props.onSelect(item.value);
    // Checkable items stay open (they're toggles); action items close
    if (item.checked === undefined) {
      close();
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        class="ddmenu-btn"
        title={props.title}
        onClick={() => setOpen(!open())}
      >
        {props.icon}
      </button>
      <Show when={open()}>
        <div
          ref={menuRef}
          class="ddmenu"
          style={{ top: `${pos().top}px`, left: `${pos().left}px` }}
        >
          {props.items.map((item) => (
            <div
              class="ddmenu-item"
              onClick={() => handleClick(item)}
            >
              {item.checked !== undefined && (
                <span class="ddmenu-check">{item.checked ? '\u2713' : ''}</span>
              )}
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </Show>
    </>
  );
}
