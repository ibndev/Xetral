'use client';

import Link from 'next/link';
import { formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import type { IconName } from '@/ui/icon';
import { useLoad, useRemembered, useXetral } from '@/lib/hooks';

/** A currency code out of storage, before it is matched against what the API
 *  actually offers. Shape only — the list is the real check. */
const looksLikeACurrency = (stored: string) => /^[A-Z]{3,6}$/.test(stored);

/** A fixed mask. As many dots as the amount has digits would be a picture of
 *  the number, and the digit count is most of what a glance reads. */
const MASK = '\u2022 \u2022 \u2022 \u2022 \u2022 \u2022';

/** Zero, written the way this currency writes it — "0.00" for naira,
 *  "0.000000" for USDT. The API sends major units, so the string differs. */
const isZero = (amount: string) => /^-?0(\.0+)?$/.test(amount);

/** The four products, in the order the design puts them. */
const PRODUCTS: readonly {
  href: string; label: string; icon: IconName; tone: string;
}[] = [
  { href: '/bills',  label: 'Bills',     icon: 'receipt', tone: 't-amber' },
  { href: '/crypto', label: 'Crypto',    icon: 'bitcoin', tone: 't-green' },
  { href: '/bills',  label: 'eSIM',      icon: 'sim',     tone: 't-blue' },
  { href: '/cards',  label: 'USD Card',  icon: 'card',    tone: 't-navy' },
];

export default function Wallet() {
  const client = useXetral();

  /*
   * BOTH OF THESE ARE REMEMBERED, and hiding is the one that matters.
   *
   * It was plain component state, so a refresh — or simply coming back to this
   * screen — put the balance back on the display. A customer who hides it is
   * telling us something about the room they are standing in; making them say
   * it again on every load means the number is shown at least once in that
   * room every time, which is the exact thing they asked us not to do.
   *
   * `hidden` is also the fallback, so the first paint of an unknown preference
   * is dots rather than a figure. See `useRemembered`.
   */
  const [visibility, setVisibility] = useRemembered<'hidden' | 'shown'>(
    'xetral-balance-visibility',
    'hidden',
    (stored) => stored === 'hidden' || stored === 'shown',
  );
  const hidden = visibility === 'hidden';

  // `<string>` explicitly: inferred from the fallback it would be the literal
  // type 'NGN', and the setter would then refuse every other currency.
  const [preferred, setPreferred] = useRemembered<string>(
    'xetral-wallet-currency',
    'NGN',
    looksLikeACurrency,
  );

  const balances = useLoad(() => client.balances(), [client]);

  /*
   * EVERY CURRENCY THE PLATFORM OFFERS, not only the ones this customer has
   * happened to receive.
   *
   * `/v1/wallets` reads the accounts table, and an account is created by its
   * first posting — so a customer who had never held a dollar had no USD row
   * and this screen correctly concluded the product was naira-only. The API
   * now returns a zero row for everything it offers, so what is rendered here
   * is the platform's answer rather than an accident of transaction history.
   */
  const assets = balances.data ?? [];
  const active = assets.find((b) => b.currency === preferred) ?? assets[0];
  const currency = active?.currency ?? 'NGN';

  const history = useLoad(
    () => client.transactions(currency).catch(() => ({ entries: [], nextCursor: null })),
    [client, currency],
  );

  // Listed separately only where there is money. A rail of zeroes under a
  // selector that already offers every currency is noise.
  const others = assets.filter((b) => b.currency !== currency && !isZero(b.total));

  return (
    <Shell>
      <h1 className="animate-in">Hello there</h1>
      <p className="lead animate-in d1">Here is where your money stands today.</p>

      <section className="balance-card animate-in d1">
        <div className="row-between">
          <span className="balance-label">Available balance</span>
          <span className="badge">{currency}</span>
        </div>

        <div className="balance-line">
          {/* Keyed on the state so React replaces the node and the figure
              cross-fades instead of snapping between dots and digits. The
              global reduced-motion rule turns it off for anybody who asked. */}
          <div className="balance-value fade-in" key={hidden ? 'masked' : 'shown'}>
            {balances.loading ? (
              <span className="skeleton" style={{ display: 'block', width: 190, height: 38 }} />
            ) : hidden ? (
              `${symbolFor(currency)} ${MASK}`
            ) : (
              formatAmount(active?.spendable ?? '0.00', currency)
            )}
          </div>
          {/*
            Hiding the balance is not decoration. Somebody checks their phone
            in a danfo with a stranger's shoulder at theirs, and one tap is
            the difference between that being fine and not. Which is also why
            the choice is remembered rather than reset by a reload.
          */}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setVisibility(hidden ? 'shown' : 'hidden')}
            aria-pressed={hidden}
            aria-label={hidden ? 'Show balance' : 'Hide balance'}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={20} />
          </button>
        </div>

        {active !== undefined && !isZero(active.pending) && (
          <div className="balance-sub">
            {formatAmount(active.pending, currency)} pending — held, not yet spendable
          </div>
        )}

        {/*
          The currency rail. It scrolls sideways rather than wrapping, because
          a second row of chips pushes Send and Top up below the fold on a
          360px phone — and those are what most people opened the app for.
        */}
        {assets.length > 1 && (
          <div className="asset-rail" role="tablist" aria-label="Currency">
            {assets.map((b: Balance) => (
              <button
                key={b.currency}
                type="button"
                role="tab"
                aria-selected={b.currency === currency}
                className={b.currency === currency ? 'asset-chip active' : 'asset-chip'}
                onClick={() => setPreferred(b.currency)}
              >
                <span className="asset-code">{b.currency}</span>
                <span className="asset-amount">
                  {hidden ? MASK : formatAmount(b.spendable, b.currency)}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="quick-actions">
          <Link href="/transfer" className="btn">
            <Icon name="send" size={17} /> Send
          </Link>
          <Link href="/add-money" className="btn quiet">
            <Icon name="plus" size={17} /> Top up
          </Link>
          <Link href="/fx" className="btn quiet">
            <Icon name="swap" size={17} /> Convert
          </Link>
        </div>
      </section>

      {others.length > 0 && (
        <section className="card animate-in d2">
          <div className="card-head">
            <h2>Other balances</h2>
          </div>
          <div className="list">
            {others.map((b: Balance) => (
              <div className="list-row" key={b.currency}>
                <span className="row-icon"><Icon name="wallet" size={19} /></span>
                <span className="row-main">
                  <span className="row-title">{b.currency}</span>
                  {!isZero(b.pending) && (
                    <span className="row-sub">{formatAmount(b.pending, b.currency)} pending</span>
                  )}
                </span>
                <span className="row-value amount">
                  {hidden ? MASK : formatAmount(b.spendable, b.currency)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="animate-in d2">
        <div className="row-between section-head">
          <h2>Products</h2>
          <Link href="/more" className="btn link">View all</Link>
        </div>
        <div className="tiles">
          {PRODUCTS.map((p) => (
            <Link key={p.label} href={p.href} className={`tile ${p.tone}`}>
              <span className="tile-icon"><Icon name={p.icon} size={20} /></span>
              {p.label}
            </Link>
          ))}
        </div>
      </section>

      <section className="animate-in d3">
        <div className="promo-rail">
          <article className="promo">
            <h3>Send money home, instantly</h3>
            <p>Convert and deliver in one move — the rate you see is the rate you get.</p>
            <Link href="/fx" className="promo-cta">
              Convert now <Icon name="arrowRight" size={15} />
            </Link>
          </article>
          <article className="promo navy">
            <h3>Spend online in dollars</h3>
            <p>A virtual USD card, funded from your naira balance in seconds.</p>
            <Link href="/cards" className="promo-cta">
              Get a card <Icon name="arrowRight" size={15} />
            </Link>
          </article>
        </div>
      </section>

      <section className="card animate-in d4">
        <div className="card-head">
          <h2>Recent activity</h2>
          <Link href="/activity" className="btn link">See all</Link>
        </div>

        {history.loading && (
          <div className="list">
            {[0, 1, 2].map((i) => (
              <div className="list-row" key={i}>
                <span className="skeleton" style={{ width: 42, height: 42, borderRadius: 12 }} />
                <span className="row-main">
                  <span className="skeleton" style={{ display: 'block', width: '58%', height: 13 }} />
                  <span className="skeleton" style={{ display: 'block', width: '34%', height: 11, marginTop: 7 }} />
                </span>
              </div>
            ))}
          </div>
        )}

        {!history.loading && (history.data?.entries.length ?? 0) === 0 && (
          <div className="empty">
            <span className="empty-icon"><Icon name="file" size={24} /></span>
            <span>No transactions yet</span>
            <span className="hint" style={{ margin: 0 }}>
              Money you send or receive will show up here.
            </span>
          </div>
        )}

        <div className="list">
          {history.data?.entries.slice(0, 6).map((t: Transaction) => {
            const outgoing = t.amount.trim().startsWith('-');
            return (
              <div className="list-row" key={t.id}>
                <span className="row-icon">
                  <Icon name={outgoing ? 'arrowUpRight' : 'download'} size={19} />
                </span>
                <span className="row-main">
                  <span className="row-title">{t.description}</span>
                  <span className="row-sub">
                    {new Date(t.occurred_at).toLocaleDateString(undefined, {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </span>
                <span
                  className="row-value amount"
                  style={outgoing ? undefined : { color: 'var(--ok)' }}
                >
                  {formatAmount(t.amount, t.currency)}
                </span>
              </div>
            );
          })}
        </div>

        {balances.error !== undefined && <p className="error">
          <Icon name="alert" size={16} /> {balances.error}
        </p>}
      </section>
    </Shell>
  );
}
