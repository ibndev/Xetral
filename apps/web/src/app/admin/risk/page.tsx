'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { AdminRiskSignal } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { formatMinor } from '@xetral/client';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { ageSince } from '../age';
import { Kpis, shortRef } from '../queue';

/**
 * The compliance queue.
 *
 * Every row is an OBSERVATION, and the page says so rather than implying
 * otherwise: nothing here was refused, frozen or held. The controls that act
 * — the daily ceiling, the velocity rules, the card freezes — run before money
 * moves and are tuned to almost never fire, because the cost of a false
 * positive there is a customer refused their own money. This runs after, where
 * the cost of a false positive is a reviewer's minute, so it can afford to be
 * far more suspicious.
 */

/** What each rule is claiming, in the words a reviewer needs rather than the
 *  enum's. A queue whose rows say `rapid_passthrough` is a queue people learn
 *  to skim. */
const EXPLAINS: Readonly<Record<string, { label: string; means: string }>> = {
  large_value: {
    label: 'Large movement',
    means: 'One movement at or above the reporting threshold for its currency.',
  },
  structuring: {
    label: 'Structuring',
    means:
      'Several movements in one day, each deliberately under the reporting ' +
      'threshold and together above it. No single one of them would show up.',
  },
  rapid_passthrough: {
    label: 'Pass-through',
    means:
      'Most of what arrived today left again the same day. A wallet holds ' +
      'money; a conduit does not.',
  },
  dormant_reactivation: {
    label: 'Dormant account active',
    means:
      'Quiet for months, then moving money. This is what a sold or recovered ' +
      'credential looks like from here.',
  },
  crypto_fast_out: {
    label: 'Straight onto a chain',
    means:
      'A crypto withdrawal shortly after money arrived. A chain transaction ' +
      'cannot be recalled, so this is the one pattern where acting late is ' +
      'the same as not acting.',
  },
};

