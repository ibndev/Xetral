'use client';

import Link from 'next/link';
import { formatAmount, formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from './access';

/**
 * The morning screen.
 *
 * Ordered by what would hurt most if it were wrong. LEDGER DRIFT is first and
 * is red when non-empty, because it is the only figure on this page that means
 * the books disagree with themselves — and until it is empty, nothing else
 * here is trustworthy. Then the work queues, then what we owe.
 */
export default function Overview() {
  const admin = useAdmin();
  const overview = useLoad(() => admin.overview(), [admin]);
  const drift = useLoad(() => admin.drift(), [admin]);
  const stuck = useLoad(() => admin.stuck(), [admin]);

  const drifted = drift.data ?? [];
  const queues = overview.data?.queues ?? [];
  const waiting = queues.filter((q) => Number(q.waiting) > 0);
  const liability = overview.data?.liability ?? [];

  return (
    <>
      {/*
        A drift check that cannot alarm is not a check. This is deliberately
        the first thing on the page and deliberately loud: a non-empty result
        means a materialised balance disagrees with the sum of its own
        postings, which is either a trigger that did not fire or something that
        wrote around the ledger.
      */}
      {drifted.length > 0 && (
        <div className="notice danger">
          <p>
            <strong>{drifted.length} account(s) have drifted.</strong> A
            materialised balance disagrees with the sum of its own postings.
          </p>
          <p className="hint">
            Investigate this before acting on anything else here.
          </p>
        </div>
      )}

      <div className="panel">
        <h1>Overview</h1>
        <h2>What needs a person today</h2>

        <div className="stats">
          <div className={drifted.length > 0 ? 'stat alarm' : 'stat'}>
            <div className="label">Ledger drift</div>
            <div className="value">{drift.loading ? '—' : drifted.length}</div>
          </div>
          <div className="stat">
            <div className="label">Entries, last 24h</div>
            <div className="value">{overview.data?.activity.entries_24h ?? '—'}</div>
          </div>
          <div className="stat">
            <div className="label">Entries, last hour</div>
            <div className="value">{overview.data?.activity.entries_1h ?? '—'}</div>
          </div>
          <div className="stat">
            <div className="label">Held purchases</div>
            <div className="value">{stuck.data?.purchases.length ?? '—'}</div>
          </div>
        </div>

        <AdminError error={overview.error} code={overview.code} role="support" />
      </div>

      <div className="panel">
        <h2>Work queues</h2>
        {/*
          WAITING FIRST, and zeros kept rather than hidden.

          This view named five sources until 036 and now names twenty-two, so
          the risk changed: a wall of zeros is a list people learn to skim, and
          skimming is how the one row that mattered gets missed. Sorting by
          what is waiting puts the work at the top; keeping the empty rows
          visible below is what says the other queues were checked, which an
          absent row does not.
        */}
        {overview.loading && <p className="spinner">Loading…</p>}

        {waiting.length === 0 && queues.length > 0 && (
          <p className="empty">
            All {queues.length} queues are empty.
          </p>
        )}

        {queues.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Queue</th>
                  <th className="right">Waiting</th>
                  <th className="right">Oldest</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...queues]
                  .sort((a, b) => Number(b.waiting) - Number(a.waiting))
                  .map((queue) => {
                    const href = queueLink(queue.queue);
                    const idle = Number(queue.waiting) === 0;
                    return (
                      <tr key={queue.queue} className={idle ? 'muted' : undefined}>
                        <td>{queue.queue.replace(/_/g, ' ')}</td>
                        <td className="right amount">{queue.waiting}</td>
                        <td className="right muted">
                          {queue.oldest === null
                            ? '—'
                            : new Date(queue.oldest).toLocaleString()}
                        </td>
                        <td className="right">
                          {href !== undefined && !idle && <Link href={href}>Open</Link>}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>What we owe customers</h2>
        <p className="lead">
          Computed from postings, not from a reported figure. This is the
          liability side of the ledger.
        </p>

        {liability.length === 0 && !overview.loading && (
          <p className="empty">No balances yet.</p>
        )}

        {liability.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th className="right">Wallets</th>
                  <th className="right">Held</th>
                  <th className="right">On cards</th>
                  <th className="right">Suspense</th>
                  <th className="right">Total owed</th>
                </tr>
              </thead>
              <tbody>
                {liability.map((row) => (
                  <tr key={row.currency}>
                    <td>{row.currency}</td>
                    <td className="right amount">
                      {formatMinor(row.wallets_minor, row.currency)}
                    </td>
                    <td className="right amount">
                      {formatMinor(row.pending_minor, row.currency)}
                    </td>
                    <td className="right amount">
                      {formatMinor(row.cards_minor, row.currency)}
                    </td>
                    <td className="right amount">
                      {formatMinor(row.suspense_minor, row.currency)}
                    </td>
                    <td className="right amount">
                      <strong>{formatAmount(row.total_owed, row.currency)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Where a queue is worked.
 *
 * Written out rather than matched on substrings. The old version tested for
 * 'kyc', 'suspense' and 'giftcard' and sent everything else to /admin — which
 * was invisible while the overview showed five queues and would now send
 * eighteen of twenty-two rows to a page that cannot help.
 *
 * A queue with no screen returns undefined and renders no link, which is the
 * honest answer: some of these are read in the database, and pretending
 * otherwise wastes somebody's click during an incident.
 */
const QUEUE_SCREENS: Readonly<Record<string, string>> = {
  kyc: '/admin/kyc',
  bvn_collisions: '/admin/kyc',
  suspense: '/admin/suspense',
  giftcard_review: '/admin/giftcards',
  giftcard_holds_due: '/admin/giftcards',
  risk_signals: '/admin/risk',
  risk_cases: '/admin/risk/cases',
  consent: '/admin/consents',
  data_requests: '/admin/data-requests',
  errors: '/admin/errors',
  prices_unattributed: '/admin/prices',
  staff_without_totp: '/admin/staff',
  provider_degraded: '/admin/providers',
};

function queueLink(queue: string): string | undefined {
  return QUEUE_SCREENS[queue];
}


/*
 * Minor units to a major-unit string, WITHOUT going through a number, lives in
 * `formatMinor` in the client package.
 *
 * The API sends `total_owed` already formatted for exactly this reason, and
 * these four component columns arrive as minor units because no endpoint had a
 * reason to format them. This file used to carry its own copy of the
 * conversion, with its own exponent table — which is how two copies drift, and
 * the one that drifts is the one nobody reads closely.
 */
