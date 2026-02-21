import type { JSX } from 'solid-js';
import { createSignal, createEffect, Show, onCleanup } from 'solid-js';

export interface MenuItem {
  value: string;
  label: string;
  /** If defined (true or false), renders as a checkable toggle item. */
  checked?: boolean;
  /** Sub-menu items — renders as a flyout on hover. */
  children?: MenuItem[];
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
    if (item.children) return; // parent items don't fire
    props.onSelect(item.value);
    // Checkable items stay open (they're toggles); action items close
    if (item.checked === undefined) {
      close();
    }
  }

  function renderItem(item: MenuItem) {
    if (item.children) {
      return (
        <div class="ddmenu-item ddmenu-parent">
          <span>{item.label}</span>
          <span class="ddmenu-arrow">{'\u25B8'}</span>
          <div class="ddmenu ddmenu-sub">
            {item.children.map((child) => renderItem(child))}
          </div>
        </div>
      );
    }
    return (
      <div
        class="ddmenu-item"
        onClick={() => handleClick(item)}
      >
        {item.checked !== undefined && (
          <span class="ddmenu-check">{item.checked ? '\u2713' : ''}</span>
        )}
        <span>{item.label}</span>
      </div>
    );
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
          {props.items.map((item) => renderItem(item))}
        </div>
      </Show>
    </>
  );
}
