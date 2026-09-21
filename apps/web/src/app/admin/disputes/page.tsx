'use client';

import { useState } from 'react';
import type { AdminQueuedDispute } from '@xetral/client';
import { useAdmin, useIdempotencyKey, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { ageSince } from '../age';
import { AdminTitle } from '@/app/admin/nav';

/**
 * Disputes — "I did not do this" — and the reviewer who answers them.
 *
 * THIS SCREEN DID NOT EXIST, AND EVERYTHING ELSE ABOUT THE FEATURE DID.
 * `018_disputes.sql` has the table, the state machine and the deadline;
 * `/v1/admin/disputes` and its resolve endpoint have been declared since Phase
 * 13 with their own `dispute_reviewer` role; the overview COUNTS the queue. So
 * an operator could read "disputes: 7 waiting" on the morning screen and had
 * no way to open one — the row carried no link, because `QUEUE_SCREENS` had no
 * entry, because there was no page. A customer raised a claim, a deadline ran,
 * and the only way to read or answer it was psql.
 *
 * That is the shape Phase 12 records about `provider_customers`: every part
 * built except the one that lets a person act, and nothing failing anywhere.
 *
 * WHAT THE PAGE REFUSES TO IMPLY. Raising a dispute posts NOTHING — a claim is
 * an assertion about a fact, not a fact — so nothing here is "pending money".
 * Upholding one pays out of `expense_dispute_loss`, our own account, because
 * there is no clawback from the recipient and inventing one would overdraw a
 * customer who may have done nothing wrong. The screen says that where the
 * decision is made rather than in a help page nobody opens.
 */
export default function Disputes() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.disputes(), [admin]);
  const rows = queue.data ?? [];
  const overdue = rows.filter((row) => row.overdue).length;

  return (
    <>
      <div className="panel">
        <AdminTitle>Disputes</AdminTitle>
        <p className="lead">
          A customer&rsquo;s claim that a transaction was not theirs. Raising one
          moves no money; upholding one pays it from our own account.
        </p>

        <AdminError error={queue.error} code={queue.code} role="dispute_reviewer" />
        {queue.loading && <p className="spinner">Loading…</p>}

        {!queue.loading && queue.error === undefined && rows.length === 0 && (
          <p className="empty">Nothing waiting.</p>
        )}

        {overdue > 0 && (
          <div className="notice danger">
            <p>
              <strong>{overdue} past its deadline.</strong> The deadline is the
              database&rsquo;s clock and cannot be extended.
            </p>
          </div>
        )}
      </div>

      {rows.map((dispute) => (
        <DisputeCard key={dispute.id} dispute={dispute} onResolved={queue.reload} />
      ))}
    </>
  );
}

/**
 * One claim, and the two things a reviewer can do with it.
 *
 * BOTH OUTCOMES ARE FINAL, by trigger — reopening an accepted dispute pays the
 * refund twice and reopening a rejected one erases that it was refused. New
 * evidence raises a NEW dispute, which the partial unique index permits
 * deliberately. So the button says what it does and the reason is required
 * before either is reachable.
 */
function DisputeCard({
  dispute,
  onResolved,
}: {
  readonly dispute: AdminQueuedDispute;
  readonly onResolved: () => void;
}) {
  const admin = useAdmin();
  const [resolution, setResolution] = useState('');
  const [refund, setRefund] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState<'accepted' | 'rejected' | undefined>();
  const [error, setError] = useState<string | undefined>();

  /*
   * THE KEY BELONGS TO THE ATTEMPT, not to the click. Generated when this card
   * mounts and reused across retries, so a reviewer whose first press timed
   * out and who presses again refunds ONCE — the rule `useIdempotencyKey`
   * exists for, and it matters here more than on most screens because the
   * money leaves our own account and nothing downstream would notice a second
   * one.
   */
  const attempt = useIdempotencyKey();

  const said = resolution.trim();
  const canReject = said.length >= 10 && pin !== '' && busy === undefined;
  const canAccept = canReject && refund.trim() !== '';

  function resolve(outcome: 'accepted' | 'rejected'): void {
    setBusy(outcome);
    setError(undefined);
    void (async () => {
      try {
        await admin.resolveDispute(
          dispute.id,
          outcome === 'accepted'
            ? {
                outcome,
                resolution: said,
                refund_amount: refund.trim(),
                idempotency_key: attempt.key,
              }
            : { outcome, resolution: said },
          pin,
        );
        onResolved();
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(undefined);
      }
    })();
  }

  return (
    <div className="panel">
      <div className="row-between">
        <div>
          <strong>{REASONS[dispute.reason] ?? dispute.reason}</strong>{' '}
          {dispute.overdue && <span className="badge danger">overdue</span>}
        </div>
        {/*
          "due 3d" is ambiguous where "due in 3d" and "overdue by 3d" are not,
          and the two mean opposite things to somebody deciding what to work
          next. `overdue` comes from the VIEW rather than from comparing the
          deadline to this browser's clock — 018 makes the deadline the
          database's, and a laptop with a wrong date must not be able to make
          a missed one look answered.
        */}
        <span className="hint">
          raised {ageSince(dispute.raised_at)} ago ·{' '}
          {dispute.overdue
            ? `overdue by ${ageSince(dispute.due_at)}`
            : `due ${ageSince(dispute.due_at)}`}
        </span>
      </div>

      <p className="hint">
        {dispute.email ?? 'account unknown'} · {dispute.entry_kind.replace(/_/g, ' ')}
      </p>

      {/* The customer's own words. Escaped by React, and shown in full: a
          reviewer deciding whether to pay out reads what was actually said. */}
      <p>{dispute.detail}</p>

      <label>
        <span>What you decided, and why</span>
        <textarea
          rows={3}
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          placeholder="The reason is the only part a regulator can inspect."
        />
      </label>

      <label>
        <span>Refund, in major units — only if you uphold it</span>
        <input
          inputMode="decimal"
          autoComplete="off"
          value={refund}
          onChange={(e) => setRefund(e.target.value)}
          placeholder="5000.00"
        />
      </label>

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
        <button type="button" className="small" disabled={!canAccept} onClick={() => resolve('accepted')}>
          {busy === 'accepted' ? 'Refunding…' : 'Uphold and refund'}
        </button>
        <button
          type="button"
          className="small ghost"
          disabled={!canReject}
          onClick={() => resolve('rejected')}
        >
          {busy === 'rejected' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>

      {said !== '' && said.length < 10 && (
        <p className="hint">Say a little more — this is the record of the decision.</p>
      )}
      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * `dispute_reason`, in words. A reviewer should not have to read the migration.
 *
 * FOUR, because the enum has four. A fifth entry here would describe a value
 * the database cannot hold — the same reason `route-coverage.test.ts` checks
 * both directions — and the fallback below renders an unmapped value verbatim
 * rather than swallowing it, so a reason added to 018 and not to this file
 * shows up as itself instead of as a blank.
 */
const REASONS: Readonly<Record<string, string>> = {
  not_authorised: 'Says somebody else did this',
  not_received: 'Says they paid and nothing arrived',
  wrong_amount: 'Says this is not the amount agreed',
  duplicate: 'Says they were charged twice for one thing',
};
