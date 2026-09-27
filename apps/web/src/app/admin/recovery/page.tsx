'use client';

import { Fragment, useState } from 'react';
import { formatMinor } from '@xetral/client';
import type { AdminHeldMoney, AdminRecoveryOutcome, AdminRefundAudit } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { ago } from '../age';
import { Kpis, MoneyFigure, shortRef } from '../queue';

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
 * arbitrary customer an arbitrary sum.
 *
 * AND THE BUTTON NO LONGER GIVES ANYTHING BACK ON A PERSON'S WORD. It was
 * "Reverse", and it reversed — including the owner's own payout, delivered
 * to their own bank, whose send had merely answered in a shape we could not
 * read. That is the business paying twice with every entry balanced. The
 * button now ASKS THE PROVIDER: delivered settles it, failed gives it back,
 * and "cannot say" moves nothing. A person who has SEEN a transfer arrive on
 * the provider's dashboard can record it as delivered — the one direction a
 * person may decide on their own, because it gives nothing away.
 */
export default function Recovery() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.recoveryQueue(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const [said, setSaid] = useState<AdminRecoveryOutcome | undefined>();

  const waiting = queue.data?.waiting ?? [];
  const recovered = queue.data?.recovered ?? [];
  const summary = queue.data?.summary;

  const reload = (outcome?: AdminRecoveryOutcome): void => {
    setSaid(outcome);
    setOpen(undefined);
    queue.reload();
  };

  return (
    <>
      <AdminTitle>Recovery</AdminTitle>
      <Kpis
        items={[
          { label: 'Stuck payouts', count: summary?.stuck, tone: 'danger' },
          {
            label: 'Value stuck',
            value: summary === undefined ? undefined : <MoneyFigure totals={summary.held} />,
          },
          {
            label: 'Recovered · 7d',
            value: summary === undefined ? undefined : <MoneyFigure totals={summary.recovered_7d} />,
          },
        ]}
      />

      {said !== undefined && (
        <div className={`notice${said.outcome === 'held' ? ' warn' : ''}`} role="status">
          <p>
            <strong>
              {said.outcome === 'reversed'
                ? 'Given back.'
                : said.outcome === 'delivered'
                  ? 'Delivered — nothing given back.'
                  : 'Still held — nothing moved.'}
            </strong>{' '}
            {said.detail}
          </p>
        </div>
      )}

      <div className="panel tbl-panel">
        <span className="tbl-note">
          Money that left a wallet and has not been confirmed either way. Resolve
          asks the provider; money goes back only if they say it failed.
        </span>
        <AdminError error={queue.error} code={queue.code} role="support" />
        {queue.loading && <p className="spinner">Loading…</p>}
        {queue.data !== undefined && waiting.length === 0 && (
          <p className="empty">Nothing is held. Every reservation has resolved.</p>
        )}

        {waiting.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th className="r">Amount</th>
                  <th>Rail</th>
                  {/* HELD, not "failed": a timeout settles nothing, and the
                      money may still be on its way — 043's rule. */}
                  <th>Held</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {waiting.map((row) => {
                  const key = `${row.kind}:${row.subject_uuid}`;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td className="ref">
                          {shortRef(row.kind === 'bank_payout' ? 'PO' : 'PU', row.subject_uuid)}
                        </td>
                        <td>{row.name ?? row.email ?? `customer ${row.user_id}`}</td>
                        <td className="r amount soft">{formatMinor(row.amount_minor, row.currency)}</td>
                        <td className="quiet">{railOf(row)}</td>
                        <td className={row.hours_held >= 24 ? 'alarm' : 'quiet'}>
                          {heldFor(row.hours_held)}
                        </td>
                        <td className="r">
                          <button
                            type="button"
                            className={open === key ? 'ghost' : undefined}
                            aria-expanded={open === key}
                            onClick={() => setOpen(open === key ? undefined : key)}
                          >
                            {open === key ? 'Close' : 'Resolve'}
                          </button>
                        </td>
                      </tr>
                      {open === key && (
                        <tr className="detail">
                          <td colSpan={6}>
                            <Held row={row} onDone={reload} />
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

      <RefundAuditPanel />

      {recovered.length > 0 && (
        <div className="panel tbl-panel">
          <span className="tbl-note">
            Already given back. Append-only — a mistake here is corrected by a
            further entry, the same rule the ledger follows.
          </span>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>What</th>
                  <th className="r">Amount</th>
                  <th>Who did it</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {recovered.map((row) => (
                  <tr key={row.uuid}>
                    <td className="quiet nowrap">{ago(row.created_at)}</td>
                    <td>{row.email ?? '—'}</td>
                    <td className="quiet">{row.kind === 'bank_payout' ? 'Bank transfer' : 'Purchase'}</td>
                    <td className="r amount soft">{formatMinor(row.amount_minor, row.currency)}</td>
                    <td className="quiet">{row.actioned_by ?? '—'}</td>
                    <td className="quiet">{row.reason}</td>
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
 * The rail, as the comp names it — "GTBank", "MTN MoMo" — and never the full
 * account number in a table that sits on an operator's screen all day. The
 * whole destination is in the opened row, where somebody is checking it.
 */
function railOf(row: AdminHeldMoney): string {
  if (row.kind === 'purchase') return row.destination;
  const match = /^(.*?)\s+([0-9]{4,})$/.exec(row.destination);
  return match === null ? row.destination : `${match[1]} ··${match[2]?.slice(-4)}`;
}

function heldFor(hours: number): string {
  const whole = Math.floor(hours);
  if (whole < 1) return 'under 1h';
  return whole < 48 ? `${whole}h` : `${Math.floor(whole / 24)}d`;
}

/**
 * One held row: ask the provider, or record what you saw on their dashboard.
 *
 * The age is shown as hours because that is the question being asked: a
 * payout held for twenty minutes is a provider taking its time, and one held
 * for three days is one nobody is coming back to answer for.
 */
function Held({ row, onDone }: { row: AdminHeldMoney; onDone: (said: AdminRecoveryOutcome) => void }) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [transferId, setTransferId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const hours = Math.floor(row.hours_held);
  const age =
    hours < 1 ? 'under an hour' : hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;

  const act = (work: () => Promise<AdminRecoveryOutcome>): void => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        const said = await work();
        setPin('');
        onDone(said);
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const ready = reason.trim().length >= 8 && pin !== '' && !busy;

  return (
    <form
      className="review-grid"
      onSubmit={(event) => {
        event.preventDefault();
        act(() => admin.recover(row.kind, row.subject_uuid, reason, pin));
      }}
    >
      <div>
        <p>
          <strong>{formatMinor(row.amount_minor, row.currency)}</strong>{' '}
          <span className="hint">
            {row.email ?? `customer ${row.user_id}`} ·{' '}
            {row.kind === 'bank_payout' ? 'bank transfer' : 'purchase'} · held {age}
          </span>
        </p>
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
          <span className="muted">State here</span>
          <span>{row.status}</span>
        </div>
      </div>

      <div>
        <label>
          What you are doing, and why
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={8}
            maxLength={500}
          />
          <span className="hint">
            Kept on the record with your name. The provider decides the outcome, not this box.
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

        <button type="submit" disabled={!ready}>
          {busy ? 'Asking the provider…' : 'Ask the provider and resolve'}
        </button>
        <span className="hint">
          Delivered: settled, nothing given back. Failed: given back to the
          customer. No answer: nothing moves.
        </span>

        {row.kind === 'bank_payout' && (
          <>
            <label>
              Seen it arrive? Provider transfer id
              <input
                value={transferId}
                onChange={(e) => setTransferId(e.target.value)}
                placeholder="e.g. TRF_1ptvuv321ahaa7q"
                autoComplete="off"
              />
              <span className="hint">
                From the provider&rsquo;s own dashboard. Records it as delivered and gives nothing back.
              </span>
            </label>
            <button
              type="button"
              className="ghost"
              disabled={!ready || transferId.trim().length < 2}
              onClick={() =>
                act(() => admin.markPayoutDelivered(row.subject_uuid, transferId.trim(), reason, pin))
              }
            >
              Mark as delivered
            </button>
          </>
        )}

        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

/**
 * EVERY PAYOUT WE GAVE BACK, ASKED AGAIN.
 *
 * Before the provider was asked first, this screen's own button — and the
 * sweep, on any refused status question — could give back a payout that had
 * arrived. A reversal of a delivered transfer balances exactly like one of a
 * failed transfer, so nothing in the ledger can find them; only the provider
 * can. On demand rather than on load, because it asks a provider per row.
 */
function RefundAuditPanel() {
  const admin = useAdmin();
  const [audit, setAudit] = useState<AdminRefundAudit | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="panel tbl-panel">
      <span className="tbl-note">
        Payouts already given back, checked against the provider. Any listed
        here were paid to the beneficiary AND refunded to the customer.
      </span>
      <div className="tbl-actions">
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void admin
              .recoveryAudit()
              .then(setAudit, (cause: unknown) => setError(messageFor(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Checking with providers…' : 'Check refunded payouts'}
        </button>
      </div>
      {error !== undefined && <p className="error">{error}</p>}
      {audit !== undefined && (
        <p className={audit.paid_twice.length > 0 ? 'error' : 'ok'}>
          {audit.paid_twice.length > 0
            ? `${audit.paid_twice.length} of ${audit.checked} refunded payouts were also paid.`
            : `None of ${audit.checked} refunded payouts was also paid.`}
          {audit.unconfirmed > 0 && ` ${audit.unconfirmed} could not be confirmed with the provider.`}
        </p>
      )}
      {audit !== undefined && audit.paid_twice.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th className="r">Given back</th>
                <th>Destination</th>
                <th>Rail</th>
              </tr>
            </thead>
            <tbody>
              {audit.paid_twice.map((row) => (
                <tr key={row.subject_uuid}>
                  <td className="ref mono">{row.reference}</td>
                  <td>{row.email ?? '—'}</td>
                  <td className="r amount soft">{formatMinor(row.amount_minor, row.currency)}</td>
                  <td className="quiet">{row.destination}</td>
                  <td className="quiet">{row.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
