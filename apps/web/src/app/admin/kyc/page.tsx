'use client';

import { useState } from 'react';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';

/**
 * The identity review queue.
 *
 * The most consequential button in the dashboard, and worth saying why:
 * approving is what creates the customer's `provider_customers` mapping, which
 * is what lets them hold a Nigerian account number and a dollar card. A
 * customer who is not approved is not merely un-badged — they are locked out
 * of both, permanently, until somebody presses this.
 *
 * A reviewer cannot approve their own submission. That is enforced by a CHECK
 * on the table, not by this page hiding a button.
 */
export default function KycQueue() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.kycQueue(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Identity review</h1>
        <h2>{queue.data?.length ?? 0} waiting</h2>
        <p className="lead">
          Approving creates this customer&apos;s provider mapping. Until then
          they cannot be issued an account number or a card.
        </p>
        {queue.error !== undefined && <p className="error">{queue.error}</p>}
        {queue.loading && <p className="spinner">Loading…</p>}
        {queue.data !== undefined && queue.data.length === 0 && (
          <p className="empty">Nothing waiting.</p>
        )}
      </div>

      {queue.data?.map((submission) => (
        <Submission key={submission.id} submission={submission} onReviewed={queue.reload} />
      ))}
    </>
  );
}

function Submission({
  submission,
  onReviewed,
}: {
  submission: {
    id: string;
    email: string;
    full_name: string;
    bvn_last4: string;
    date_of_birth: string;
    phone: string;
    address: string;
    created_at: string;
  };
  onReviewed: () => void;
}) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function review(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        await admin.reviewKyc(
          submission.id,
          decision,
          pin,
          reason === '' ? undefined : reason,
        );
        setPin('');
        setReason('');
        onReviewed();
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="panel">
      <div className="grid two">
        <div>
          <h3 style={{ marginTop: 0 }}>{submission.full_name}</h3>
          <div className="row">
            <span className="muted">Account</span>
            <span>{submission.email}</span>
          </div>
          <div className="row">
            <span className="muted">Date of birth</span>
            <span>{new Date(submission.date_of_birth).toLocaleDateString()}</span>
          </div>
          <div className="row">
            <span className="muted">Phone</span>
            <span className="mono">{submission.phone}</span>
          </div>
          <div className="row">
            <span className="muted">BVN</span>
            {/*
              Four digits, and there is nothing else to show. The server seals
              the BVN and no endpoint returns it — a reviewer confirming a
              customer's identity does so against the name and the last four,
              which is what a bank's own support desk works from.
            */}
            <span className="mono">•••••••{submission.bvn_last4}</span>
          </div>
          <div className="row">
            <span className="muted">Address</span>
            <span>{submission.address}</span>
          </div>
          <div className="row">
            <span className="muted">Submitted</span>
            <span>{new Date(submission.created_at).toLocaleString()}</span>
          </div>
        </div>

        <div>
          <label>
            Reason (required to reject)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            <span className="hint">
              A rejection reason is shown to the customer. Write it for them.
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
            />
          </label>

          <div className="actions">
            <button type="button" disabled={busy || pin === ''} onClick={() => review('approve')}>
              Approve
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || pin === '' || reason === ''}
              onClick={() => review('reject')}
            >
              Reject
            </button>
          </div>

          {error !== undefined && <p className="error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
