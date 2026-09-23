'use client';

import { Fragment, useState } from 'react';
import { formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { ageSince } from '../age';
import { Kpis, MoneyFigure } from '../queue';
import { AdminTitle } from '@/app/admin/nav';

/**
 * Money that arrived and that we could not say belonged to anyone — the
 * comp's screen: three figures, then one table with Attribute on each row.
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

interface SuspenseDeposit {
  readonly deposit_uuid: string;
  readonly provider: string;
  readonly provider_reference: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly sender_name: string | null;
  readonly sender_bank: string | null;
  readonly suspense_reason: string | null;
  readonly created_at: string;
  readonly unresolved_for: string;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  flutterwave: 'Flutterwave',
  paystack: 'Paystack',
  bitnob: 'Bitnob',
};

/** Totals per currency — never summed across them. */
function held(rows: readonly SuspenseDeposit[]): { currency: string; amount_minor: string }[] {
  const by = new Map<string, bigint>();
  for (const row of rows) by.set(row.currency, (by.get(row.currency) ?? 0n) + BigInt(row.amount_minor));
  return [...by.entries()]
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
    .map(([currency, amount]) => ({ currency, amount_minor: amount.toString() }));
}

export default function Suspense() {
  const admin = useAdmin();
  const deposits = useLoad(() => admin.suspense(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const rows: readonly SuspenseDeposit[] = deposits.data ?? [];
  const oldest = rows.reduce<string | undefined>(
    (min, row) => (min === undefined || row.created_at < min ? row.created_at : min),
    undefined,
  );

  return (
    <>
      <AdminTitle>Suspense</AdminTitle>
      <Kpis
        items={[
          { label: 'Unattributed credits', count: deposits.data === undefined ? undefined : rows.length, tone: 'warn' },
          { label: 'Held in suspense', value: deposits.data === undefined ? undefined : <MoneyFigure totals={held(rows)} /> },
          { label: 'Oldest', value: deposits.data === undefined ? undefined : oldest === undefined ? '—' : ageSince(oldest) },
        ]}
      />

      <div className="panel tbl-panel">
        <AdminError error={deposits.error} code={deposits.code} role="finance" />
        {deposits.loading && <p className="spinner">Loading…</p>}
        {!deposits.loading && deposits.error === undefined && rows.length === 0 && (
          <p className="empty">Nothing in suspense.</p>
        )}

        {rows.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Provider</th>
                  <th className="r">Amount</th>
                  <th>Received</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {rows.map((deposit) => (
                  <Fragment key={deposit.deposit_uuid}>
                    <tr>
                      <td className="ref">{deposit.provider_reference}</td>
                      <td>
                        {PROVIDER_NAMES[deposit.provider] ?? deposit.provider}
                        <div className="cell-sub">{deposit.suspense_reason ?? 'no matching account'}</div>
                      </td>
                      <td className="r mono soft">{formatMinor(deposit.amount_minor, deposit.currency)}</td>
                      <td className="quiet">{ageSince(deposit.created_at)} ago</td>
                      <td className="r">
                        <button
                          type="button"
                          className={open === deposit.deposit_uuid ? 'ghost' : undefined}
                          aria-expanded={open === deposit.deposit_uuid}
                          onClick={() =>
                            setOpen(open === deposit.deposit_uuid ? undefined : deposit.deposit_uuid)
                          }
                        >
                          {open === deposit.deposit_uuid ? 'Close' : 'Attribute'}
                        </button>
                      </td>
                    </tr>
                    {open === deposit.deposit_uuid && (
                      <tr className="detail">
                        <td colSpan={5}>
                          <Attribute
                            deposit={deposit}
                            onDone={() => {
                              setOpen(undefined);
                              deposits.reload();
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

function Attribute({ deposit, onDone }: { readonly deposit: SuspenseDeposit; readonly onDone: () => void }) {
  const admin = useAdmin();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ready = userId.trim() !== '' && reason.trim().length >= 3 && pin !== '' && !busy;

  return (
    <form
      className="review-grid"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        void (async () => {
          try {
            await admin.attributeDeposit(deposit.deposit_uuid, userId.trim(), reason.trim(), pin);
            onDone();
          } catch (cause) {
            setError(messageFor(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <dl className="facts">
        <dt>From</dt>
        <dd>
          {deposit.sender_name ?? 'an unnamed sender'}
          {deposit.sender_bank !== null && ` · ${deposit.sender_bank}`}
        </dd>
        <dt>Why it is here</dt>
        <dd>{deposit.suspense_reason ?? 'no matching account'}</dd>
        <dt>Arrived</dt>
        <dd>{new Date(deposit.created_at).toLocaleString('en-GB')}</dd>
        <dt>Held for</dt>
        <dd>{deposit.unresolved_for}</dd>
      </dl>

      <div>
        <div className="field-row two">
          <label>
            <span>Customer id</span>
            <input
              className="mono"
              placeholder="from their Customers page"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
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
        </div>
        <label>
          <span>What you checked</span>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The record somebody reads if it turns out to be wrong."
          />
        </label>
        <div className="actions">
          <button type="submit" className="small" disabled={!ready}>
            {busy ? 'Crediting…' : `Credit ${formatMinor(deposit.amount_minor, deposit.currency)}`}
          </button>
        </div>
        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </form>
  );
}
