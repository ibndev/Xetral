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
  /**
   * An optional badge drawn before each label, in the list AND on the trigger.
   *
   * A render prop rather than an `icon` field on the option, because the thing
   * being drawn — a flag clipped to a circle — is a component, and putting
   * components in a data array makes the options list something a screen
   * cannot build from an API response.
   */
  readonly renderMark?: (value: string) => React.ReactNode;
  /**
   * What the TRIGGER shows, when that is not the option's label.
   *
   * The dialling-code picker is the case this exists for: the list has to say
   * "Nigeria" so somebody can find it, and the trigger has to say "+234"
   * because it sits in front of a phone number and the country's name there
   * would push the field off a handset. One control, two readings.
   */
  readonly renderTrigger?: (value: string) => React.ReactNode;
  /** Sized to its content rather than to the row — for a picker sitting inside
   *  another field rather than filling one. */
  readonly compact?: boolean;
  /**
   * A FILTER BOX ABOVE THE LIST, for a list nobody can scan.
   *
   * Off by default and deliberately so: a currency picker has five rows and a
   * text field in front of one invites somebody to type a currency that does
   * not exist. The Nigerian bank list is the opposite case — Paystack returns
   * upwards of a hundred, alphabetical, and finding "Kuda" by scrolling is
   * the customer doing the computer's work. Typeahead is not enough at that
   * length: it matches a PREFIX and jumps, so a customer who thinks of their
   * bank as "GTBank" never reaches "Guaranty Trust".
   */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
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
  renderMark,
  renderTrigger,
  compact,
  searchable = false,
  searchPlaceholder = 'Search…',
}: SelectProps): React.JSX.Element {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  /** Typeahead buffer, cleared by a pause rather than by a keystroke count. */
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  /*
   * WHAT THE LIST IS SHOWING, which is not always every option.
   *
   * Every index below — the active row, the arrow keys, Home and End, what
   * Enter commits — is an index into THIS array rather than into `options`.
   * Mixing the two is how a filtered list commits the wrong row, which is a
   * bug that only appears once somebody types.
   *
   * Matched anywhere in the label rather than at the start: a customer looking
   * for "GTBank" in a list that calls it "Guaranty Trust Bank" is exactly the
   * case a prefix match fails.
   */
  const needle = query.trim().toLowerCase();
  const shown =
    searchable && needle !== ''
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;

  const selectedIndex = shown.findIndex((o) => o.value === value);
  const selected = options.find((o) => o.value === value);

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    // The filter belongs to one opening of the list. Leaving it behind means
    // the next open shows a list already narrowed by a search nobody
    // remembers making.
    setQuery('');
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
    // Focus goes to whatever is taking keys: the filter box when there is
    // one, the list otherwise. Both carry the same key handler, so the arrow
    // keys and Enter behave identically either way.
    if (searchable) search.current?.focus();
    else list.current?.focus();
  }, [open, searchable]);

  // Typing narrows the list, so the highlighted row has to come back to the
  // top — otherwise Enter commits a row scrolled out of sight.
  useEffect(() => {
    if (open) setActive(0);
  }, [query, open]);

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
    const option = shown[index];
    if (option === undefined || option.disabled === true) return;
    onChange(option.value);
    close(true);
  }

  /** The next selectable row in a direction, skipping disabled ones. */
  function step(from: number, delta: number): number {
    for (let i = from + delta; i >= 0 && i < shown.length; i += delta) {
      if (shown[i]?.disabled !== true) return i;
    }
    return from;
  }

  function firstEnabled(): number {
    const i = shown.findIndex((o) => o.disabled !== true);
    return i === -1 ? 0 : i;
  }

  function lastEnabled(): number {
    for (let i = shown.length - 1; i >= 0; i--) if (shown[i]?.disabled !== true) return i;
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

    // Typeahead, and ONLY where there is no filter box. With one, every
    // printable key belongs to the input — stealing it would move the
    // highlight while the customer is still typing the bank's name.
    if (
      !searchable &&
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const now = Date.now();
      const text = (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase();
      typed.current = { text, at: now };

      const found = shown.findIndex(
        (o) => o.disabled !== true && o.label.toLowerCase().startsWith(text),
      );
      if (found !== -1) setActive(found);
    }
  }

  return (
    <div
      className={`xselect${compact === true ? ' is-compact' : ''}`}
      ref={root}
      data-open={open || undefined}
    >
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
        <span className="xselect-chosen">
          {renderMark !== undefined && selected !== undefined && renderMark(selected.value)}
          {renderTrigger !== undefined && selected !== undefined ? (
            renderTrigger(selected.value)
          ) : (
            <span className={selected === undefined ? 'xselect-placeholder' : undefined}>
              {selected?.label ?? placeholder}
            </span>
          )}
        </span>
        <Icon name="chevronDown" size={18} />
      </button>

      {open && searchable && (
        /*
          THE FILTER SITS INSIDE THE OPEN LIST, not above the trigger.

          Above the trigger it would be a second permanent control on a form
          that already has enough of them, and it would be visible while the
          list is closed — a text box next to a chosen bank reads as somewhere
          to type a different one. Inside, it exists exactly while it is
          useful.
        */
        <div className="xselect-search">
          <Icon name="search" size={16} />
          <input
            ref={search}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={`${listId}-${active}`}
            aria-autocomplete="list"
            {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
            placeholder={searchPlaceholder}
            value={query}
            autoComplete="off"
            // Never offered back by the browser on another form, and never
            // corrected: a bank's name is not a word.
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      )}

      {open && shown.length === 0 && (
        // SAYS SO, rather than showing an empty box. A list that renders to
        // nothing is indistinguishable from one that failed to load, which is
        // the confusion this screen has already had once.
        <p className="xselect-empty">No match for “{query.trim()}”.</p>
      )}

      {open && shown.length > 0 && (
        <ul
          id={listId}
          ref={list}
          className="xselect-list"
          role="listbox"
          // With a filter box the input owns focus and the keys; the list is
          // then a passive surface and must not be a tab stop of its own.
          tabIndex={searchable ? undefined : -1}
          {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
          {...(searchable ? {} : { 'aria-activedescendant': `${listId}-${active}` })}
          onKeyDown={onKeyDown}
        >
          {shown.map((option, index) => (
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
              {renderMark !== undefined && renderMark(option.value)}
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
