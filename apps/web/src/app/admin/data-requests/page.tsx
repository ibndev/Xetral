'use client';

import { Fragment, useState } from 'react';
import type { AdminDataRequest } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { ago, ageSince } from '../age';
import { Kpis } from '../queue';

/**
 * Requests for a copy of somebody's data, or for it to be erased.
 *
 * ORDERED BY DEADLINE, not by arrival. A statutory window is one of the few
 * deadlines here whose consequence is regulatory rather than an unhappy
 * customer, and a queue sorted by age buries the one that matters.
 *
 * ERASING IS THE ONE ACTION IN THIS SYSTEM THAT CANNOT BE UNDONE BY APPENDING.
 * Everything else corrects itself with another entry; this destroys data. So
 * it takes a PIN, a person decides it, and the outcome recorded is the answer
 * the customer receives — what went, and what had to stay.
 */
export default function DataRequests() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.dataRequestQueue(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const pending = queue.data?.requests ?? [];
  const closed = queue.data?.closed ?? [];
  const summary = queue.data?.summary;

  const reload = (): void => {
    setOpen(undefined);
    queue.reload();
  };

  return (
    <>
      <AdminTitle>Data requests</AdminTitle>
      <Kpis
        items={[
          { label: 'Pending', count: summary?.pending, tone: 'warn' },
          { label: 'Due soon', count: summary?.due_soon, tone: 'danger' },
          { label: 'Completed · 30d', count: summary?.completed_30d, tone: 'ok' },
        ]}
      />

      <div className="panel tbl-panel">
        <AdminError error={queue.error} code={queue.code} role="compliance" />
        {queue.loading && <p className="spinner">Loading…</p>}
        {queue.data !== undefined && pending.length === 0 && closed.length === 0 && (
          <p className="empty">Nothing outstanding.</p>
        )}

        {pending.length + closed.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Requested</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {pending.map((request) => (
                  <Fragment key={request.uuid}>
                    <tr>
                      <td>{request.name ?? request.email ?? request.user_uuid}</td>
                      <td className="quiet">{KINDS[request.kind] ?? request.kind}</td>
                      <td className="quiet">{ago(request.requested_at)}</td>
                      {/* The deadline is the law's, and the database's clock
                          decides overdue — never this browser's. */}
                      <td className={request.overdue || soon(request.deadline_at) ? 'alarm' : 'quiet'}>
                        {request.overdue
                          ? `${ageSince(request.deadline_at)} late`
                          : ageSince(request.deadline_at)}
                      </td>
                      <td>
                        {request.overdue ? (
                          <span className="badge danger">Overdue</span>
                        ) : (
                          <span className="badge warn">Pending</span>
                        )}
                      </td>
                      <td className="r">
                        <button
                          type="button"
                          className={open === request.uuid ? 'ghost' : undefined}
                          aria-expanded={open === request.uuid}
                          onClick={() => setOpen(open === request.uuid ? undefined : request.uuid)}
                        >
                          {open === request.uuid ? 'Close' : 'Fulfil'}
                        </button>
                      </td>
                    </tr>
                    {open === request.uuid && (
                      <tr className="detail">
                        <td colSpan={6}>
                          <Request request={request} onResolved={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {closed.map((request) => (
                  <tr key={request.uuid}>
                    <td>{request.name ?? request.email ?? request.user_uuid}</td>
                    <td className="quiet">{KINDS[request.kind] ?? request.kind}</td>
                    <td className="quiet">{ago(request.requested_at)}</td>
                    <td className="quiet">—</td>
                    <td>
                      {request.status === 'completed' ? (
                        <span className="badge ok">Completed</span>
                      ) : (
                        <span className="badge danger">Refused</span>
                      )}
                    </td>
                    <td className="r" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const KINDS: Readonly<Record<string, string>> = { export: 'Data export', erasure: 'Erasure' };

/** Inside seven days — the same window the Due soon figure counts. */
function soon(deadline: string): boolean {
  return Date.parse(deadline) - Date.now() < 7 * 86_400_000;
}

function Request({
  request,
  onResolved,
}: {
  request: AdminDataRequest;
  onResolved: () => void;
}) {
  const admin = useAdmin();
  const [outcome, setOutcome] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isErasure = request.kind === 'erasure';

  return (
    <div className="review-grid">
      <div>
        <p>
          <strong>{isErasure ? 'Erasure' : 'A copy of their data'}</strong>{' '}
          <span className="hint">{request.email ?? request.user_uuid}</span>
        </p>
        <div className="row">
          <span className="muted">Asked</span>
          <span>{new Date(request.requested_at).toLocaleString()}</span>
        </div>
        <div className="row">
          <span className="muted">Due by</span>
          <span className={request.overdue ? 'danger' : undefined}>
            {new Date(request.deadline_at).toLocaleString()}
          </span>
        </div>
        {isErasure && (
          <p className="lead">
            Erasing closes the account and removes their credentials, devices and
            email. It refuses while they hold a balance.
          </p>
        )}
      </div>

      <div>
        <label>
          Your transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>

        <div className="field-row two">
          {isErasure && (
            <button
              type="button"
              className="danger"
              disabled={busy || pin === ''}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void (async () => {
                  try {
                    await admin.eraseCustomer(request.uuid, pin);
                    onResolved();
                  } catch (caught) {
                    setError(messageFor(caught));
                  } finally {
                    setBusy(false);
                    setPin('');
                  }
                })();
              }}
            >
              {busy ? 'Erasing…' : 'Erase'}
            </button>
          )}
        </div>

        <label>
          Or close it with an answer
          <textarea
            value={outcome}
            rows={3}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="What was done, and what was not. At least twenty characters — this is the answer the customer receives."
          />
        </label>

        <div className="field-row two">
          <button
            type="button"
            disabled={busy || outcome.trim().length < 20 || pin === ''}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void (async () => {
                try {
                  await admin.resolveDataRequest(request.uuid, 'completed', outcome, pin);
                  onResolved();
                } catch (caught) {
                  setError(messageFor(caught));
                } finally {
                  setBusy(false);
                  setPin('');
                }
              })();
            }}
          >
            Mark answered
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || outcome.trim().length < 20 || pin === ''}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void (async () => {
                try {
                  await admin.resolveDataRequest(request.uuid, 'refused', outcome, pin);
                  onResolved();
                } catch (caught) {
                  setError(messageFor(caught));
                } finally {
                  setBusy(false);
                  setPin('');
                }
              })();
            }}
          >
            Refuse, with reason
          </button>
        </div>

        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
