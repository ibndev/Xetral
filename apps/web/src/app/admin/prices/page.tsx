'use client';

import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { Select } from '@/ui/select';

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
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function act(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      prices.reload();
      setPin('');
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
          Every FX spread and gift card rate a customer can be quoted. Prices
          are never edited — retire one and publish its replacement, so a quote
          given last month can still be explained.
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
              These were written at a database prompt rather than here, so
              nobody is recorded as having set them. Retire and republish to
              put a name on the price.
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
            Required for every publish and every retirement — both change what
            customers are charged.
          </span>
        </label>
        {error !== undefined && <p className="error">{error}</p>}
      </div>

      <PublishFx pin={pin} busy={busy} onPublish={act} />
      <PublishRate pin={pin} busy={busy} onPublish={act} />

      <div className="panel">
        <h2>FX spreads</h2>
        <p className="lead">
          Each DIRECTION is priced separately: publishing NGN→USD does not
          publish USD→NGN. A rate is a ratio, and one direction&rsquo;s units
          collapse in the other.
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
          Rates are banded by face value, because a $500 card resells for
          proportionally less than a $25 one. Two live bands for one card may
          not overlap — an overlap would silently reprice the range they share.
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
