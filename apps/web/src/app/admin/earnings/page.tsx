'use client';

import Link from 'next/link';
import { formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';

/**
 * WHAT THE PLATFORM HAS EARNED, and why it might be nothing.
 *
 * `revenue_fees` and `revenue_fx_spread` have been in `001_ledger.sql` since
 * Phase 1 and every flow posts to them correctly. What was missing is that
 * NOTHING SHOWED EITHER FIGURE — so a business could run for a month without
 * anybody being able to say what it had made, and, worse, could not tell the
 * difference between two very different situations that look identical from
 * every other screen:
 *
 *   - it is earning nothing because the fee is 0 basis points, which is what
 *     ships and is a decision somebody has to make rather than inherit; and
 *   - it is earning nothing because something is broken.
 *
 * So the two settings that decide the answer are shown beside the figures
 * rather than a link away on another screen.
 */
export default function Earnings() {
  const admin = useAdmin();
  const report = useLoad(() => admin.earnings(), [admin]);

  const feeBps = report.data?.transfer_fee_basis_points ?? 0;
  const pairs = report.data?.published_pairs ?? [];
  const lines = report.data?.lines ?? [];

  return (
    <>
      <div className="panel">
        <h1>Earnings</h1>
        <h2>Fees and FX spread, from the ledger</h2>
        <p className="lead">
          Measured from the revenue accounts themselves, not from a counter —
          so this is what the books say, in every currency the platform has
          ever earned in.
        </p>
        <AdminError error={report.error} code={report.code} role="finance" />
        {report.loading && <p className="spinner">Loading…</p>}
        {report.data !== undefined && lines.length === 0 && (
          <p className="empty">Nothing has been earned yet.</p>
        )}
      </div>

      {report.data !== undefined && (
        <>
          {/*
            THE TWO SETTINGS THAT DECIDE THE FIGURES, first, because a zero
            with no explanation beside it reads as a fault.
          */}
          <div className="panel">
            <h2>Why the figures are what they are</h2>

            <div className="row">
              <span className="muted">Transfer fee</span>
              <span>
                {feeBps === 0 ? (
                  <span className="badge warn">0 basis points — transfers are free</span>
                ) : (
                  <span className="mono">
                    {feeBps} bps ({(feeBps / 100).toFixed(2)}%)
                  </span>
                )}
              </span>
            </div>
            <p className="hint">
              It ships at zero deliberately: a fee nobody configured is money
              taken from a customer because of a default.{' '}
              <Link href="/admin/settings">Set it in Settings</Link> — it is a
              row, not a deploy, and it is capped at 500 basis points so a
              percentage typed where basis points were meant is refused.
            </p>

            <div className="row" style={{ marginTop: 14 }}>
              <span className="muted">FX pairs published</span>
              <span>
                {pairs.length === 0 ? (
                  <span className="badge warn">none — no conversion can happen</span>
                ) : (
                  <span className="mono">{pairs.length}</span>
                )}
              </span>
            </div>
            <p className="hint">
              An unpublished pair is refused rather than quoted from a default,
              so it earns nothing because it converts nothing. Each DIRECTION
              is its own policy — publishing NGN→USD says nothing about
              USD→NGN. <Link href="/admin/prices">Publish one in Prices</Link>.
            </p>

            {pairs.length > 0 && (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pair</th>
                      <th>Spread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pairs.map((p) => (
                      <tr key={`${p.base}-${p.quote}`}>
                        <td className="mono">
                          {p.base} → {p.quote}
                        </td>
                        <td className="mono">
                          {p.spread_basis_points} bps (
                          {(p.spread_basis_points / 100).toFixed(2)}%)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {lines.length > 0 && (
            <div className="panel">
              <h2>Earned, per currency</h2>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Currency</th>
                      <th>Fees</th>
                      <th>FX spread</th>
                      <th>Tax held</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.currency}>
                        <td className="mono">{line.currency}</td>
                        {/*
                          `formatMinor`, never `formatAmount`. The two look
                          identical at a call site and differ by a factor of a
                          hundred, and these views return `*_minor` — the
                          error the compliance queue shipped with.
                        */}
                        <td className="amount">
                          {formatMinor(line.fees_minor, line.currency)}
                        </td>
                        <td className="amount">
                          {formatMinor(line.fx_spread_minor, line.currency)}
                        </td>
                        <td className="amount muted">
                          {formatMinor(line.tax_payable_minor, line.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/*
                TAX IS NOT EARNINGS, and it is in this table only because
                leaving it out is how a fee figure gets read as including it.
              */}
              <p className="hint">
                Tax held is collected for a revenue authority and owed onward
                — a liability, not revenue. <Link href="/admin/tax">See Tax</Link>{' '}
                for what has been collected against what is still held.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}
