'use client';

import { useEffect, useState } from 'react';
import { Icon } from './icon';

/**
 * A short-lived message about something that just happened, over the page.
 *
 * Money moving is the one action on this product where the outcome has to be
 * unmistakable. It was a line of text under a form that had just reset
 * itself — correct, and easy to miss on a phone where the keyboard was
 * closing at the same moment, so a customer could tap Send, look up, and have
 * no idea whether ₦50,000 had gone.
 *
 * IT DOES NOT REPLACE THE INLINE MESSAGE, it sits over it. A toast that
 * carries the only copy of a refusal is a refusal that vanishes after five
 * seconds and cannot be re-read, which is the worst possible property for the
 * sentence explaining why somebody's money did not move.
 *
 * `aria-live` rather than an alert dialog: it must be announced without
 * stealing focus from wherever the customer is, and it must never need
 * dismissing before they can try again.
 */
export function Toast({
  message,
  tone,
  onDone,
}: {
  readonly message: string | undefined;
  readonly tone: 'ok' | 'bad';
  /** Called when it retires itself, so the caller can clear the state that
   *  produced it — otherwise the same message can never be shown twice. */
  readonly onDone?: () => void;
}) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (message === undefined) return;
    setLeaving(false);
    // A refusal is left longer than a success. A success confirms something
    // the customer already believes happened; a refusal is something they
    // have to read and act on.
    const life = tone === 'ok' ? 4500 : 7000;
    const fade = setTimeout(() => setLeaving(true), life);
    const gone = setTimeout(() => onDone?.(), life + 250);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [message, tone, onDone]);

  if (message === undefined) return null;

  return (
    <div
      className={`toast ${tone}${leaving ? ' leaving' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="toast-icon">
        <Icon name={tone === 'ok' ? 'check' : 'alert'} size={18} />
      </span>
      <span className="toast-text">{message}</span>
    </div>
  );
}
