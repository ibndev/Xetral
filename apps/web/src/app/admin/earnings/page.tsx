'use client';

import Link from 'next/link';
import { compactMinor, formatMinor } from '@xetral/client';
import type { AdminRecentEarnings } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { Kpis } from '../queue';
import { change, smooth } from '../chart';

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
/** "₦6.4M" — the figure with its unit quieter, as the comp draws it. */
function Compact({ minor, currency }: { readonly minor: string; readonly currency: string }) {
  const c = compactMinor(minor, currency);
  return (
    <>
      {c.figure}
      {c.unit !== '' && <span className="unit">{c.unit}</span>}
    </>
  );
}

const sum = (...xs: readonly string[]): string => xs.reduce((a, x) => a + BigInt(x), 0n).toString();

/** Mon, Tue… for the seven Lagos days the series covers, today last. */
function dayLabels(): string[] {
  const out: string[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const d = new Date(Date.now() - back * 86_400_000);
    out.push(back === 0 ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Africa/Lagos' }));
  }
  return out;
}

function Week({ recent }: { readonly recent: AdminRecentEarnings }) {
  const values = recent.daily_minor.map((v) => BigInt(v));
  let top = 1n;
  for (const v of values) if (v > top) top = v;
  // GEOMETRY: each day reduced to 0–1000 before it becomes a coordinate.
  const points = values.map(
    (v, i) => [(i / Math.max(values.length - 1, 1)) * 640, 176 - (Number((v * 1000n) / top) / 1000) * 150] as const,
  );
  const line = smooth(points);
  const week = values.reduce((a, v) => a + v, 0n);
  const delta = change(week, BigInt(recent.previous_7d_minor));
  return (
    <div className="panel ov-chart">
      <div className="ov-head">
        <span className="sec">Earnings · last 7 days</span>
        {delta !== undefined && <span className={delta.up ? 'kchg up' : 'kchg down'}>{delta.text}</span>}
      </div>
      <svg viewBox="0 0 640 190" preserveAspectRatio="none" role="img" aria-label={`Earnings in ${recent.currency} over the last seven days`}>
        <defs>
          <linearGradient id="earn-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--ok)" stopOpacity=".28" />
            <stop offset="1" stopColor="var(--ok)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[46, 92, 138].map((y) => (
          <line key={y} x1="0" y1={y} x2="640" y2={y} className="grid" />
        ))}
        <path d={`${line} L640,190 L0,190 Z`} fill="url(#earn-area)" />
        <path d={line} className="ln ok" />
      </svg>
      <div className="ov-axis">
        {dayLabels().map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
    </div>
  );
}

export default function Earnings() {
  const admin = useAdmin();
  const report = useLoad(() => admin.earnings(), [admin]);

  const feeBps = report.data?.transfer_fee_basis_points ?? 0;
  const pairs = report.data?.published_pairs ?? [];
  const lines = report.data?.lines ?? [];
  // The currency that earned most this week is the headline; the API sorts
  // it first. Naira on a platform that has earned nothing yet.
  const lead: AdminRecentEarnings = report.data?.recent?.[0] ?? {
    currency: 'NGN',
    fees_24h_minor: '0',
    fx_spread_24h_minor: '0',
    fees_7d_minor: '0',
    fx_spread_7d_minor: '0',
    daily_minor: ['0', '0', '0', '0', '0', '0', '0'],
    previous_7d_minor: '0',
  };
  const loaded = report.data !== undefined;
  const c = lead.currency;

  return (
    <>
      <AdminTitle>Earnings</AdminTitle>
      <Kpis
        items={[
          { label: 'Earnings · 24h', value: loaded ? <Compact minor={sum(lead.fees_24h_minor, lead.fx_spread_24h_minor)} currency={c} /> : undefined },
          { label: 'Earnings · 7d', value: loaded ? <Compact minor={sum(lead.fees_7d_minor, lead.fx_spread_7d_minor)} currency={c} /> : undefined },
          { label: 'FX spread · 7d', value: loaded ? <Compact minor={lead.fx_spread_7d_minor} currency={c} /> : undefined },
          { label: 'Transfer fees · 7d', value: loaded ? <Compact minor={lead.fees_7d_minor} currency={c} /> : undefined },
        ]}
      />
      <AdminError error={report.error} code={report.code} role="finance" />
      {report.loading && <p className="spinner">Loading…</p>}

      {loaded && <Week recent={lead} />}

      {loaded && (
        <div className="grid two">
          {/*
            THE TWO SETTINGS THAT DECIDE THE FIGURES, beside them, because a
            zero with no explanation reads as a fault.
          */}
          <div className="panel">
            <span className="sec">Why the figures are what they are</span>
            <div className="row">
              <span className="muted">Transfer fee</span>
              <span>
                {feeBps === 0 ? (
                  <span className="badge warn">0 bps — transfers are free</span>
                ) : (
                  <span className="mono">{feeBps} bps</span>
                )}
              </span>
            </div>
            <div className="row">
              <span className="muted">FX pairs published</span>
              <span>
                {pairs.length === 0 ? (
                  <span className="badge warn">none — nothing converts</span>
                ) : (
                  <span className="mono">{pairs.length}</span>
                )}
              </span>
            </div>
            <p className="hint">
              The fee ships at zero deliberately — a fee nobody configured is money taken
              because of a default. <Link href="/admin/settings">Set it in Settings</Link>. An
              unpublished pair is refused, so it earns nothing because it converts nothing;
              each direction is its own policy. <Link href="/admin/prices">Publish in Prices</Link>.
            </p>
          </div>

          <div className="panel tbl-panel">
            <span className="tbl-note">Earned since launch, per currency — from the revenue accounts</span>
            {lines.length === 0 ? (
              <p className="empty">Nothing has been earned yet.</p>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Currency</th>
                      <th className="r">Fees</th>
                      <th className="r">FX spread</th>
                      <th className="r">Tax held</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.currency}>
                        <td className="mono">{line.currency}</td>
                        {/* `formatMinor`, never `formatAmount` — the two differ
                            by a factor of a hundred and these are `*_minor`. */}
                        <td className="r mono soft">{formatMinor(line.fees_minor, line.currency)}</td>
                        <td className="r mono soft">{formatMinor(line.fx_spread_minor, line.currency)}</td>
                        {/* TAX IS NOT EARNINGS — a liability owed onward, shown
                            only so a fee figure is not read as including it. */}
                        <td className="r mono quiet">{formatMinor(line.tax_payable_minor, line.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
