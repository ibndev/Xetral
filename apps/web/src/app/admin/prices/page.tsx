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
  /*
   * WHAT THIS OPERATOR MAY DO, so a control they cannot use is not drawn.
   *
   * Only `admin` may DELETE a retired rate, and the ROUTE is what enforces
   * that — this read decides whether the button appears, never whether it
   * works. Showing it to everybody and letting the server refuse is the shape
   * that teaches people controls here may or may not do anything, and then a
   * real refusal stops being read.
   *
   * Its own load, allowed to fail: an API predating `/v1/admin/me` answers
   * 404 and this screen must still render every panel it already had.
   */
  const me = useLoad(() => admin.myRoles().catch(() => [] as readonly string[]), [admin]);
  const isAdmin = (me.data ?? []).includes('admin');

  const countries = useLoad(() => admin.countries(), [admin]);
  const operating = new Set<string>([
    ...(countries.data?.countries ?? []).filter((c) => c.enabled).map((c) => c.currency),
    // The dollar and the stablecoins belong to no country and are held across
    // all of them — the same exception `wallet.service.ts` names.
    'USD',
    'USDT',
    'USDC',
  ]);
  /* The PIN for the one action that lives on this panel — generating rates.
   * Every other action owns its own, beside the form it authorises. */
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /*
   * WHAT THE LAST GENERATE ACTUALLY DID.
   *
   * Without it the button is indistinguishable from a button that does
   * nothing, which is exactly how it was reported: with no ExchangeRate-API
   * key every base fails, the sweep publishes nothing, the table reloads
   * unchanged, and the screen says NOTHING AT ALL. The report is four
   * numbers the sweep already returns and nobody was reading.
   */
  const [report, setReport] = useState<string | undefined>();

  /**
   * Refresh every corridor from the feed, and SAY WHAT HAPPENED.
   *
   * ONE FUNCTION FOR BOTH BUTTONS — the one beside the PIN and the one in the
   * Exchange rates header — because two copies of "what generating does" is
   * two behaviours, and the copy that drifts is the one nobody presses.
   */
  async function generate(): Promise<void> {
    await act(async () => {
      const done = await admin.refreshFxRates(pin);
      /*
       * THE ALL-FAILED CASE NAMES THE CAUSE, because it is almost always one
       * thing: no ExchangeRate-API key. Without this the button is
       * indistinguishable from a button that does nothing — every base fails,
       * nothing publishes, the table reloads unchanged and the screen says
       * nothing at all. That is what "the button is not functioning" was.
       */
      setReport(
        done.published === 0 && done.failed > 0
          ? `No rates could be fetched (${done.failed} failed). Paste an ` +
              `ExchangeRate-API key on the Credentials screen — an unset or ` +
              `expired key fails exactly like this.`
          : done.published === 0
            ? `Nothing changed: ${done.unchanged} already current, ` +
              `${done.operatorHeld} held by an operator.`
            : `Published ${done.published}, unchanged ${done.unchanged}, ` +
              `held by an operator ${done.operatorHeld}, failed ${done.failed}.`,
      );
      return done;
    });
  }

  async function act(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setReport(undefined);
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
          THE SHARED PIN PANEL IS GONE, and its removal is the fix rather than
          a tidy-up.
          
          One field at the top of the page authorised five actions further
          down, and NOTHING said so at the point of use. Retire was the worst
          case: its button is disabled until a reason of ten characters AND a
          PIN exist, so an operator who typed a perfectly good reason got a
          dead button with its cause a full screen away — "I try to retire it,
          the button is not responding".
          
          Every action now carries its own PIN, beside the thing it
          authorises. That is one more box to type in and it is the box the
          operator is already looking at.
        */}
        {error !== undefined && <p className="error">{error}</p>}
      </div>

      {/*
        THE ORDER IS THE ORDER SOMEBODY WORKS IN, and it was not.

        A pair is priced in two acts — a spread, then a rate — and the page
        opened with the RATES TABLE, which is the output of both. So the
        first thing on the screen was a result and the controls that produce
        it were below the fold, in an order that matched neither.

        Each publish form now sits directly above the table it writes into,
        so pressing the button and reading the row are one movement; and the
        rates table is last because it is the longest and the one an operator
        reads rather than acts on.
      */}
      <PublishFx busy={busy} onPublish={act} />

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
              <th>Quoted at</th>
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
                {/*
                  WHAT A CUSTOMER IS ACTUALLY CHARGED, which is not always the
                  column to its left.
                  
                  When the payout currency has strengthened since this pair's
                  rate was last published, 062 widens the spread to put back the
                  margin the stale rate is giving away. That changes a price, so
                  it is shown: a mechanism that quietly charges more than the
                  published number is the kind of thing nobody can audit
                  afterwards. A widened row is also a pair overdue a republish,
                  which is the action that clears it.
                */}
                <td>
                  {row.retired_at !== null ||
                  row.effective_basis_points == null ||
                  row.effective_basis_points === row.spread_basis_points ? (
                    <span className="hint">as published</span>
                  ) : (
                    <span className="badge warn">
                      {(row.effective_basis_points / 100).toFixed(2)}% — payout currency up{' '}
                      {((row.adverse_basis_points ?? 0) / 100).toFixed(2)}%
                    </span>
                  )}
                </td>
                <td>{formatMinor(row.min_base_minor, row.base_currency)}</td>
                <td>{row.published_by ?? <em>at a prompt</em>}</td>
                <td>
                  {row.retired_at === null ? (
                    <Retire uuid={row.uuid} kind="fx" busy={busy} onRetire={act} />
                  ) : (
                    <span className="badge">retired</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PublishFxRate busy={busy} onPublish={act} />

      <PublishRate busy={busy} onPublish={act} />

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
                    <Retire uuid={row.uuid} kind="giftcard" busy={busy} onRetire={act} />
                  ) : (
                    <span className="badge">retired</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        </div>
        {/*
          GENERATE IS BACK, AND ITS REMOVAL WAS A REGRESSION RATHER THAN A
          DECISION.
          
          This button lived on a shared PIN panel at the top of the page. That
          panel was removed — correctly, because one field a screen away was
          authorising five actions and nothing said so at the point of use —
          and the button went with it. Nothing failed: `generate()` stayed
          defined, called by nobody, and the only way to refresh a corridor
          became waiting for the worker.
          
          It carries its OWN PIN now, like every other action on this page, and
          the reason it is grey is written beside it rather than in a `title` —
          a tooltip does not exist on a touch screen, which is what "the button
          is not clickable and does nothing" was the first time.
        */}
        <div className="stack">
          <label htmlFor="fx-refresh-pin">Transaction PIN</label>
          <input
            id="fx-refresh-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
          />
          <button type="button" onClick={() => void generate()} disabled={busy || pin === ''}>
            {busy ? 'Generating…' : 'Generate latest exchange rate'}
          </button>
          {pin === '' && <span className="hint">Enter your PIN to refresh from the market</span>}
          {/* WHAT IT DID, because with no ExchangeRate-API key every base
              fails, nothing publishes, the table reloads unchanged and the
              screen would otherwise say nothing at all. */}
          {report !== undefined && <p className="hint">{report}</p>}
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
          <div className="scroll capped">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Rate</th>
                  <th>Our margin</th>
                  <th>Published by</th>
                  <th>Age</th>
                  {/* Empty header: the column holds one action and only for
                      some rows, so a label would name a thing most rows do
                      not have. */}
                  <th />
                </tr>
              </thead>
              <tbody>
                {ratesInOperationFirst(rates.data ?? [], operating).map((row) => (
                  <tr
                    key={row.uuid}
                    /* Greyed the way the spreads table above greys a retired
                       policy, so "not in force" reads the same in both. */
                    className={row.retired_at != null ? 'muted' : undefined}
                  >
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
                    {/*
                      DELETE, and only for a RETIRED rate, and only for an
                      `admin`.

                      A live rate has no button at all rather than a disabled
                      one: 064 refuses it in the DATABASE because deleting one
                      unprices the corridor, and offering a control whose only
                      outcome is a refusal is worse than not offering it.

                      What is lost is an offer nobody took — `fx_trades`
                      carries its own applied ratio, so no transaction reads
                      its price back through this table. That is the whole
                      reason this can exist.
                    */}
                    <td>
                      {isAdmin && row.retired_at != null && (
                        <button
                          type="button"
                          className="btn small danger"
                          disabled={busy || pin === ''}
                          onClick={() =>
                            void act(async () => {
                              await admin.deleteFxRate(
                                row.uuid,
                                'removed a retired rate from the prices screen',
                                pin,
                              );
                            })
                          }
                        >
                          Delete
                        </button>
                      )}
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

function PublishFx({
  busy,
  onPublish,
}: {
  busy: boolean;
  onPublish: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [pin, setPin] = useState('');
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
      {/*
        THE PIN, BESIDE THE THING IT AUTHORISES — and INLINE rather than in a
        shared component, because `pin-fields.test.ts` recognises a PIN box
        structurally (a numeric password field) and a wrapper hides it from
        that check. The guard is right to be literal: what it is protecting
        against is a control gated on a PIN with nowhere on screen to type
        one, and a component that merely promises to render one is exactly
        how that reappears.
      */}
      <label>
        Transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy || pin === ''}>
        Publish
      </button>
    </form>
  );
}

function PublishRate({
  busy,
  onPublish,
}: {
  busy: boolean;
  onPublish: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [pin, setPin] = useState('');
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
      {/*
        THE PIN, BESIDE THE THING IT AUTHORISES — and INLINE rather than in a
        shared component, because `pin-fields.test.ts` recognises a PIN box
        structurally (a numeric password field) and a wrapper hides it from
        that check. The guard is right to be literal: what it is protecting
        against is a control gated on a PIN with nowhere on screen to type
        one, and a component that merely promises to render one is exactly
        how that reappears.
      */}
      <label>
        Transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy || pin === ''}>
        Publish
      </button>
    </form>
  );
}

function Retire({
  uuid,
  kind,
  busy,
  onRetire,
}: {
  uuid: string;
  kind: 'fx' | 'giftcard';
  busy: boolean;
  onRetire: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');

  /*
   * BOTH FIELDS ARE HERE, AND THAT IS THE FIX.
   *
   * This button is disabled until a reason of at least ten characters AND a
   * PIN exist. The reason was typed here; the PIN lived at the top of the
   * page, a full screen away and unmentioned — so an operator with a good
   * reason got a dead button and no way to see why. "I try to retire it, the
   * button is not responding" is exactly that.
   *
   * `price.retire` is in 009's must-say-why list, so the reason is not
   * negotiable: retiring looks like tidying and its effect is that the flow
   * refuses every customer until a replacement is published.
   */
  const ready = reason.trim().length >= 10 && pin !== '';

  return (
    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why (at least ten characters)"
      />
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        placeholder="PIN"
        style={{ maxWidth: 96 }}
      />
      <button
        type="button"
        className="ghost small"
        disabled={busy || !ready}
        onClick={() => {
          void onRetire(() => admin.retirePrice(uuid, kind, reason, pin));
        }}
      >
        Retire
      </button>
      {/* WHY IT IS GREY, ON THE PAGE. A disabled control whose reason is not
          written down is a broken control to whoever is looking at it. */}
      {!ready && (
        <span className="hint">
          {reason.trim().length < 10 ? 'Give a reason of ten characters or more' : 'Enter your PIN'}
        </span>
      )}
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
  busy,
  onPublish,
}: {
  busy: boolean;
  onPublish: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = useAdmin();
  const [pin, setPin] = useState('');
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
      {/*
        THE PIN, BESIDE THE THING IT AUTHORISES — and INLINE rather than in a
        shared component, because `pin-fields.test.ts` recognises a PIN box
        structurally (a numeric password field) and a wrapper hides it from
        that check. The guard is right to be literal: what it is protecting
        against is a control gated on a PIN with nowhere on screen to type
        one, and a component that merely promises to render one is exactly
        how that reappears.
      */}
      <label>
        Transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
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
