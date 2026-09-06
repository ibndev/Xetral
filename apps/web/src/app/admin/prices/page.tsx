'use client';

import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { Select } from '@/ui/select';
import { Icon } from '@/ui/icon';
import Link from 'next/link';

/**
 * What a customer will be quoted, and the only place it can be set.
 *
 * NOTHING IN THE APPLICATION EVER WROTE THESE TABLES. An unpublished FX pair
 * is refused rather than quoted from a default — Phase 10 chose that
 * deliberately — so a fresh deployment converted nothing, and gift cards could
 * be switched on and then 404 the first customer quote. The only way out was
 * psql on the production database.
 *
 * THERE IS NO EDIT, and that is the schema rather than an omission. A
 * published price is append-only: changing one is retiring it and publishing
 * its replacement, which is what keeps a quote given last month explicable.
 * The form below only ever adds.
 */
export default function Prices() {
  const admin = useAdmin();
  const prices = useLoad(() => admin.prices(), [admin]);
  // Its own load rather than a field on `prices()`: 053 is a later migration,
  // and a deployment without it should render this panel empty rather than
  // fail the whole screen over a table one panel needs.
  const rates = useLoad(() => admin.fxRates(), [admin]);
  /*
   * WHICH CURRENCIES THIS PLATFORM ACTUALLY OPERATES IN, so the corridors it
   * runs on sort to the top of the table.
   *
   * The feed answers every pair between eight currencies — fifty-six rows —
   * and an operator checking whether the naira is priced today should not be
   * reading down an alphabetical list to find it. Derived from the ENABLED
   * countries rather than written out, so opening a country moves its currency
   * up this table on the next load rather than in whichever release somebody
   * remembers this file in.
   */
  const countries = useLoad(() => admin.countries(), [admin]);
  const operating = new Set<string>([
    ...(countries.data?.countries ?? []).filter((c) => c.enabled).map((c) => c.currency),
    // The dollar and the stablecoins belong to no country and are held across
    // all of them — the same exception `wallet.service.ts` names.
    'USD',
    'USDT',
    'USDC',
  ]);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function act(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      prices.reload();
      rates.reload();
      /*
       * THE PIN IS NOT CLEARED, and that is the fix rather than an oversight.
       *
       * It was, and the reported symptom is exactly what that produces: an
       * operator types a PIN, publishes one price, and the next button on the
       * same page answers "Enter transaction pin" — with a box that looks
       * empty for a reason nobody can see. There are five actions on this
       * screen and somebody setting prices uses several in a sitting.
       *
       * The same argument 014 records about the staff second factor: a
       * credential that has to be re-entered per action is a credential people
       * find a way to stop re-entering. It is held in component state, so it
       * is gone the moment this page is left.
       */
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const noFx = (prices.data?.fx_policies ?? []).every((p) => p.retired_at !== null);

  return (
    <>
      <div className="panel">
        <h1>Prices</h1>
        <p className="lead">
          Every FX spread and gift card rate a customer can be quoted. Prices are
          never edited — retire one and publish its replacement.
        </p>
        <AdminError error={prices.error} code={prices.code} role="finance" />
        {prices.loading && <p className="spinner">Loading…</p>}

        {/* The state a fresh deployment is actually in, said plainly. An
            operator should not learn this from the first customer. */}
        {prices.data !== undefined && noFx && (
          <p className="error">
            No FX pair is published. Every conversion and remittance is being
            refused.
          </p>
        )}

        {prices.data !== undefined && prices.data.unattributed.length > 0 && (
          <>
            <h2>Published without an author</h2>
            <p className="lead">
              Written at a database prompt, so nobody is recorded as setting them.
              Retire and republish to put a name on one.
            </p>
            <ul className="hint">
              {prices.data.unattributed.map((row) => (
                <li key={row.uuid}>
                  {row.kind === 'fx_spread' ? 'FX' : 'Gift card'} — {row.subject}
                </li>
              ))}
            </ul>
          </>
        )}

        {/*
          ONE PIN FOR THE WHOLE SCREEN, AND NOTHING SUBMITS WITHOUT IT.
          
          Every action here — publish a spread, publish a rate, generate them
          all, retire one — is gated on this field being filled, so the red
          "Enter transaction pin" that was being reported cannot be reached at
          all: there is no button to press until there is a PIN to send.
          
          It stays filled between actions. See `act` above for why.
        */}
        <label>
          Your transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <span className="hint">
            Required for every button on this page — each one changes what
            customers are charged. It is kept until you leave.
          </span>
        </label>
        {error !== undefined && <p className="error">{error}</p>}
      </div>

      {/*
        WHAT A CURRENCY IS WORTH, which nothing could set before.

        `fx_spread_policies` — the panel below — publishes a MARGIN, and the
        RATE has always come from the provider. For NGN→USD that is right:
        there is a market, Bitnob quotes it, and a number typed here would
        drift from the one the swap executes at. FOR NGN→GHS THERE IS NO SUCH
        PROVIDER, so the pair could be given a margin, look published, and
        refuse every customer — on exactly the corridor this platform exists
        for.

        Publishing a rate is therefore also a decision to be the counterparty:
        the swap settles out of our own float in both currencies rather than
        through a provider.
      */}
      <div className="panel">
        <div className="section-head">
          <h2>Exchange rates</h2>
          {/*
            GENERATE THEM. The worker does this daily; this is the button for
            the afternoon the market moves — and it is what makes typing a rate
            by hand optional rather than the only way to have one.
            
            IT WAS THE ONE CONTROL ON THIS PAGE NOT GATED ON THE PIN, which is
            the bug that was reported: pressing it with an empty box sent no
            PIN, the server answered `transaction_pin_required`, and the
            operator got "Enter your transaction PIN" in red beside a field
            they had not been told they needed to fill first. Every other
            action here has had `pin === ''` in its `disabled` since it was
            written; this one was added later and missed it.
            
            It republishes only what changed and never touches a rate a person
            published — a deliberate price outranks a market one.
          */}
          <button
            type="button"
            className="small"
            disabled={busy || pin === ''}
            title={pin === '' ? 'Enter your transaction PIN above first' : undefined}
            onClick={() => {
              // `act` reloads the table, so the feedback is the ages resetting
              // to minutes — which is the number that matters here anyway.
              void act(() => admin.refreshFxRates(pin));
            }}
          >
            <Icon name="swap" size={15} /> Generate rates
          </button>
        </div>
        <p className="lead">
          What we sell a currency for, in the direction stated. A pair with a
          rate here is one we quote ourselves; a pair with none is quoted by
          the provider. Rates marked automatic are refreshed from
          ExchangeRate-API — paste its key at{' '}
          <Link href="/admin/credentials">Credentials</Link> — and one you
          publish by hand is never overwritten.
        </p>
        {(rates.data?.length ?? 0) === 0 && (
          <p className="empty">
            No rate is published. Every pair is quoted by the provider, which
            refuses any corridor it does not cover.
          </p>
        )}
        {(rates.data?.length ?? 0) > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Rate</th>
                  <th>Our margin</th>
                  <th>Published by</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {ratesInOperationFirst(rates.data ?? [], operating).map((row) => (
                  <tr key={row.uuid}>
                    <td>
                      {row.base_currency}&rarr;{row.quote_currency}
                    </td>
                    <td className="mono">
                      1 {row.base_currency} = {row.quote_per_base} {row.quote_currency}
                    </td>
                    <td>
                      {row.spread_basis_points === null ? (
                        // A rate with no margin is not a zero margin: it is a
                        // pair somebody priced and did not finish pricing,
                        // and a quote against it will be refused for want of
                        // a policy rather than for want of a rate.
                        <span className="badge warn">no spread published</span>
                      ) : (
                        `${(row.spread_basis_points / 100).toFixed(2)}%`
                      )}
                    </td>
                    <td>
                      {row.source === 'reference_feed' ? (
                        <span className="badge">automatic</span>
                      ) : (
                        (row.created_by ?? <em>at a prompt</em>)
                      )}
                    </td>
                    {/*
                      HOW OLD, because the way this feature fails is that the
                      feed stops and nothing errors: the rows stay, this table
                      renders, and customers are quoted whatever it last said.
                    */}
                    <td className="mono">{ageOf(row.age_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PublishFx pin={pin} busy={busy} onPublish={act} />
      <PublishRate pin={pin} busy={busy} onPublish={act} />

      <PublishFxRate pin={pin} busy={busy} onPublish={act} />


      <div className="panel">
        <h2>FX spreads</h2>
        <p className="lead">
          Each direction is priced separately: publishing NGN→USD does not publish
          USD→NGN.
        </p>
        <table>
          <thead>
            <tr>
              <th>Pair</th>
              <th>Spread</th>
              <th>Minimum</th>
              <th>Published by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prices.data?.fx_policies.map((row) => (
              <tr key={row.uuid} className={row.retired_at !== null ? 'muted' : undefined}>
                <td>
                  {row.base_currency}&rarr;{row.quote_currency}
                </td>
                <td>{(row.spread_basis_points / 100).toFixed(2)}%</td>
                <td>{formatMinor(row.min_base_minor, row.base_currency)}</td>
                <td>{row.published_by ?? <em>at a prompt</em>}</td>
                <td>
                  {row.retired_at === null ? (
                    <Retire uuid={row.uuid} kind="fx" pin={pin} busy={busy} onRetire={act} />
                  ) : (
                    <span className="badge">retired</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Gift card rates</h2>
        <p className="lead">
          Rates are banded by face value. Two live bands for one card may not
          overlap.
        </p>
        <table>
          <thead>
            <tr>
              <th>Card</th>
              <th>Band</th>
              <th>Rate</th>
              <th>Published by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prices.data?.rate_cards.map((row) => (
              <tr key={row.uuid} className={row.retired_at !== null ? 'muted' : undefined}>
                <td>
                  {row.brand} {row.country} {row.card_type}
                </td>
                <td>
                  {formatMinor(row.min_face_minor, row.face_currency)} &ndash;{' '}
                  {formatMinor(row.max_face_minor, row.face_currency)}
                </td>
                <td>
                  {formatMinor(row.payout_rate_minor, row.payout_currency)} per{' '}
                  {row.face_currency}
                </td>
                <td>{row.published_by ?? <em>at a prompt</em>}</td>
                <td>
                  {row.retired_at === null ? (
                    <Retire uuid={row.uuid} kind="giftcard" pin={pin} busy={busy} onRetire={act} />
                  ) : (
                    <span className="badge">retired</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PublishFx({
  pin,
  busy,
  onPublish,
}: {
  pin: string;
  busy: boolean;
  onPublish: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [base, setBase] = useState('NGN');
  const [quote, setQuote] = useState('USD');
  const [spread, setSpread] = useState('150');
  const [minimum, setMinimum] = useState('100000');

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void onPublish(() =>
          admin.publishFxSpread(
            {
              base_currency: base,
              quote_currency: quote,
              spread_basis_points: Number(spread),
              min_base_minor: minimum,
            },
            pin,
          ),
        );
      }}
    >
      <h2>Publish an FX spread</h2>
      <div className="field-row two">
        <label>
          From
          <input value={base} onChange={(e) => setBase(e.target.value)} maxLength={3} required />
        </label>
        <label>
          To
          <input value={quote} onChange={(e) => setQuote(e.target.value)} maxLength={3} required />
        </label>
      </div>
      <div className="field-row two">
        <label>
          Spread (basis points)
          <input
            inputMode="numeric"
            value={spread}
            onChange={(e) => setSpread(e.target.value)}
            required
          />
          {/* Basis points, never a percentage: 150 is 1.5%. A decimal margin
              is a float in disguise and this one multiplies every conversion. */}
          <span className="hint">150 = 1.5%. Capped at 10000.</span>
        </label>
        <label>
          Minimum (minor units of {base || 'the base currency'})
          <input
            inputMode="numeric"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
            required
          />
          <span className="hint">
            Below this a conversion is refused rather than quoted — FX on a
            trivial amount rounds to nothing and still costs a provider call.
          </span>
        </label>
      </div>
      <button type="submit" disabled={busy || pin === ''}>
        Publish
      </button>
    </form>
  );
}

function PublishRate({
  pin,
  busy,
  onPublish,
}: {
  pin: string;
  busy: boolean;
  onPublish: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [brand, setBrand] = useState('');
  const [country, setCountry] = useState('US');
  const [cardType, setCardType] = useState<'ecode' | 'physical'>('ecode');
  const [faceCurrency, setFaceCurrency] = useState('USD');
  const [payoutCurrency, setPayoutCurrency] = useState('NGN');
  const [rate, setRate] = useState('');
  const [minFace, setMinFace] = useState('');
  const [maxFace, setMaxFace] = useState('');

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void onPublish(() =>
          admin.publishRateCard(
            {
              brand,
              country,
              card_type: cardType,
              face_currency: faceCurrency,
              payout_currency: payoutCurrency,
              payout_rate_minor: rate,
              min_face_minor: minFace,
              max_face_minor: maxFace,
            },
            pin,
          ),
        );
      }}
    >
      <h2>Publish a gift card rate</h2>
      <div className="field-row two">
        <label>
          Brand
          <input value={brand} onChange={(e) => setBrand(e.target.value)} required />
        </label>
        <label>
          Country
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            maxLength={2}
            required
          />
        </label>
      </div>
      <div className="field-row two">
        <label id="price-card-type">
          Type
          <Select
            labelledBy="price-card-type"
            value={cardType}
            onChange={(value) => setCardType(value as 'ecode' | 'physical')}
            options={[
              { value: 'ecode', label: 'E-code' },
              { value: 'physical', label: 'Physical' },
            ]}
          />
        </label>
        <label>
          Face currency
          <input
            value={faceCurrency}
            onChange={(e) => setFaceCurrency(e.target.value)}
            maxLength={3}
            required
          />
        </label>
      </div>
      <div className="field-row two">
        <label>
          Paid in
          <input
            value={payoutCurrency}
            onChange={(e) => setPayoutCurrency(e.target.value)}
            maxLength={3}
            required
          />
        </label>
        <label>
          Rate (minor units of {payoutCurrency || 'payout'} per 1 {faceCurrency || 'face'})
          <input inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} required />
          <span className="hint">₦1,250.00 per $1 is 125000.</span>
        </label>
      </div>
      <div className="field-row two">
        <label>
          Band from (minor units of face)
          <input
            inputMode="numeric"
            value={minFace}
            onChange={(e) => setMinFace(e.target.value)}
            required
          />
        </label>
        <label>
          Band to
          <input
            inputMode="numeric"
            value={maxFace}
            onChange={(e) => setMaxFace(e.target.value)}
            required
          />
          <span className="hint">
            Inclusive at both ends, and may not overlap a live band for this
            card.
          </span>
        </label>
      </div>
      <button type="submit" disabled={busy || pin === ''}>
        Publish
      </button>
    </form>
  );
}

function Retire({
  uuid,
  kind,
  pin,
  busy,
  onRetire,
}: {
  uuid: string;
  kind: 'fx' | 'giftcard';
  pin: string;
  busy: boolean;
  onRetire: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');

  return (
    <span style={{ display: 'flex', gap: 8 }}>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why (at least ten characters)"
      />
      <button
        type="button"
        className="ghost small"
        disabled={busy || pin === '' || reason.trim().length < 10}
        onClick={() => {
          void onRetire(() => admin.retirePrice(uuid, kind, reason, pin));
        }}
      >
        Retire
      </button>
    </span>
  );
}

/**
 * Publishing what a currency is worth.
 *
 * THE OPERATOR TYPES A DECIMAL, because that is how a person says a rate and
 * the only form they can check: "1 NGN = 0.0078 GHS". The ratio of integers
 * the ledger actually uses is derived from it server-side, scaled by each
 * currency's own exponent — a rate built on an assumed two decimal places
 * would be wrong by a power of ten in exactly the pairs nobody tests.
 *
 * IT CROSSES THE WIRE AS A STRING and is never parsed to a number here. By
 * the time a decimal is a JS number the precision is already gone, which is
 * the rule `fromMajor()` follows.
 *
 * EACH DIRECTION IS PUBLISHED SEPARATELY. NGN→GHS says nothing about GHS→NGN,
 * and an operator who publishes one and assumes the other has a corridor that
 * works one way and refuses the other with nothing on screen saying so.
 */
function PublishFxRate({
  pin,
  busy,
  onPublish,
}: {
  pin: string;
  busy: boolean;
  onPublish: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [base, setBase] = useState('NGN');
  const [quote, setQuote] = useState('GHS');
  const [rate, setRate] = useState('');

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void onPublish(() =>
          admin.publishFxRate(
            { base_currency: base, quote_currency: quote, quote_per_base: rate },
            pin,
          ),
        );
      }}
    >
      <h2>Publish an exchange rate</h2>
      <p className="lead">
        Set what a currency is worth where no provider quotes the pair. A rate
        here makes us the counterparty: the swap settles out of our own float
        in both currencies.
      </p>
      <div className="field-row two">
        <label>
          From
          <input
            value={base}
            onChange={(e) => setBase(e.target.value.toUpperCase())}
            maxLength={5}
            required
          />
        </label>
        <label>
          To
          <input
            value={quote}
            onChange={(e) => setQuote(e.target.value.toUpperCase())}
            maxLength={5}
            required
          />
        </label>
      </div>
      <label>
        1 {base || '—'} buys how many {quote || '—'}?
        <input
          inputMode="decimal"
          placeholder="0.0078"
          value={rate}
          // Digits and ONE dot. Anything else is refused by the schema and by
          // the column's CHECK, and letting it be typed only moves the
          // refusal to after the PIN.
          onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))}
          required
        />
        <span className="hint">
          As many decimal places as it takes — 0.0078 is a legitimate rate in
          the direction where one unit buys very little.
        </span>
      </label>
      <button type="submit" disabled={busy || pin === '' || rate === ''}>
        {busy ? 'Publishing…' : 'Publish rate'}
      </button>
    </form>
  );
}

/**
 * How long ago, in words an operator can act on.
 *
 * The number that matters here is not the rate, it is its AGE — the way this
 * feature fails is that the feed stops and nothing errors, so the table goes
 * on rendering a plausible price from whenever it last worked. Whole days once
 * it is past one, because "3 days" is a decision and "72h" is arithmetic.
 */
function ageOf(seconds: string | number | undefined): string {
  if (seconds === undefined) return '—';
  const value = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (!Number.isFinite(value)) return '—';
  if (value < 3600) return `${Math.max(0, Math.round(value / 60))}m`;
  if (value < 86_400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86_400)}d`;
}

/**
 * The corridors this platform runs on, first.
 *
 * A pair BOTH of whose currencies are in operation is a corridor a customer
 * can actually be quoted today; one with a single side is a rate we hold for
 * a country not yet open; the rest — Bitcoin against the world, and every
 * other pair the feed answers — are reference, and belong under them.
 *
 * Stable within each group: the API already returns them ordered by base and
 * quote, and `sort` in V8 is stable, so nothing moves around under somebody
 * reading the table.
 */
function ratesInOperationFirst<T extends { base_currency: string; quote_currency: string }>(
  rows: readonly T[],
  operating: ReadonlySet<string>,
): readonly T[] {
  const rank = (row: T): number => {
    const base = operating.has(row.base_currency);
    const quote = operating.has(row.quote_currency);
    if (base && quote) return 0;
    return base || quote ? 1 : 2;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}
