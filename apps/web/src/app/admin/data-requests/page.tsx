'use client';

import { useState } from 'react';
import type { AdminDataRequest } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';

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
  const requests = useLoad(() => admin.dataRequests(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Data requests</h1>
        <h2>{requests.data?.length ?? 0} open</h2>
        <p className="lead">
          A copy of their data, or erasure. The deadline is the law&rsquo;s, not
          ours — an overdue row is a regulatory finding rather than a slow
          reply.
        </p>
        {requests.error !== undefined && <p className="error">{requests.error}</p>}
        {requests.loading && <p className="spinner">Loading…</p>}
        {requests.data !== undefined && requests.data.length === 0 && (
          <p className="empty">Nothing outstanding.</p>
        )}
      </div>

      {requests.data?.map((row) => (
        <Request key={row.uuid} request={row} onResolved={requests.reload} />
      ))}
    </>
  );
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
    <div className="panel">
      <h2>
        {isErasure ? 'Erasure' : 'Copy of their data'}{' '}
        {request.overdue && <span className="badge danger">overdue</span>}
      </h2>

      <div className="row">
        <span className="muted">Customer</span>
        <span>{request.email ?? request.user_uuid}</span>
      </div>
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
          Erasing removes their sign-in credentials, devices and email address,
          and closes the account. It refuses while they hold a balance —
          empty the account first, which is a payment. The transaction record
          is kept and is deleted when its retention period ends; the outcome
          recorded says so, and it is what the customer is told.
        </p>
      )}

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
  );
}
