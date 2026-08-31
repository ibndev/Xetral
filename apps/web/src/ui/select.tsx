'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/ui/icon';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** Second line, for an option that needs a word of explanation. */
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  /** Shown when `value` matches no option — a list still loading, usually. */
  readonly placeholder?: string;
  /** Points at the visible <label>, which a native select got for free. */
  readonly labelledBy?: string;
  readonly id?: string;
}

/**
 * A dropdown this application draws, rather than one the operating system
 * draws for it.
 *
 * A NATIVE `<select>` CANNOT BE THEMED WHERE IT MATTERS. The closed control
 * takes CSS and the OPEN LIST does not: Android renders it as a full-screen
 * dialog in the system font, iOS as a wheel at the bottom of the screen, and
 * neither has any idea this app has a dark theme. So a customer in dark mode
 * tapped a currency picker and got a white sheet in a font from somewhere
 * else — reported, correctly, as looking broken. No amount of styling on the
 * element itself reaches that.
 *
 * WHAT THIS GIVES UP, deliberately. A native select on a phone is a large,
 * familiar, scrollable target that works with every assistive technology
 * without anybody implementing anything. Replacing it means owning the
 * keyboard model and the ARIA, which is why all of it is here rather than
 * approximated: roving `aria-activedescendant` on a `listbox`, arrow keys,
 * Home and End, Enter and Space to commit, Escape to abandon, typeahead, and
 * focus returned to the trigger on close so a keyboard user is never dropped
 * at the top of the document.
 *
 * IT IS NOT A COMBOBOX. There is no text input, because none of these lists is
 * long enough to need filtering and a text field invites a customer to type a
 * currency that does not exist and wonder why nothing happens.
 *
 * The list is rendered INSIDE the control's own stacking context rather than
 * in a portal. Every use sits in ordinary page flow inside a `.card`, so a
 * portal would buy escape from an overflow clip that nothing here has, at the
 * cost of position tracking on scroll and resize.
 */
export function Select({
  value,
  onChange,
  options,
  disabled = false,
  placeholder = 'Select…',
  labelledBy,
  id,
}: SelectProps): React.JSX.Element {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** Typeahead buffer, cleared by a pause rather than by a keystroke count. */
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex === -1 ? undefined : options[selectedIndex];

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    // Returning focus is what makes Escape and a committed choice feel like
    // the same control rather than like the page moving underneath.
    if (focusTrigger) trigger.current?.focus();
  }, []);

  // Opening lands on the current value, not on the first row — so a customer
  // opening a picker and pressing Down moves one step from where they are.
  useEffect(() => {
    if (open) setActive(selectedIndex === -1 ? 0 : selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    // Focus goes to the LIST, so the browser's own focus ring lands on the
    // thing that is now taking keys.
    list.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Pointerdown rather than click: a click elsewhere that removes its own
    // target from the document never reaches a click listener here.
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // A scroll would slide the list away from the trigger it belongs to.
    const onScroll = (): void => setOpen(false);

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Keeps the highlighted row visible when the list is taller than its box.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function commit(index: number): void {
    const option = options[index];
    if (option === undefined || option.disabled === true) return;
    onChange(option.value);
    close(true);
  }

  /** The next selectable row in a direction, skipping disabled ones. */
  function step(from: number, delta: number): number {
    for (let i = from + delta; i >= 0 && i < options.length; i += delta) {
      if (options[i]?.disabled !== true) return i;
    }
    return from;
  }

  function firstEnabled(): number {
    const i = options.findIndex((o) => o.disabled !== true);
    return i === -1 ? 0 : i;
  }

  function lastEnabled(): number {
    for (let i = options.length - 1; i >= 0; i--) if (options[i]?.disabled !== true) return i;
    return 0;
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'Tab':
        // Not prevented: Tab should move on. The list closes behind it.
        setOpen(false);
        return;
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => step(i, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => step(i, -1));
        return;
      case 'Home':
        event.preventDefault();
        setActive(firstEnabled());
        return;
      case 'End':
        event.preventDefault();
        setActive(lastEnabled());
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(active);
        return;
      default:
        break;
    }

    // Typeahead. One printable character at a time, accumulated while the
    // customer keeps typing — so "us" reaches USD rather than cycling U.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const text = (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase();
      typed.current = { text, at: now };

      const found = options.findIndex(
        (o) => o.disabled !== true && o.label.toLowerCase().startsWith(text),
      );
      if (found !== -1) setActive(found);
    }
  }

  return (
    <div className="xselect" ref={root} data-open={open || undefined}>
      <button
        type="button"
        ref={trigger}
        id={id}
        className="xselect-trigger"
        disabled={disabled}
        // `listbox` rather than `combobox`: there is no text entry, and
        // claiming otherwise makes a screen reader announce an input that
        // does not exist.
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={selected === undefined ? 'xselect-placeholder' : undefined}>
          {selected?.label ?? placeholder}
        </span>
        <Icon name="chevronDown" size={18} />
      </button>

      {open && (
        <ul
          id={listId}
          ref={list}
          className="xselect-list"
          role="listbox"
          tabIndex={-1}
          {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              data-active={index === active}
              data-selected={option.value === value}
              // Mousedown, not click: a click fires after the pointerdown that
              // would otherwise have closed the list out from under it.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(index);
              }}
              onMouseEnter={() => {
                if (option.disabled !== true) setActive(index);
              }}
            >
              <span className="xselect-label">{option.label}</span>
              {option.hint !== undefined && <span className="xselect-hint">{option.hint}</span>}
              {option.value === value && <Icon name="check" size={16} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