export default function Risk() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.riskQueue(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const signals = queue.data?.signals ?? [];
  const summary = queue.data?.summary;

  const reload = (): void => {
    setOpen(undefined);
    queue.reload();
  };

  return (
    <>
      <AdminTitle>Compliance</AdminTitle>
      <Kpis
        items={[
          { label: 'Open signals', count: summary?.open_signals, tone: 'danger' },
          { label: 'Open cases', count: summary?.open_cases, tone: 'danger' },
          { label: 'Cleared · 7d', count: summary?.cleared_7d, tone: 'ok' },
        ]}
      />

      <div className="panel tbl-panel">
        <span className="tbl-note">
          Nothing here was blocked — every transaction below already happened.{' '}
          <Link href="/admin/risk/cases">Cases, where several signals become one investigation →</Link>
        </span>
        <AdminError error={queue.error} code={queue.code} role="compliance" />
        {queue.loading && <p className="spinner">Loading…</p>}
        {queue.data !== undefined && signals.length === 0 && (
          <p className="empty">
            Nothing open. If it stays empty for days, check{' '}
            <span className="mono">RISK_MONITOR_INTERVAL_SECONDS</span> is set on one instance.
          </p>
        )}

        {signals.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Signal</th>
                  <th>Subject</th>
                  {/* PATTERN, not severity: the rules grade nothing (027). What
                      is real is whether this is one signal, one of several,
                      or already inside an investigation. */}
                  <th>Pattern</th>
                  <th>Age</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => (
                  <Fragment key={signal.id}>
                    <tr>
                      <td className="ref">{shortRef('RS', signal.id)}</td>
                      <td>{headline(signal)}</td>
                      <td>{signal.name ?? signal.email ?? signal.user_uuid}</td>
                      <td>
                        <PatternPill signal={signal} />
                      </td>
                      <td className="quiet">{ageSince(signal.observed_at)}</td>
                      <td className="r">
                        <button
                          type="button"
                          className={open === signal.id ? 'ghost' : undefined}
                          aria-expanded={open === signal.id}
                          onClick={() => setOpen(open === signal.id ? undefined : signal.id)}
                        >
                          {open === signal.id ? 'Close' : 'Review'}
                        </button>
                      </td>
                    </tr>
                    {open === signal.id && (
                      <tr className="detail">
                        <td colSpan={6}>
                          <Signal signal={signal} onResolved={reload} />
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

/** The rule in words, with its figure where it has one — "Large movement ·
 *  ₦6,200,000.00". The figure is formatted from minor units, never parsed. */
function headline(signal: AdminRiskSignal): string {
  const label = EXPLAINS[signal.rule]?.label ?? signal.rule;
  const currency = signal.detail['currency'];
  const key = Object.keys(signal.detail).find((k) => k.endsWith('_minor'));
  const value = key === undefined ? undefined : signal.detail[key];
  return value === undefined || currency === undefined
    ? label
    : `${label} · ${formatMinor(value, currency)}`;
}

function PatternPill({ signal }: { readonly signal: AdminRiskSignal }) {
  if (signal.in_case) return <span className="badge danger">In a case</span>;
  if (signal.user_status !== 'active') return <span className="badge danger">{signal.user_status}</span>;
  if (signal.other_open_signals > 0) {
    return <span className="badge warn">{signal.other_open_signals + 1} open</span>;
  }
  return <span className="badge info">Single</span>;
}

function Signal({
  signal,
  onResolved,
}: {
  signal: AdminRiskSignal;
  onResolved: () => void;
}) {
  const admin = useAdmin();
  const [resolution, setResolution] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const explain = EXPLAINS[signal.rule] ?? { label: signal.rule, means: '' };
  const ready = resolution.trim().length >= 10 && pin !== '';

  return (
    <div className="review-grid">
      <div>
        <strong>{explain.label}</strong>{' '}
        {signal.other_open_signals > 0 && (
          <span className="badge warn">
            {signal.other_open_signals} other open
          </span>
        )}
        {signal.user_status !== 'active' && (
          <span className="badge warn"> {signal.user_status}</span>
        )}
        <p className="hint">{explain.means}</p>
        <p className="hint mono">
          {signal.email ?? signal.user_uuid} ·{' '}
          {new Date(signal.observed_at).toLocaleString()}
        </p>

        {/*
          The rule's own arithmetic, so a reviewer can check it rather than
          trust it. Amounts are minor-unit strings and are formatted without
          ever becoming a number — the same rule the customer app follows.
        */}
        <table style={{ marginTop: 8 }}>
          <tbody>
            {Object.entries(signal.detail).map(([key, value]) => (
              <tr key={key}>
                <td className="hint" style={{ paddingRight: 16 }}>
                  {key.replace(/_/g, ' ')}
                </td>
                <td className="mono">{describe(key, value, signal.detail['currency'])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <label>
          What you decided, and why
          <textarea
            rows={4}
            value={resolution}
            placeholder="e.g. known property purchase, documents on file"
            onChange={(e) => setResolution(e.target.value)}
          />
        </label>

        {resolution.trim() !== '' && (
          <label>
            Your transaction PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
        )}

        <div className="actions">
          <button
            type="button"
            className="small"
            disabled={!ready || busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void (async () => {
                try {
                  await admin.resolveRiskSignal(signal.id, resolution, pin);
                  onResolved();
                } catch (cause) {
                  setError(messageFor(cause));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {busy ? 'Closing…' : 'Close this signal'}
          </button>
          {resolution.trim() !== '' && resolution.trim().length < 10 && (
            // Said before the request rather than after the refusal. "ok" is
            // not a review, and the API refuses it — but a reviewer should
            // learn that here rather than from a 400.
            <span className="badge warn">say a little more</span>
          )}
        </div>

        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Renders one piece of a rule's evidence.
 *
 * A `*_minor` value is money, so it goes through `formatMinor`, which groups
 * digits WITHOUT producing a number — the same rule the customer app follows,
 * and it matters here too: a reviewer deciding whether ₦5,000,000 is really
 * ₦5,000,000 is exactly who a float would mislead.
 *
 * `formatMinor`, NOT `formatAmount`. This called the major-unit formatter on a
 * kobo figure, so every amount on the compliance queue read a hundred times
 * larger than it was — ₦500,000,000 for a ₦5,000,000 transfer. The two
 * functions look identical at a call site, which is why they are now named
 * for the units they take.
 */
function describe(key: string, value: string, currency: string | undefined): string {
  if (!key.endsWith('_minor') || currency === undefined) return value;
  return `${formatMinor(value, currency)} ${currency}`;
}
