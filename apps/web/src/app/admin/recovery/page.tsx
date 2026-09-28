'use client';

import { Fragment, useEffect, useState } from 'react';
import { formatMinor } from '@xetral/client';
import type {
  AdminRecoveryAction,
  AdminRecoveryDetail,
  AdminRecoveryItem,
  AdminRecoveryOutcome,
  AdminRecoveryState,
} from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { AdminTitle, QUEUES_CHANGED } from '@/app/admin/nav';
import { ago } from '../age';
import { Kpis, MoneyFigure, shortRef } from '../queue';

/**
 * Money that left a customer's balance and has not been confirmed either way.
 *
 * ONE LIST. It was three sections — held, refunded-but-paid, already given
 * back — and an operator had to read all three to answer one question about
 * one transfer. Every row now says which of three states it is in, and opens
 * in place to show the rest.
 *
 * A PROVIDER'S ANSWER CLOSES A ROW WITHOUT A PERSON. The webhook, the sweep
 * and loading this list all ask; delivered is settled and failed is given
 * back. So what a person sees is what no provider has answered for in half an
 * hour — and a delivered payout never reaches somebody holding a refund
 * button, which is how the owner's own ₦10 was once refunded after it had
 * arrived.
 *
 * THE AMOUNT IS NOT ON THIS FORM. It comes from the held row on the server,
 * so this screen cannot credit an arbitrary customer an arbitrary sum.
 */
