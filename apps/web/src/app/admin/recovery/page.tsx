'use client';

import { Fragment, useState } from 'react';
import { formatMinor } from '@xetral/client';
import type { AdminHeldMoney } from '@xetral/client';
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
 * arbitrary customer an arbitrary sum — the worst it can do is give somebody
 * back exactly what was taken from them. What it takes instead is a reason,
 * which is the part a reviewer reads afterwards.
 */
export default function Recovery() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.recoveryQueue(), [admin]);
  const [open, setOpen] = useState<string | undefined>();

  const waiting = queue.data?.waiting ?? [];
  const recovered = queue.data?.recovered ?? [];
  const summary = queue.data?.summary;

  const reload = (): void => {
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

      <div className="panel tbl-panel">
        <span className="tbl-note">
          Money that left a wallet and did not arrive — the mirror of Suspense.
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
                            {open === key ? 'Close' : 'Reverse'}
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
      className="review-grid"
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
          <span className="muted">State at the provider</span>
          <span>{row.status}</span>
        </div>
      </div>

      <div>
        <label>
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
      </div>
    </form>
  );
}
