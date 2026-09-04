'use client';

import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import type { AdminHeldMoney } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';

/**
 * Money that left a customer's balance and never reached where it was going.
 *
 * A payout reserves BEFORE the provider is asked, and a purchase does the
 * same: the money moves out of the wallet into `customer_pending`, and only
 * then does anybody call anyone. That ordering is deliberate — the overdraft
 * guard has to decide before we commit to something we cannot recall — and the
 * cost of it is this queue. When the provider never answers, the row stays
 * `reserved` for ever and the customer's money sits in pending, which reads on
 * their screen as simply gone.
 *
 * `PayoutReconciliationService` resolves the ones the provider will answer
 * for. This screen is for the rest: the ones where a person has to look,
 * establish that nothing left, and give it back.
 *
 * THE AMOUNT IS NOT ON THIS FORM, and that is the whole safety argument. It
 * comes from the held row on the server, so this screen cannot credit an
 * arbitrary customer an arbitrary sum — the worst it can do is give somebody
 * back exactly what was taken from them. What it takes instead is a reason,
 * which is the part a reviewer reads afterwards.
 */
export default function Recovery() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.recoveryQueue(), [admin]);

  const waiting = queue.data?.waiting ?? [];
  const recovered = queue.data?.recovered ?? [];

  return (
    <>
      <div className="panel">
        <h1>Recovery</h1>
        <h2>{waiting.length} held, waiting for a person</h2>
        <p className="lead">
          Money taken from a customer that never reached its destination.
          Reversing gives it back to the customer it came from.
        </p>
        <AdminError error={queue.error} code={queue.code} role="support" />
        {queue.loading && <p className="spinner">Loading…</p>}
        {queue.data !== undefined && waiting.length === 0 && (
          <p className="empty">Nothing is held. Every reservation has resolved.</p>
        )}
      </div>

      {waiting.map((row) => (
        <Held key={`${row.kind}:${row.subject_uuid}`} row={row} onDone={queue.reload} />
      ))}

      {recovered.length > 0 && (
        <div className="panel">
          <h2>Already given back</h2>
          <p className="lead">
            Append-only. A recovery cannot be edited or undone — a mistake here
            is corrected by a further entry, the same rule the ledger follows.
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>What</th>
                  <th>Amount</th>
                  <th>Who did it</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {recovered.map((row) => (
                  <tr key={row.uuid}>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.email ?? '—'}</td>
                    <td>{row.kind === 'bank_payout' ? 'Bank transfer' : 'Purchase'}</td>
                    <td className="amount">{formatMinor(row.amount_minor, row.currency)}</td>
                    <td>{row.actioned_by ?? '—'}</td>
                    <td>{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * One held row, and the button that gives it back.
 *
 * The age is shown as hours because that is the question being asked: a
 * payout held for twenty minutes is a provider taking its time, and one held
 * for three days is one nobody is coming back to answer for.
 */
function Held({ row, onDone }: { row: AdminHeldMoney; onDone: () => void }) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const hours = Math.floor(row.hours_held);
  const age =
    hours < 1 ? 'under an hour' : hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        void (async () => {
          try {
            await admin.recover(row.kind, row.subject_uuid, reason, pin);
            setPin('');
            onDone();
          } catch (cause) {
            setError(messageFor(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <div className="balance">
        <div>
          <div className="amount" style={{ fontSize: 22 }}>
            {formatMinor(row.amount_minor, row.currency)}
          </div>
          <div className="pending">
            {row.email ?? `customer ${row.user_id}`} ·{' '}
            {row.kind === 'bank_payout' ? 'bank transfer' : 'purchase'}
          </div>
        </div>
        <span className={hours >= 24 ? 'badge danger' : 'badge warn'}>held {age}</span>
      </div>

      <div className="row">
        <span className="muted">Where it was going</span>
        <span>{row.destination}</span>
      </div>
      <div className="row">
        <span className="muted">Started</span>
        <span>{new Date(row.created_at).toLocaleString()}</span>
      </div>
      <div className="row">
        <span className="muted">Reference</span>
        <span className="mono">{row.subject_uuid}</span>
      </div>
      <div className="row">
        <span className="muted">State at the provider</span>
        <span>{row.status}</span>
      </div>

      <label style={{ marginTop: 14 }}>
        Why you are giving this back
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={8}
          maxLength={500}
        />
        <span className="hint">
          What you checked to establish the money never left. This is the record
          somebody reads if the provider later says it did.
        </span>
      </label>

      <label>
        Your transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
      </label>

      <button type="submit" disabled={busy}>
        {busy ? 'Working…' : 'Reverse and give it back'}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
    </form>
  );
}
