'use client';

import { useState } from 'react';
import type { AdminOpenError } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { ageSince } from '../age';

/**
 * What is currently failing.
 *
 * THE OVERVIEW HAS LINKED HERE ALL ALONG AND THE PAGE DID NOT EXIST.
 * `QUEUE_SCREENS` mapped `errors` to `/admin/errors`, so the morning screen
 * rendered "errors · 24 waiting · Open" and the link answered 404 — which is
 * worse than no link, because a queue with a way in reads as a queue somebody
 * could be working. The client could already CLEAR this list (`clearFailures`,
 * written for the diagnostics screen) while nothing could read it: the one
 * thing an operator could do with the platform's failures was dismiss them
 * unseen.
 *
 * `admin`, not `support` — 015's own reasoning, relayed here so the refusal
 * makes sense: an error message describes how the platform is built, and the
 * smallest audience that can act on it is the right one.
 *
 * ORDERED BY WHAT IS STILL HAPPENING. `last_seen_at` rather than occurrences:
 * a fingerprint that fired four hundred times last Tuesday and has been quiet
 * since is history, and one that fired twice in the last minute is an
 * incident. The count is on the row because it separates "a customer hit an
 * edge" from "this is every request".
 */
export default function Errors() {
  const admin = useAdmin();
  const open = useLoad(() => admin.errors(), [admin]);
  const rows = [...(open.data ?? [])].sort(
    (a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at),
  );

  return (
    <div className="panel">
      <h1>Errors</h1>
      <p className="lead">
        One row per fingerprint, not per occurrence. Acknowledging one does not
        delete it — anything still failing reopens itself on its next
        occurrence.
      </p>

      <AdminError error={open.error} code={open.code} role="admin" />
      {open.loading && <p className="spinner">Loading…</p>}

      {!open.loading && open.error === undefined && rows.length === 0 && (
        <p className="empty">Nothing is failing.</p>
      )}

      {rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>What failed</th>
                <th>Route</th>
                <th className="right error-count">Seen</th>
                <th className="right">Last</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ErrorRow key={row.fingerprint} row={row} onResolved={open.reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ErrorRow({
  row,
  onResolved,
}: {
  readonly row: AdminOpenError;
  readonly onResolved: () => void;
}) {
  const admin = useAdmin();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <tr>
      <td className="error-message">
        <div>{row.message}</div>
        {/*
          The reference an operator can quote back. It is the only thing tying
          this row to the one request a customer is on the phone about, and it
          is the last one seen rather than the first: the caller is describing
          what just happened.
        */}
        {row.last_reference !== null && (
          <div className="hint">ref {row.last_reference}</div>
        )}
        {error !== undefined && <div className="error">{error}</div>}
      </td>
      {/* The route PATTERN, never the resolved path — 015 stores it that way
          so one customer's id cannot land in a table everyone on call reads. */}
      <td className="hint">
        {row.route ?? '—'}
        {row.status_code !== null && ` · ${row.status_code}`}
      </td>
      <td className="right amount error-count">{row.occurrences}</td>
      <td className="right muted">{ageSince(row.last_seen_at)}</td>
      <td className="right">
        <button
          type="button"
          className="small ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void (async () => {
              try {
                await admin.resolveError(row.fingerprint);
                onResolved();
              } catch (cause) {
                setError(messageFor(cause));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? 'Acknowledging…' : 'Acknowledge'}
        </button>
      </td>
    </tr>
  );
}
