'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import type { AdminProviderHealth, AdminRoute, ApiErrorCode } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';

/**
 * Whether the providers are answering.
 *
 * WHAT THIS EXISTS FOR is that every kill switch has to be flipped by hand,
 * which means noticing first — and until now the first reliable signal that a
 * provider had stopped answering was a customer saying so.
 *
 * A REFUSAL IS NOT A FAILURE, and the table says so rather than leaving it to
 * be inferred. A declined card is the provider working; counting it as ill
 * health makes a busy decline rate look like an outage, and an alert that
 * fires on ordinary business is one people mute.
 *
 * NOTHING HERE DISABLES ANYTHING. That is a decision, and the page states it:
 * a flapping provider would switch off a flow nobody meant to stop, and
 * re-enabling needs a person anyway. The switch is one click away on the
 * settings screen and takes seconds — what was missing was never the flipping,
 * it was knowing.
 */
export default function Providers() {
  const admin = useAdmin();
  const health = useLoad(() => admin.providerHealth(), [admin]);
  const routes = useLoad(() => admin.routes(), [admin]);

  const cards = providerCards(health.data, routes.data?.routes ?? []);

  return (
    <>
      <AdminTitle>Providers</AdminTitle>
      <AdminError error={health.error} code={health.code} role="support" />

      {/*
        THE COMP'S FOUR CARDS: one per company, its state as a pill, and what
        it carries. "Carries" is read from the route table rather than written
        here, so the card says what is TRUE on this deployment — a card saying
        "NGN bank" about a rail that no longer opens naira accounts is the
        stale-label failure this page exists to end.
      */}
      <div className="rail-cards">
        {cards.map((card) => (
          <div className={`panel rail-card ${card.state}`} key={card.provider}>
            <div className="rail-card-head">
              <span className="sec">{nameOf(card.provider)}</span>
              <span className={`badge ${BADGE[card.state]}`}>
                <span className="dot" aria-hidden />
                {STATE_LABEL[card.state]}
              </span>
            </div>
            <div className="rail-figs">
              <span>
                <span className="k">Recent calls</span>
                <span className="v mono">{card.calls.toLocaleString('en-NG')}</span>
              </span>
              <span>
                <span className="k">Success</span>
                <span className={`v mono ${card.state === 'degraded' ? 'warn' : card.calls > 0 ? 'ok' : ''}`}>
                  {card.calls === 0 ? '—' : `${card.success}%`}
                </span>
              </span>
              <span>
                <span className="k">Carries</span>
                <span className="v text">{card.carries}</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      <RouteSwitches
        routes={routes.data?.routes}
        error={routes.error}
        code={routes.code}
        onChanged={routes.reload}
      />

      {health.data !== undefined && health.data.recent.length === 0 && (
        <div className="panel">
          <p>
            No provider calls in the window. That means nothing has been
            called — not that everything is well.
          </p>
          {/*
            Health is recorded from real calls, so on a fresh deployment it is
            empty by definition, and an empty page under this name reads as
            broken rather than as quiet.
          */}
          <p className="hint">
            Keys go on <Link href="/admin/credentials">Provider keys</Link>; flows
            are switched off on <Link href="/admin/settings">Settings</Link>.
          </p>
        </div>
      )}

      {health.data !== undefined && health.data.degraded.length > 0 && (
        <div className="panel">
          <h2 className="danger">Failing</h2>
          <p className="lead">
            Nothing has been switched off. Flows are turned off on{' '}
            <Link href="/admin/settings">Settings</Link>.
          </p>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Operation</th>
                <th className="right">Failing</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {health.data.degraded.map((row) => (
                <tr key={`${row.provider}:${row.operation}`}>
                  <td>
                    {row.provider}
                    {row.contract_broken && (
                      <>
                        {' '}
                        <span className="badge danger">contract</span>
                      </>
                    )}
                  </td>
                  <td>{row.operation}</td>
                  <td className="right amount">
                    {row.failure_percent}% of {row.attempts}
                  </td>
                  <td className="muted">{row.last_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.data.degraded.some((row) => row.contract_broken) && (
            <p className="hint">
              A <strong>contract</strong> failure means they changed their API. It
              will not resolve on its own.
            </p>
          )}
        </div>
      )}

      {health.data !== undefined && health.data.float.length > 0 && (
        <div className="panel">
          <h2>What we hold at our providers</h2>
          <p className="lead">
            Flutterwave is a prefunded wallet: a cedi payout spends a cedi
            balance we have to put there first. A corridor with nothing in it
            refuses every transfer, and until now that refusal reached the
            customer as a message about their own account.
          </p>
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th className="right">Held</th>
                <th className="right">Committed</th>
                <th className="right">Available</th>
                <th>Last movement</th>
              </tr>
            </thead>
            <tbody>
              {health.data.float.map((row) => (
                <tr key={row.currency} className={row.short ? undefined : 'muted'}>
                  <td>
                    {row.currency}{' '}
                    {row.short && <span className="badge danger">short</span>}
                  </td>
                  {/*
                    `formatMinor` and never `formatAmount`. The two look
                    identical at a call site and differ by a factor of a
                    hundred — `formatAmount` takes MAJOR units and every figure
                    here is `*_minor`. That is exactly the error that had the
                    compliance queue rendering ₦500,000,000 for a ₦5,000,000
                    transfer.
                  */}
                  <td className="right amount">
                    {formatMinor(row.held_minor, row.currency)}
                  </td>
                  <td className="right amount">
                    {formatMinor(row.committed_minor, row.currency)}
                  </td>
                  <td className="right amount">
                    {formatMinor(row.available_minor, row.currency)}
                  </td>
                  <td className="muted">
                    {row.last_movement_at === null
                      ? '—'
                      : new Date(row.last_movement_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.data.float.some((row) => row.short) && (
            <p className="hint">
              A currency marked <strong>short</strong> has payouts reserved
              against it that it cannot cover. Send the provider more of that
              currency — payouts on it are refused until you do, deliberately,
              because the alternative is the provider refusing them afterwards
              with a message that reads as the customer&rsquo;s fault.
            </p>
          )}
        </div>
      )}

      {health.data !== undefined && health.data.nameEnquiry.length > 0 && (
        <div className="panel">
          <h2>Recipient names that could not be confirmed</h2>
          <p className="lead">
            A rail that cannot name a recipient refuses every send on that
            corridor, and the customer is told to check a number that is
            correct. This is the provider&rsquo;s own reason.
          </p>
          <table>
            <thead>
              <tr>
                <th>Rail</th>
                <th className="right">Refusals</th>
                <th>Key</th>
                <th>What the provider said</th>
              </tr>
            </thead>
            <tbody>
              {health.data.nameEnquiry.map((row) => (
                <tr key={`${row.provider}:${row.country}:${row.rail_code}`}>
                  <td>
                    {row.provider} &middot; {row.country} {row.rail_code}
                  </td>
                  <td className="right amount">{row.refusals}</td>
                  <td>
                    {/*
                      THE FIELD MOST LIKELY TO ANSWER THE WHOLE THING.
                      Flutterwave's sandbox cannot verify a real account —
                      their own documentation says only test accounts resolve
                      in test mode — so a deployment on a test key refuses
                      every genuine number, correctly, for a reason that has
                      nothing to do with the number.
                    */}
                    {row.key_mode === 'test' ? (
                      <span className="badge danger">test key</span>
                    ) : row.key_mode === 'unset' ? (
                      <span className="badge danger">no key</span>
                    ) : (
                      <span className="muted">{row.key_mode}</span>
                    )}
                  </td>
                  <td className="muted">
                    {row.last_message}
                    <br />
                    <span className="hint">{row.last_tried}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.data.nameEnquiry.some((row) => row.key_mode === 'test') && (
            <p className="hint">
              A <strong>test key</strong> cannot verify a real account at all.
              Paste the live secret key on{' '}
              <Link href="/admin/credentials">Provider keys</Link> — until then
              every correct number on that corridor is refused.
            </p>
          )}
        </div>
      )}

      {health.data !== undefined && health.data.recent.length > 0 && (
        <div className="panel">
          <h2>Everything, including what is fine</h2>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Operation</th>
                <th className="right">Calls</th>
                <th className="right">Refused</th>
                <th className="right">Failing</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {health.data.recent.map((row) => (
                <tr
                  key={`${row.provider}:${row.operation}`}
                  className={row.failure_percent === 0 ? 'muted' : undefined}
                >
                  <td>{row.provider}</td>
                  <td>{row.operation}</td>
                  <td className="right amount">{row.attempts}</td>
                  {/* Shown next to the failure rate on purpose: a high refusal
                      count with a zero failure rate is a fraud or funding
                      story, not an outage. */}
                  <td className="right amount">{row.rejected}</td>
                  <td className="right amount">{row.failure_percent}%</td>
                  <td className="muted">{new Date(row.last_seen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------ */

const NAMES: Readonly<Record<string, string>> = {
  flutterwave: 'Flutterwave',
  bitnob: 'Bitnob',
  paystack: 'Paystack',
};

function nameOf(provider: string): string {
  return NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

type CardState = 'healthy' | 'degraded' | 'idle';

const STATE_LABEL: Readonly<Record<CardState, string>> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  // NOT "healthy". No calls in the window is no evidence either way, and a
  // green pill over nothing is the reassurance that hides an unset worker.
  idle: 'No recent calls',
};

const BADGE: Readonly<Record<CardState, string>> = {
  healthy: 'ok',
  degraded: 'warn',
  idle: 'quiet',
};

const OPERATION: Readonly<Record<AdminRoute['operation'], { label: string; short: string; sub: string }>> = {
  account: {
    label: 'Account numbers',
    short: 'accounts',
    sub: 'Who opens the next dedicated account number. Numbers already issued keep working where they are.',
  },
  collect: {
    label: 'Checkouts',
    short: 'checkouts',
    sub: 'Payment links, and mobile money top-ups in Ghana and Kenya.',
  },
  payout: {
    label: 'Payouts',
    short: 'payouts',
    sub: 'Money sent out to a bank account or a mobile money wallet. One in flight settles where it started.',
  },
};

interface Card {
  readonly provider: string;
  readonly state: CardState;
  readonly calls: number;
  readonly success: number;
  readonly carries: string;
}

/**
 * One card per company that carries something OR has been called — so a
 * provider nothing routes to but something still calls (a card issuer, a
 * rate feed) is not hidden, and one that carries everything but has been
 * silent reads as "no recent calls" rather than disappearing.
 */
function providerCards(
  health: AdminProviderHealth | undefined,
  routes: readonly AdminRoute[],
): readonly Card[] {
  const names = new Set<string>(['flutterwave', 'bitnob', 'paystack']);
  for (const r of routes) if (r.provider !== null) names.add(r.provider);
  for (const r of health?.recent ?? []) names.add(r.provider);

  return [...names].map((provider) => {
    const rows = health?.recent.filter((r) => r.provider === provider) ?? [];
    const calls = rows.reduce((n, r) => n + Number(r.attempts), 0);
    const failures = rows.reduce((n, r) => n + Number(r.failures), 0);
    const degraded = health?.degraded.some((r) => r.provider === provider) ?? false;
    const carried = routes
      .filter((r) => r.provider === provider)
      .map((r) => `${r.currency} ${OPERATION[r.operation].short}`);
    return {
      provider,
      state: degraded ? 'degraded' : calls === 0 ? 'idle' : 'healthy',
      calls,
      // Counts, not money — a percentage of calls is the one place a
      // rounded number is the honest one.
      success: calls === 0 ? 0 : Math.floor(((calls - failures) / calls) * 1000) / 10,
      carries: carried.length === 0 ? 'Nothing routed' : carried.join(', '),
    };
  });
}

/**
 * WHICH COMPANY CARRIES WHICH MONEY, as a switch per row.
 *
 * WHAT WAS MISSING was not the routing — 059 built that — but any way to
 * change it short of an UPDATE at a production prompt. The product owner's
 * request was a toggle: naira account numbers on Flutterwave or Bitnob,
 * payouts on Flutterwave or Bitnob, flipped by whoever is on call.
 *
 * ONE PRESS DOES NOT MOVE MONEY. Picking a company opens the confirmation in
 * place, with the PIN beside it — the rule `prices` records about every
 * action carrying its own PIN — and names what will and will not change. A
 * route is the decision about where a stranger's account number is opened;
 * it deserves a second look, not a modal.
 */
function RouteSwitches(props: {
  readonly routes: readonly AdminRoute[] | undefined;
  readonly error: string | undefined;
  readonly code: ApiErrorCode | undefined;
  readonly onChanged: () => void;
}) {
  const admin = useAdmin();
  const [pending, setPending] = useState<{ route: AdminRoute; provider: string } | undefined>();
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const ordered = [...(props.routes ?? [])].sort(
    (a, b) => ORDER.indexOf(a.operation) - ORDER.indexOf(b.operation) || a.currency.localeCompare(b.currency),
  );

  async function confirm(): Promise<void> {
    if (pending === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await admin.setRoute(
        { operation: pending.route.operation, currency: pending.route.currency, provider: pending.provider },
        pin,
      );
      setDone(
        `${OPERATION[pending.route.operation].label} in ${pending.route.currency} now go to ${nameOf(pending.provider)}.`,
      );
      setPending(undefined);
      setPin('');
      props.onChanged();
    } catch (caught: unknown) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  }

  function renderRow(route: AdminRoute) {
    const key = `${route.operation}:${route.currency}`;
    const choosing = pending !== undefined && `${pending.route.operation}:${pending.route.currency}` === key;
    return (
      <div className="route-row" key={key}>
        <div className="route-main">
          <span className="route-ccy">
            <span className="mono">{route.currency}</span>
            {/* Said beside the currency rather than as a sentence under it:
                a corridor open to customers with no company behind it is
                refused on every request, and it has to read at a glance. */}
            {route.provider === null && <span className="badge danger">Unrouted</span>}
          </span>
          {route.provider === null && route.options.length === 0 ? (
            <span className="badge danger">Nothing can serve this</span>
          ) : route.options.length <= 1 && route.provider !== null ? (
            // A switch with one position is a label pretending to be a
            // control. Say who carries it and that there is no alternative.
            <span className="route-only">{nameOf(route.provider)}</span>
          ) : (
            <div
              className="segmented"
              role="radiogroup"
              aria-label={`${OPERATION[route.operation].label} in ${route.currency}`}
            >
              {route.options.map((option) => {
                const active = option === route.provider;
                const chosen = choosing && pending?.provider === option;
                return (
                  <button
                    type="button"
                    key={option}
                    role="radio"
                    aria-checked={active}
                    // The one being PICKED is not the one in force until the
                    // PIN is given, so it must not look like it: an outline,
                    // never the filled pill the live route wears.
                    className={active ? 'active' : chosen ? 'chosen' : undefined}
                    onClick={() => {
                      setDone(undefined);
                      setError(undefined);
                      if (active) setPending(undefined);
                      else setPending({ route, provider: option });
                    }}
                  >
                    {nameOf(option)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {choosing && pending !== undefined && (
          <div className="route-confirm">
            <p>
              Move {OPERATION[route.operation].label.toLowerCase()} in {route.currency} from{' '}
              <strong>{route.provider === null ? 'nobody' : nameOf(route.provider)}</strong> to{' '}
              <strong>{nameOf(pending.provider)}</strong>?
              {route.operation === 'account' && pending.provider !== 'paystack' && (
                <>
                  {' '}
                  {nameOf(pending.provider)} opens an account number only for a customer
                  whose identity is verified.
                </>
              )}
            </p>
            <div className="route-confirm-row">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="PIN"
                aria-label="Transaction PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <button type="button" disabled={saving || pin === ''} onClick={() => void confirm()}>
                {saving ? 'Moving…' : `Move to ${nameOf(pending.provider)}`}
              </button>
              <button type="button" className="ghost" onClick={() => setPending(undefined)}>
                Cancel
              </button>
            </div>
            {error !== undefined && <p className="error">{error}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="panel route-panel">
      <div className="panel-row-head">
        <span className="sec">Who carries what</span>
      </div>
      <p className="lead route-lead">
        Switching moves nobody: an account number already issued keeps
        receiving where it was opened, and a payout in flight settles on its
        own rail. Only the next request goes to the company you pick.
      </p>
      <AdminError error={props.error} code={props.code} role="support" />
      {done !== undefined && <p className="route-done">{done}</p>}
      {ORDER.map((operation) => {
        const group = ordered.filter((r) => r.operation === operation);
        if (group.length === 0) return null;
        return (
          <section className="route-group" key={operation}>
            {/* The explanation once per kind of money, not once per currency:
                thirteen rows repeating one sentence is how a screen stops
                being read. */}
            <div className="route-group-head">
              <span className="name">{OPERATION[operation].label}</span>
              <span className="sub">{OPERATION[operation].sub}</span>
            </div>
            {group.map((route) => renderRow(route))}
          </section>
        );
      })}
    </div>
  );
}

const ORDER: readonly AdminRoute['operation'][] = ['account', 'payout', 'collect'];

