'use client';

import Link from 'next/link';
import { useState } from 'react';
import { compactMinor, formatMinor } from '@xetral/client';
import type { AdminOverview, AdminProviderHealth, AdminPulse } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from './access';
import { ageSince } from './age';
import { AdminStatus } from './nav';
import { change, smooth } from './chart';

/**
 * THE OPERATIONS OVERVIEW, as `docs/mockups/admin.html` draws it.
 *
 * IT WAS A TWENTY-FIVE ROW TABLE, and that was the screen an operator landed
 * on every morning. Four grey tiles — drift, entries, entries, held purchases
 * — then every work queue in the platform, zeros and all, then a liability
 * table. Correct, and it answered none of the three questions the comp is
 * built round: is the money right, is it moving, and who has to do something.
 *
 * So: four tiles with a day-on-day move and a week's trend, the ledger's
 * throughput over twenty-four hours, the drift check as its own tile, the
 * last hour in ten-minute bars, the queues that are waiting on a PERSON, what
 * is owed per currency, and whether the providers are answering.
 *
 * EVERY FIGURE IS READ OFF POSTINGS by `AdminService.#pulse()`; nothing here is
 * a counter the API keeps. The money tiles are naira and say so with their
 * symbol — every other currency is on the per-currency panel, because a total
 * that adds kobo to cents is the one number this platform refuses to draw.
 */
export default function Overview() {
  const admin = useAdmin();
  const overview = useLoad(() => admin.overview(), [admin]);
  const drift = useLoad(() => admin.drift(), [admin]);
  const health = useLoad(() => admin.providerHealth(), [admin]);

  const drifted = drift.data?.length;
  const pulse = overview.data?.pulse;

  return (
    <>
      <AdminStatus>
        {drifted === undefined ? null : drifted === 0 ? (
          <span className="badge ok dotted">All ledgers balanced</span>
        ) : (
          <span className="badge danger dotted">
            {drifted} {drifted === 1 ? 'account' : 'accounts'} drifted
          </span>
        )}
      </AdminStatus>

      {/* A drift check that cannot alarm is not a check: first, and loud. */}
      {drifted !== undefined && drifted > 0 && (
        <div className="notice danger">
          <p>
            <strong>{drifted} account(s) have drifted.</strong> A materialised
            balance disagrees with the sum of its own postings. Investigate this
            before acting on anything else here.
          </p>
        </div>
      )}

      <AdminError error={overview.error} code={overview.code} role="support" />

      {overview.error === undefined && (
        <>
          <div className="kgrid">
            <MoneyTile
              label="Total owed to customers"
              now={pulse?.owed_now_minor}
              before={pulse?.owed_24h_ago_minor}
              series={pulse?.owed_daily_minor}
              tone="iris"
            />
            <CountTile
              label="Ledger entries · 24h"
              now={pulse?.entries_24h}
              before={pulse?.entries_prev_24h}
              series={pulse?.entries_daily}
            />
            <MoneyTile
              label="Settled volume · 24h"
              now={pulse?.volume_24h_minor}
              before={pulse?.volume_prev_24h_minor}
              series={pulse?.volume_daily_minor}
              tone="warn"
            />
            <MoneyTile
              label="Platform earnings · 24h"
              now={pulse?.earnings_24h_minor}
              before={pulse?.earnings_prev_24h_minor}
              series={pulse?.earnings_daily_minor}
              tone="ok"
            />
          </div>

          <div className="ov-grid">
            <Throughput pulse={pulse} />
            <div className="ov-side">
              <div className="panel ov-drift">
                <span className={drifted !== undefined && drifted > 0 ? 'ov-shield danger' : 'ov-shield'}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 2.5 20 6v6c0 5-3.4 8.2-8 9.5-4.6-1.3-8-4.5-8-9.5V6l8-3.5ZM9 12l2 2 4-4" />
                  </svg>
                </span>
                <span>
                  <span className="ov-big">{drifted ?? '—'}</span>
                  <span className="ov-cap">accounts drifted</span>
                </span>
                <p>
                  {drifted === undefined || drifted === 0
                    ? 'Every materialised balance matches its postings.'
                    : 'A balance disagrees with its own postings.'}
                </p>
              </div>
              <LastHour pulse={pulse} />
            </div>
          </div>

          <div className="ov-pair">
            <NeedsAPerson queues={overview.data?.queues} />
            <OwedByCurrency liability={overview.data?.liability} />
          </div>

          <ProviderStrip health={health.data} />
        </>
      )}
    </>
  );
}

