'use client';

import { Fragment, useState } from 'react';
import type { AdminKycSubmission } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { ageSince } from '../age';
import { Kpis } from '../queue';
import { CountryMark } from '@/ui/currency-mark';
import { AdminTitle } from '@/app/admin/nav';

/**
 * The identity review queue, as the comp draws it: three figures, then one
 * table whose row carries Reject and Approve.
 *
 * The most consequential button in the dashboard, and worth saying why:
 * approving is what creates the customer's `provider_customers` mapping, which
 * is what lets them hold a Nigerian account number and a dollar card. A
 * customer who is not approved is not merely un-badged — they are locked out
 * of both until somebody presses this.
 *
 * THE BUTTONS OPEN THE DECISION, THEY DO NOT MAKE IT. The comp puts Approve on
 * the row; a reviewer approving an identity they have not read is exactly the
 * approval a regulator asks about. So the press opens the submission under its
 * row — the name, the date of birth, the last four of the BVN, the address —
 * with the PIN beside it, and only the second press decides.
 *
 * A reviewer cannot approve their own submission. That is enforced by a CHECK
 * on the table, not by this page hiding a button.
 */
export default function KycQueue() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.kycReview(), [admin]);
  const [open, setOpen] = useState<{ id: string; decision: 'approve' | 'reject' } | undefined>();
  const rows = queue.data?.queue ?? [];
  // Ordered oldest first by the server, so the first row IS the oldest.
  const oldest = rows[0]?.created_at;

  const toggle = (id: string, decision: 'approve' | 'reject'): void =>
    setOpen((was) => (was?.id === id && was.decision === decision ? undefined : { id, decision }));

  return (
    <>
      <AdminTitle>Identity</AdminTitle>
      <Kpis
        items={[
          { label: 'Awaiting review', count: queue.data === undefined ? undefined : rows.length, tone: 'warn' },
          { label: 'Oldest waiting', value: queue.data === undefined ? undefined : oldest === undefined ? '—' : ageSince(oldest) },
          { label: 'Approved · 24h', count: queue.data?.approved_24h, tone: 'ok' },
        ]}
      />

      <div className="panel tbl-panel">
        <AdminError error={queue.error} code={queue.code} role="compliance" />
        {queue.loading && <p className="spinner">Loading…</p>}
        {!queue.loading && queue.error === undefined && rows.length === 0 && (
          <p className="empty">Nothing waiting.</p>
        )}

        {rows.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Document</th>
                  <th>Country</th>
                  <th>Waiting</th>
                  <th className="r">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((submission) => (
                  <Fragment key={submission.id}>
                    <tr>
                      <td>
                        <strong>{submission.full_name}</strong>
                        <div className="cell-sub">{submission.email}</div>
                      </td>
                      {/* TYPED FIELDS, NOT AN UPLOAD — `kyc_submissions` has no
                          column for a file, so the comp's "National ID" would
                          describe a feature that does not exist. What there is
                          to check is the BVN's last four. */}
                      <td className="soft">
                        BVN <span className="mono">••{submission.bvn_last4}</span>
                      </td>
                      <td>
                        {submission.country === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <span title={submission.country}>
                            <CountryMark country={submission.country} size={20} />
                          </span>
                        )}
                      </td>
                      <td className="quiet">{ageSince(submission.created_at)}</td>
                      <td className="r">
                        <span className="acts">
                          <button
                            type="button"
                            className="ghost"
                            aria-expanded={open?.id === submission.id && open.decision === 'reject'}
                            onClick={() => toggle(submission.id, 'reject')}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            aria-expanded={open?.id === submission.id && open.decision === 'approve'}
                            onClick={() => toggle(submission.id, 'approve')}
                          >
                            Approve
                          </button>
                        </span>
                      </td>
                    </tr>
                    {open?.id === submission.id && (
                      <tr className="detail">
                        <td colSpan={5}>
                          <Decide
                            key={open.decision}
                            submission={submission}
                            decision={open.decision}
                            onDone={() => {
                              setOpen(undefined);
                              queue.reload();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Decide({
  submission,
  decision,
  onDone,
}: {
  readonly submission: AdminKycSubmission;
  readonly decision: 'approve' | 'reject';
  readonly onDone: () => void;
}) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const ready = pin !== '' && !busy && (decision === 'approve' || reason.trim() !== '');

  function review(): void {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        await admin.reviewKyc(submission.id, decision, pin, reason.trim() === '' ? undefined : reason.trim());
        onDone();
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="review-grid">
      <dl className="facts">
        <dt>Name</dt>
        <dd>{submission.full_name}</dd>
        <dt>Date of birth</dt>
        <dd>{new Date(submission.date_of_birth).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</dd>
        <dt>Phone</dt>
        <dd className="mono">{submission.phone}</dd>
        {/* Four digits, and there is nothing else to show. The server seals
            the BVN and no endpoint returns it. */}
        <dt>BVN</dt>
        <dd className="mono">•••••••{submission.bvn_last4}</dd>
        <dt>Address</dt>
        <dd>{submission.address}</dd>
      </dl>

      <div>
        {decision === 'reject' && (
          <label>
            <span>Why, in words for the customer</span>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {decision === 'approve' && (
          <p className="hint">
            Approving opens their account number and card. Check the name against the BVN
            before you do.
          </p>
        )}
        <label>
          <span>Transaction PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className={decision === 'reject' ? 'small danger' : 'small'}
            disabled={!ready}
            onClick={review}
          >
            {busy ? 'Saving…' : decision === 'approve' ? `Approve ${submission.full_name.split(' ')[0] ?? ''}` : 'Reject submission'}
          </button>
        </div>
        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
