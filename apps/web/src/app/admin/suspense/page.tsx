'use client';

import { useState } from 'react';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';

/**
 * Money that arrived and that we could not say belonged to anyone.
 *
 * The deposit webhook posts to `suspense` rather than dropping the event,
 * because the money arrived whatever we can work out about it — and dropping
 * it is how a real transfer disappears from a real person's life. This screen
 * is the other half of that decision: without it, "we recorded it" would be
 * the end of the story rather than the start.
 *
 * Attributing APPENDS a correcting entry. The original posting was a true
 * statement — money arrived and we could not say whose — and this is a second
 * true statement made later. Editing the first would erase the fact that we
 * ever did not know, which is exactly what an auditor would want to see.
 */
export default function Suspense() {
  const admin = useAdmin();
  const deposits = useLoad(() => admin.suspense(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Suspense</h1>
        <h2>{deposits.data?.length ?? 0} unattributed deposit(s)</h2>
        <p className="lead">
          Money that arrived and has not reached anybody yet.
        </p>
        <AdminError error={deposits.error} code={deposits.code} role="finance" />
        {deposits.loading && <p className="spinner">Loading…</p>}
        {deposits.data !== undefined && deposits.data.length === 0 && (
          <p className="empty">Nothing in suspense.</p>
        )}
      </div>

      {deposits.data?.map((deposit) => (
        <Deposit key={deposit.deposit_uuid} deposit={deposit} onResolved={deposits.reload} />
      ))}
    </>
  );
}

function Deposit({
  deposit,
  onResolved,
}: {
  deposit: {
    deposit_uuid: string;
    provider: string;
    provider_reference: string;
    amount_minor: string;
    currency: string;
    sender_name: string | null;
    sender_bank: string | null;
    suspense_reason: string | null;
    created_at: string;
    unresolved_for: string;
  };
  onResolved: () => void;
}) {
  const admin = useAdmin();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        void (async () => {
          try {
            await admin.attributeDeposit(deposit.deposit_uuid, userId, reason, pin);
            setPin('');
            onResolved();
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
            {deposit.amount_minor} <span className="muted">{deposit.currency} minor units</span>
          </div>
          <div className="pending">
            from {deposit.sender_name ?? 'an unnamed sender'}
            {deposit.sender_bank !== null && ` · ${deposit.sender_bank}`}
          </div>
        </div>
        <span className="badge warn">held {deposit.unresolved_for}</span>
      </div>

      <div className="row">
        <span className="muted">Provider reference</span>
        <span className="mono">{deposit.provider_reference}</span>
      </div>
      <div className="row">
        <span className="muted">Why it is here</span>
        <span>{deposit.suspense_reason ?? 'no matching account'}</span>
      </div>
      <div className="row">
        <span className="muted">Arrived</span>
        <span>{new Date(deposit.created_at).toLocaleString()}</span>
      </div>

      <div className="field-row two" style={{ marginTop: 14 }}>
        <label>
          Give it to which customer
          <input
            className="mono"
            placeholder="customer id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            required
          />
          <span className="hint">Find it on the customer&apos;s page.</span>
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
      </div>

      <label>
        Why this customer
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
        <span className="hint">
          What you checked. This is the record somebody reads if it turns out to
          be wrong.
        </span>
      </label>

      <button type="submit" disabled={busy}>
        {busy ? 'Working…' : 'Credit this customer'}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
    </form>
  );
}
