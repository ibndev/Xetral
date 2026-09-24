'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { CatalogueItem, Purchase } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { FormError } from '@/ui/form-error';
import { Toast } from '@/ui/toast';
import { messageFor } from '@/lib/errors';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * TRAVEL eSIM, ON ITS OWN SCREEN — the comp's own page.
 *
 * It was a fourth tile inside Bills, behind "What to buy" as a dropdown of
 * plan names. An eSIM is not a bill: somebody opening it is choosing a
 * DESTINATION, so the comp's shape is a search for a country and a list of
 * plans with their prices, and buying one is the second step, not the first.
 *
 * THE MONEY PATH IS UNCHANGED, deliberately. It is the same purchase flow
 * every bill uses — reserve, ask Airalo, settle or reverse — through the same
 * `client.buy({ service: 'esim' })`, so nothing about how a customer is
 * charged differs between the two screens. Only what they see first does.
 *
 * THE LIST IS THE PROVIDER'S CATALOGUE, not the comp's three examples. The
 * comp draws the United States and the United Kingdom as flags; the
 * catalogue's names are the provider's own, and a flag drawn beside a name
 * this screen did not choose would be a guess about what the package covers.
 */
export default function Esim() {
  const client = useXetral();
  const [items, setItems] = useState<readonly CatalogueItem[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CatalogueItem | undefined>();
  const history = useLoad(() => client.purchases(), [client]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const loaded = await client.catalogue('esim');
        if (live) setItems(loaded);
      } catch (cause) {
        // A catalogue that will not load is a provider not configured, and
        // saying so beats an empty list the customer keeps searching.
        if (live) setLoadError(messageFor(cause));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [client]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? items : items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, query]);

  const mine = (history.data ?? []).filter((p) => p.service === 'esim');

  return (
    <Shell back="/more" title="Travel eSIM">
      <p className="page-lede">
        Stay connected abroad. Data only, installed as a second SIM beside your own line.
      </p>

      <section className="sf esim">
        <div className="sf-search">
          <Icon name="search" size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a country"
            aria-label="Search a country"
          />
        </div>

        {picked !== undefined ? (
          <Buy
            item={picked}
            onCancel={() => setPicked(undefined)}
            onBought={() => {
              history.reload();
            }}
          />
        ) : (
          <>
            <div className="sf-section-label">{query.trim() === '' ? 'Plans' : 'Matching plans'}</div>
            {loading && <p className="spinner">Loading…</p>}
            {loadError !== undefined && (
              <div className="notice warn">
                <p>{loadError}</p>
              </div>
            )}
            {!loading && loadError === undefined && shown.length === 0 && (
              <p className="empty">
                {items.length === 0 ? 'No plans are available right now.' : 'No plan matches that search.'}
              </p>
            )}
            <div className="list">
              {shown.map((item) => (
                <button
                  type="button"
                  key={item.code}
                  className="list-row tappable"
                  onClick={() => setPicked(item)}
                >
                  <span className="row-icon esim-globe" aria-hidden>
                    <Icon name="globe" size={20} />
                  </span>
                  <span className="row-main">
                    {/* The provider's name carries the plan — country, data and
                        days — so it is allowed two lines rather than a sub
                        line repeating one sentence on every row. */}
                    <span className="row-title">{item.name}</span>
                  </span>
                  <span className="row-value">
                    {item.price === null ? 'Varies' : formatAmount(item.price, item.currency)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {mine.length > 0 && (
        <div className="card">
          <h2>Your eSIMs</h2>
          {mine.map((p) => (
            <EsimRow key={p.id} purchase={p} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function Buy(props: {
  readonly item: CatalogueItem;
  readonly onCancel: () => void;
  readonly onBought: () => void;
}) {
  const client = useXetral();
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const attempt = useIdempotencyKey();
  const { busy, error, code, done, run, clear } = useSubmit();

  return (
    <form
      className="send-step esim-buy"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const purchase = await client.buy({
            service: 'esim',
            itemCode: props.item.code,
            target: email.trim(),
            amount: props.item.price ?? '',
            pin,
            idempotencyKey: attempt.key,
          });
          attempt.next();
          setPin('');
          props.onBought();
          return purchase.status === 'delivered'
            ? 'Done. The QR code is on its way to your email.'
            : 'Submitted. We will email the QR code shortly.';
        });
      }}
    >
      <div className="esim-picked">
        <span className="row-icon esim-globe" aria-hidden>
          <Icon name="globe" size={20} />
        </span>
        <span className="row-main">
          <span className="row-title">{props.item.name}</span>
          <span className="row-sub">
            {props.item.price === null ? 'Price confirmed at checkout' : formatAmount(props.item.price, props.item.currency)}
          </span>
        </span>
        <button type="button" className="quiet small" onClick={props.onCancel}>
          Change
        </button>
      </div>

      <label className="field">
        <span className="field-label">Email for the QR code</span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Transaction PIN</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
      </label>

      <button type="submit" disabled={busy || props.item.price === null}>
        {busy
          ? 'Working…'
          : props.item.price === null
            ? 'Not available'
            : `Pay ${formatAmount(props.item.price, props.item.currency)}`}
      </button>

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}
      <Toast message={done} tone="ok" onDone={clear} />
      <Toast message={error} tone="bad" onDone={clear} />
    </form>
  );
}

function EsimRow({ purchase }: { purchase: Purchase }) {
  const badge =
    purchase.status === 'delivered'
      ? 'ok'
      : purchase.status === 'failed' || purchase.status === 'reversed'
        ? 'danger'
        : 'warn';
  return (
    <div className="row">
      <span>
        <span className="mono">{purchase.target}</span>
        {/* Held is not failed, and must not read as one — the money is
            reserved and a sweep will resolve it. */}
        {purchase.status === 'reserved' && (
          <div className="hint">Waiting on the provider. Your money is held, not spent.</div>
        )}
        {purchase.delivery !== null && (
          <div className="hint mono">
            {Object.entries(purchase.delivery).map(([k, v]) => (
              <div key={k}>
                {k}: {v}
              </div>
            ))}
          </div>
        )}
      </span>
      <span className="nowrap">
        <span className="amount">{formatAmount(purchase.amount, purchase.currency)}</span>{' '}
        <span className={`badge ${badge}`}>{purchase.status}</span>
      </span>
    </div>
  );
}