/* ─────────────────────────────── the tiles ─────────────────────────────── */

type Tone = 'iris' | 'info' | 'warn' | 'ok';

/** Seven points into a 72×26 polyline — GEOMETRY, so the bigint is reduced
 *  to a 0–1000 integer before it becomes a coordinate. */
function sparkPoints(values: readonly bigint[]): string {
  if (values.length === 0) return '';
  let lo = values[0] as bigint;
  let hi = lo;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  const step = 72 / Math.max(values.length - 1, 1);
  return values
    .map((v, i) => {
      const level = span === 0n ? 500 : Number(((v - lo) * 1000n) / span);
      return `${(i * step).toFixed(1)},${(22 - (level / 1000) * 18).toFixed(1)}`;
    })
    .join(' ');
}

function Spark({ values, tone }: { readonly values: readonly bigint[]; readonly tone: Tone }) {
  return (
    <svg className={`spark ${tone}`} width="72" height="26" viewBox="0 0 72 26" fill="none" aria-hidden>
      <polyline points={sparkPoints(values)} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TileFoot({ now, before, series, tone }: {
  readonly now: bigint | undefined;
  readonly before: bigint | undefined;
  readonly series: readonly bigint[] | undefined;
  readonly tone: Tone;
}) {
  const moved = now === undefined || before === undefined ? undefined : change(now, before);
  return (
    <div className="kfoot">
      <span className={moved === undefined ? 'kchg' : moved.up ? 'kchg up' : 'kchg down'}>
        {moved?.text ?? 'no change'}
      </span>
      {series !== undefined && <Spark values={series} tone={tone} />}
    </div>
  );
}

function MoneyTile({ label, now, before, series, tone }: {
  readonly label: string;
  readonly now: string | undefined;
  readonly before: string | undefined;
  readonly series: readonly string[] | undefined;
  readonly tone: Tone;
}) {
  const shown = now === undefined ? undefined : compactMinor(now, 'NGN');
  return (
    <div className="panel kpi">
      <div className="klab">{label}</div>
      <div className="kval">
        {shown === undefined ? '—' : shown.figure}
        {shown !== undefined && shown.unit !== '' && <span className="unit">{shown.unit}</span>}
      </div>
      <TileFoot
        now={now === undefined ? undefined : BigInt(now)}
        before={before === undefined ? undefined : BigInt(before)}
        series={series?.map((v) => BigInt(v))}
        tone={tone}
      />
    </div>
  );
}

function CountTile({ label, now, before, series }: {
  readonly label: string;
  readonly now: number | undefined;
  readonly before: number | undefined;
  readonly series: readonly number[] | undefined;
}) {
  return (
    <div className="panel kpi">
      <div className="klab">{label}</div>
      <div className="kval">{now === undefined ? '—' : now.toLocaleString('en-NG')}</div>
      <TileFoot
        now={now === undefined ? undefined : BigInt(now)}
        before={before === undefined ? undefined : BigInt(before)}
        series={series?.map((v) => BigInt(v))}
        tone="info"
      />
    </div>
  );
}

/* ──────────────────────────── the throughput chart ──────────────────────────── */

function Throughput({ pulse }: { readonly pulse: AdminPulse | undefined }) {
  const entries = pulse?.hourly_entries ?? [];
  const settled = pulse?.hourly_settlements ?? [];
  const top = Math.max(1, ...entries, ...settled);
  const at = (series: readonly number[]) =>
    series.map((n, i) => [(i / Math.max(series.length - 1, 1)) * 640, 196 - (n / top) * 170] as const);
  const line = smooth(at(entries));
  const area = entries.length > 0 ? `${line} L640,210 L0,210 Z` : '';
  const hour = (back: number) => {
    const d = new Date(Date.now() - back * 3_600_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  };
  return (
    <div className="panel ov-chart">
      <div className="ov-head">
        <span className="sec">Ledger throughput</span>
        <span className="ov-legend">
          <span className="iris">● entries</span>
          <span className="info">● settlements</span>
        </span>
      </div>
      <svg viewBox="0 0 640 210" preserveAspectRatio="none" role="img"
        aria-label={`Ledger entries and provider settlements, hourly, last 24 hours. Busiest hour: ${top} entries.`}>
        <defs>
          <linearGradient id="ov-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--iris)" stopOpacity=".32" />
            <stop offset="1" stopColor="var(--iris)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[52, 104, 156].map((y) => (
          <line key={y} x1="0" y1={y} x2="640" y2={y} className="grid" />
        ))}
        {area !== '' && <path d={area} fill="url(#ov-area)" />}
        {line !== '' && <path d={line} className="ln iris" />}
        {settled.length > 0 && <path d={smooth(at(settled))} className="ln info" />}
      </svg>
      <div className="ov-axis">
        <span>{hour(24)}</span>
        <span>{hour(18)}</span>
        <span>{hour(12)}</span>
        <span>{hour(6)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function LastHour({ pulse }: { readonly pulse: AdminPulse | undefined }) {
  const bars = pulse?.last_hour_by_ten_minutes ?? [0, 0, 0, 0, 0, 0];
  const total = bars.reduce((a, b) => a + b, 0);
  const top = Math.max(1, ...bars);
  return (
    <div className="panel ov-hour">
      <div className="klab">Entries · last hour</div>
      <div className="kval">{pulse === undefined ? '—' : total.toLocaleString('en-NG')}</div>
      <div className="ov-bars" aria-hidden>
        {bars.map((n, i) => (
          <span
            key={i}
            className={i === bars.length - 1 ? 'now' : i >= bars.length - 3 ? 'near' : undefined}
            style={{ height: `${Math.max(12, Math.round((n / top) * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────── who has to do something ──────────────────────────── */

/** A queue a regulator or a customer's money is waiting on is red; the rest amber. */
const URGENT = new Set(['risk_signals', 'risk_cases', 'ledger_drift', 'provider_drift', 'tax_drift', 'bank_payouts_stuck', 'card_holds_stuck']);

function NeedsAPerson({ queues }: { readonly queues: AdminOverview['queues'] | undefined }) {
  const [all, setAll] = useState(false);
  const rows = [...(queues ?? [])].sort((a, b) => Number(b.waiting) - Number(a.waiting));
  const waiting = rows.filter((q) => Number(q.waiting) > 0);
  const total = waiting.reduce((a, q) => a + Number(q.waiting), 0);
  const clear = rows.length - waiting.length;
  const shown = all ? rows : waiting.slice(0, 5);
  return (
    <div className="panel ov-needs">
      <div className="ov-head">
        <span className="sec">Needs a person</span>
        <span className="ov-note">
          {queues === undefined ? '' : `${total} waiting · ${clear} clear`}
        </span>
      </div>
      {queues !== undefined && waiting.length === 0 && !all && (
        <p className="ov-empty">Nothing is waiting on a person.</p>
      )}
      {shown.map((q) => {
        const idle = Number(q.waiting) === 0;
        const href = QUEUE_SCREENS[q.queue];
        const label = queueLabel(q.queue);
        return (
          <div className={idle ? 'ov-row idle' : 'ov-row'} key={q.queue}>
            <span className={`dot ${idle ? '' : URGENT.has(q.queue) ? 'danger' : 'warn'}`} />
            {href !== undefined && !idle ? (
              <Link href={href} className="name">{label}</Link>
            ) : (
              <span className="name">{label}</span>
            )}
            <span className="n">{q.waiting}</span>
            <span className="age">{idle ? 'clear' : `${ageSince(q.oldest)} oldest`}</span>
          </div>
        );
      })}
      {queues !== undefined && rows.length > 5 && (
        <button type="button" className="ov-more" onClick={() => setAll((was) => !was)}>
          {all ? 'Show only what is waiting' : `All ${rows.length} queues`}
        </button>
      )}
    </div>
  );
}

/** What an operator calls each queue — the comp's names, not the view's. */
const QUEUE_LABELS: Readonly<Record<string, string>> = {
  kyc: 'Identity review',
  bvn_collisions: 'BVN collisions',
  risk_signals: 'Compliance signals',
  risk_cases: 'Compliance cases',
  giftcard_review: 'Gift-card review',
  giftcard_holds_due: 'Gift-card holds',
  consent: 'Consent to collect',
  data_requests: 'Data requests',
  prices_unattributed: 'Prices without an author',
  bank_payouts_stuck: 'Payouts with no answer',
  card_holds_stuck: 'Card holds with no settlement',
  staff_without_totp: 'Staff without a second factor',
  notifications_abandoned: 'Emails that could not be sent',
};

function queueLabel(queue: string): string {
  const known = QUEUE_LABELS[queue];
  if (known !== undefined) return known;
  const name = queue.replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const BAR_TONE: Readonly<Record<string, string>> = { NGN: 'iris', USD: 'info', GHS: 'ok', KES: 'warn' };

/**
 * WHAT IS OWED, PER CURRENCY, and the bar is the share of it sitting in
 * spendable wallets. Across currencies the lengths would compare kobo with
 * cents; within one, "how much of this could leave today" is the question a
 * treasury reads it for.
 */
function OwedByCurrency({ liability }: { readonly liability: AdminOverview['liability'] | undefined }) {
  return (
    <div className="panel ov-owed">
      <div className="ov-head">
        <span className="sec">Owed by currency</span>
        <span className="ov-note">from postings · bar is in wallets</span>
      </div>
      {liability !== undefined && liability.length === 0 && <p className="ov-empty">Nothing is owed yet.</p>}
      <div className="ov-owed-list">
        {(liability ?? []).map((row) => {
          const total = BigInt(row.total_owed_minor);
          // A WIDTH, kept in bigint to the end: whole percent as text, so no
          // amount ever becomes a JS number on its way to a style.
          const wallets = BigInt(row.wallets_minor);
          const pct = total <= 0n || wallets <= 0n ? 0n : wallets >= total ? 100n : (wallets * 100n) / total;
          return (
            <div key={row.currency}>
              <div className="ov-owed-head">
                <span>{row.currency}</span>
                <span className="mono">{formatMinor(row.total_owed_minor, row.currency)}</span>
              </div>
              <div className="ov-track">
                <span className={BAR_TONE[row.currency] ?? 'iris'} style={{ width: `${pct.toString()}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  flutterwave: 'Flutterwave', bitnob: 'Bitnob', paystack: 'Paystack', vtpass: 'VTpass',
  airalo: 'Airalo', twilio: 'Twilio', brevo: 'Brevo', exchangerate: 'ExchangeRate', expo: 'Expo',
};

/** The comp's strip: one dot per company and how the recent window went. */
function ProviderStrip({ health }: { readonly health: AdminProviderHealth | undefined }) {
  const byProvider = new Map<string, { calls: number; failures: number }>();
  for (const row of health?.recent ?? []) {
    const had = byProvider.get(row.provider) ?? { calls: 0, failures: 0 };
    byProvider.set(row.provider, { calls: had.calls + Number(row.attempts), failures: had.failures + Number(row.failures) });
  }
  for (const p of ['flutterwave', 'bitnob', 'paystack']) if (!byProvider.has(p)) byProvider.set(p, { calls: 0, failures: 0 });
  return (
    <Link href="/admin/providers" className="panel ov-providers">
      <span className="lab">Providers</span>
      {[...byProvider.entries()].map(([provider, { calls, failures }]) => {
        const degraded = health?.degraded.some((d) => d.provider === provider) ?? false;
        return (
          <span className="prov" key={provider}>
            <span className={`dot ${degraded ? 'warn' : calls > 0 ? 'ok' : ''}`} />
            {PROVIDER_NAMES[provider] ?? provider}
            <span className="mono">
              {degraded ? 'degraded' : calls === 0 ? 'idle' : `${Math.floor(((calls - failures) / calls) * 100)}%`}
            </span>
          </span>
        );
      })}
    </Link>
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
  disputes: '/admin/disputes',
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