export default function Recovery() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.recoveryQueue(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const [said, setSaid] = useState<AdminRecoveryOutcome | undefined>();

  const items = [...(queue.data?.items ?? [])].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const summary = queue.data?.summary;
  const review = items.filter((i) => i.state === 'needs_review').length;
  const stuck = items.filter((i) => i.state === 'stuck').length;
  /*
   * THE COUNTS ARE FOR WHEN SOMETHING IS WRONG. With nothing stuck and
   * nothing to review there is nothing to count, and a row of zeros over an
   * empty list read as four problems waiting to be found.
   */
  const attention = stuck + review > 0;

  // Loading this list closes what providers answer for, so the sidebar's
  // count is re-read the moment it arrives.
  useEffect(() => {
    if (queue.data !== undefined) window.dispatchEvent(new Event(QUEUES_CHANGED));
  }, [queue.data]);

  const done = (outcome: AdminRecoveryOutcome): void => {
    setSaid(outcome);
    setOpen(undefined);
    queue.reload();
  };

  return (
    <>
      <AdminTitle>Recovery</AdminTitle>
      {attention && (
      <Kpis
        items={[
          { label: 'Stuck', count: stuck, tone: 'warn' },
          { label: 'Needs review', count: review, tone: 'danger' },
          {
            label: 'Value held',
            value: summary === undefined ? undefined : <MoneyFigure totals={summary.held} />,
          },
          {
            label: 'Refunded · 7d',
            value: summary === undefined ? undefined : <MoneyFigure totals={summary.recovered_7d} />,
          },
        ]}
      />
      )}

      {said !== undefined && (
        <div className={`notice${said.outcome === 'held' ? ' warn' : ''}`} role="status">
          <p>
            <strong>
              {said.outcome === 'reversed'
                ? 'Refunded.'
                : said.outcome === 'delivered'
                  ? 'Resolved — delivered.'
                  : 'Still held — nothing moved.'}
            </strong>{' '}
            {said.detail}
          </p>
        </div>
      )}

      <div className="panel tbl-panel">
        <AdminError error={queue.error} code={queue.code} role="support" />
        {queue.loading && queue.data === undefined && <p className="spinner">Asking providers…</p>}
        {queue.data !== undefined && items.length === 0 && (
          <p className="empty">Nothing needs attention.</p>
        )}

        {queue.data !== undefined && !attention && items.length > 0 && (
          <p className="empty">Nothing needs attention. Closed this week:</p>
        )}
        {items.length > 0 && (
          <div className="scroll">
            <table className="rec-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                  <th className="r">When</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const key = `${item.state}:${item.kind}:${item.subject_uuid}`;
                  const expanded = open === key;
                  const toggle = (): void => setOpen(expanded ? undefined : key);
                  return (
                    <Fragment key={key}>
                      <tr
                        className={expanded ? 'rec-row open' : 'rec-row'}
                        tabIndex={0}
                        aria-expanded={expanded}
                        onClick={toggle}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggle();
                          }
                        }}
                      >
                        <td className="ref">
                          {shortRef(item.kind === 'bank_payout' ? 'PO' : 'PU', item.subject_uuid)}
                        </td>
                        <td>
                          <span className="rec-who">{item.name ?? item.email ?? '—'}</span>
                          {item.name !== null && item.email !== null && (
                            <span className="rec-sub">{item.email}</span>
                          )}
                        </td>
                        <td className="r amount soft">{formatMinor(item.amount_minor, item.currency)}</td>
                        <td>
                          <span className={`badge ${TONE[item.state]}`}>{LABEL[item.state]}</span>
                        </td>
                        <td className="r quiet nowrap">{ago(item.resolved_at ?? item.created_at)}</td>
                      </tr>
                      {expanded && (
                        <tr className="detail">
                          <td colSpan={5}>
                            <Opened item={item} onDone={done} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const ORDER: Record<AdminRecoveryState, number> = { needs_review: 0, stuck: 1, resolved: 2 };
const LABEL: Record<AdminRecoveryState, string> = {
  stuck: 'Stuck',
  needs_review: 'Needs review',
  resolved: 'Resolved',
};
const TONE: Record<AdminRecoveryState, string> = { stuck: 'warn', needs_review: 'danger', resolved: 'ok' };

const VERDICT: Record<AdminRecoveryDetail['provider_status']['verdict'], { label: string; tone: string }> = {
  delivered: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  not_found: { label: 'Not found', tone: 'warn' },
  pending: { label: 'Pending', tone: 'info' },
  unknown: { label: 'No answer', tone: 'warn' },
};

const ACTION_LABEL: Record<AdminRecoveryAction, string> = {
  mark_resolved: 'Mark resolved',
  refund: 'Refund to customer’s wallet',
  send: 'Send to recipient',
  mark_delivered: 'Mark delivered',
};

/**
 * One row, opened. The provider is asked on opening — never trusted from
 * whatever the list said a minute ago — and the buttons offered follow its
 * answer, the first being the default. Every press is recorded with the
 * person and the reason, and that record is the history at the bottom.
 */
function Opened({ item, onDone }: { item: AdminRecoveryItem; onDone: (said: AdminRecoveryOutcome) => void }) {
  const admin = useAdmin();
  const [detail, setDetail] = useState<AdminRecoveryDetail | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [transferId, setTransferId] = useState('');
  const [busy, setBusy] = useState<AdminRecoveryAction | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    admin.recoveryDetail(item.kind, item.subject_uuid).then(
      (found) => live && setDetail(found),
      (cause: unknown) => live && setLoadError(messageFor(cause)),
    );
    return () => {
      live = false;
    };
  }, [admin, item.kind, item.subject_uuid]);

  const run = (action: AdminRecoveryAction): void => {
    const work = (): Promise<AdminRecoveryOutcome> => {
      switch (action) {
        case 'mark_resolved':
          return admin.recover(item.kind, item.subject_uuid, reason, pin);
        case 'refund':
          return admin.refundHeld(item.kind, item.subject_uuid, reason, pin);
        case 'send':
          return admin.resendPayout(item.subject_uuid, reason, pin);
        case 'mark_delivered':
          return admin.markPayoutDelivered(item.subject_uuid, transferId.trim(), reason, pin);
      }
    };
    setBusy(action);
    setError(undefined);
    void work().then(
      (said) => {
        setPin('');
        onDone(said);
      },
      (cause: unknown) => setError(messageFor(cause)),
    ).finally(() => setBusy(undefined));
  };

  if (loadError !== undefined) return <p className="error">{loadError}</p>;
  if (detail === undefined) return <p className="spinner">Asking the provider…</p>;

  const verdict = VERDICT[detail.provider_status.verdict];
  const ready = reason.trim().length >= 8 && pin !== '' && busy === undefined;
  const [first, ...rest] = detail.actions;
  // A DEFAULT ONLY WHERE THE PROVIDER GAVE ONE. With no answer every button
  // is a person's judgement, so none of them is drawn as the obvious one.
  const primary = detail.provider_status.verdict !== 'unknown';

  return (
    <div className="review-grid">
      <div>
        <div className="rec-verdict">
          <span className="muted">Provider says</span>
          <span className={`badge ${verdict.tone}`}>{verdict.label}</span>
        </div>
        <p className="hint">{detail.provider_status.detail}</p>
        <div className="row"><span className="muted">Amount</span><span>{formatMinor(detail.amount_minor, detail.currency)}</span></div>
        <div className="row"><span className="muted">Going to</span><span>{detail.destination}</span></div>
        {detail.provider !== null && (
          <div className="row"><span className="muted">Rail</span><span>{detail.provider}</span></div>
        )}
        <div className="row"><span className="muted">Reference</span><span className="mono">{detail.reference}</span></div>
        <div className="row"><span className="muted">Started</span><span>{new Date(detail.created_at).toLocaleString()}</span></div>
        <div className="row"><span className="muted">State here</span><span>{detail.status}</span></div>
        {detail.failure_reason !== null && (
          <div className="row"><span className="muted">Last error</span><span>{detail.failure_reason}</span></div>
        )}

        <h4 className="rec-h">History</h4>
        {detail.history.length === 0 ? (
          <p className="hint">Nobody has acted on this yet.</p>
        ) : (
          <ol className="rec-history">
            {detail.history.map((entry, index) => (
              <li key={`${entry.at}:${index}`}>
                <span className="rec-when">{ago(entry.at)}</span>
                <span>
                  <strong>{entry.what}</strong>
                  {entry.who !== null && <> · {entry.who}</>}
                  {entry.reason !== null && <span className="rec-sub">{entry.reason}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div>
        {first === undefined ? (
          <p className="hint">
            {item.state === 'needs_review'
              ? 'Already refunded, and the provider says it was also paid. Recovering it is a conversation with the customer, not a button.'
              : 'Closed. Nothing left to do.'}
          </p>
        ) : (
          <>
            <label>
              Reason
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={8}
                maxLength={500}
              />
            </label>
            {detail.actions.includes('mark_delivered') && (
              <label>
                Provider transfer id <span className="hint">(only for Mark delivered)</span>
                <input
                  value={transferId}
                  onChange={(e) => setTransferId(e.target.value)}
                  placeholder="e.g. TRF_1ptvuv321ahaa7q"
                  autoComplete="off"
                />
              </label>
            )}
            <label>
              Transaction PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </label>
            <div className="rec-actions">
              <button
                type="button"
                className={primary ? undefined : 'ghost'}
                disabled={!ready || (first === 'mark_delivered' && transferId.trim().length < 2)}
                onClick={() => run(first)}
              >
                {busy === first ? 'Working…' : ACTION_LABEL[first]}
              </button>
              {rest.map((action) => (
                <button
                  key={action}
                  type="button"
                  className="ghost"
                  disabled={!ready || (action === 'mark_delivered' && transferId.trim().length < 2)}
                  onClick={() => run(action)}
                >
                  {busy === action ? 'Working…' : ACTION_LABEL[action]}
                </button>
              ))}
            </div>
          </>
        )}
        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
