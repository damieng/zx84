import type { ComponentChildren } from 'preact';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';

export interface MenuItem {
  value: string;
  label: string;
  /** If defined (true or false), renders as a checkable toggle item. */
  checked?: boolean;
}

interface Props {
  icon: ComponentChildren;
  title?: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
}

export function DropDownMenuButton({ icon, title, items, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on click outside or Escape
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Position the menu using fixed positioning to escape overflow:hidden parents
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 2, left: rect.left });
  }, [open]);

  function handleClick(item: MenuItem) {
    onSelect(item.value);
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
        title={title}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open && (
        <div
          ref={menuRef}
          class="ddmenu"
          style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
        >
          {items.map((item) => (
            <div
              key={item.value}
              class="ddmenu-item"
              onClick={() => handleClick(item)}
            >
              {item.checked !== undefined && (
                <span class="ddmenu-check">{item.checked ? '✓' : ''}</span>
              )}
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
