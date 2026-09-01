'use client';

import { useEffect } from 'react';

/**
 * The boundary for a render that threw.
 *
 * Without this, a thrown error in any client component blanks the page — the
 * customer sees white, with no way back and no idea whether the transfer they
 * just submitted went through. This says the one thing they actually need to
 * know: this screen failed, your money did not move because of it.
 *
 * The `error` object is deliberately NOT rendered. A React error message can
 * carry props, and props here carry account identifiers and amounts; putting
 * one on screen is how a support screenshot ends up holding data the customer
 * never chose to share. The digest is enough to find it in the logs.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Left as a console error on purpose: this is the browser, and there is no
    // reporting endpoint that would not become another place customer data
    // accumulates. The server logs are the record.
    console.error('render failed', error.digest ?? error.name);
  }, [error]);

  return (
    <main className="shell">
      <div className="nav">
        <strong>Xetral</strong>
      </div>

      <div className="panel">
        <h1>Something went wrong on this screen</h1>
        <h2>Your balance and your transactions are not affected</h2>
        <p className="lead">
          A fault in the page, not in your account. No money moved.
        </p>
        <div className="actions">
          <button type="button" onClick={reset}>
            Try again
          </button>
          <a href="/wallet">
            <button type="button" className="ghost">
              Back to my wallet
            </button>
          </a>
        </div>
        {error.digest !== undefined && (
          <p className="hint mono">Reference {error.digest}</p>
        )}
      </div>
    </main>
  );
}
