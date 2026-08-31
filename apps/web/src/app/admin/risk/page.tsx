'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AdminRiskSignal } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { formatMinor } from '@xetral/client';
import { AdminError } from '../access';

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
  const signals = useLoad(() => admin.riskSignals(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Compliance queue</h1>
        <h2>What the monitoring rules thought worth a look</h2>
        <p className="lead">
          Nothing here was blocked. These are observations made after the fact,
          so every transaction below already happened — the controls that refuse
          run before money moves and are elsewhere. Closing a row records that
          you looked and what you decided.
        </p>
        <p className="hint">
          <Link href="/admin/risk/cases">
            Compliance cases — where several signals about one customer become
            one investigation →
          </Link>
        </p>
        <AdminError error={signals.error} code={signals.code} role="compliance" />
        {signals.loading && <p className="spinner">Loading…</p>}
        {signals.data !== undefined && signals.data.length === 0 && (
          <p className="hint">
            Nothing open. If this stays empty for days, check that
            <span className="mono"> RISK_MONITOR_INTERVAL_SECONDS </span>
            is set on one instance — an empty queue looks the same whether the
            rules found nothing or never ran.
          </p>
        )}
      </div>

      {(signals.data ?? []).map((signal) => (
        <Signal key={signal.id} signal={signal} onResolved={signals.reload} />
      ))}
    </>
  );
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
    <div className="panel">
      <div className="field-row two">
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
