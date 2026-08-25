'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import type { IconName } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';

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
  const [hidden, setHidden] = useState(false);

  const balances = useLoad(() => client.balances(), [client]);
  const history = useLoad(
    () => client.transactions('NGN').catch(() => ({ entries: [], nextCursor: null })),
    [client],
  );

  const ngn = balances.data?.find((b) => b.currency === 'NGN');
  const others = (balances.data ?? []).filter((b) => b.currency !== 'NGN');

  return (
    <Shell>
      <h1 className="animate-in">Hello there</h1>
      <p className="lead animate-in d1">Here is where your money stands today.</p>

      <section className="balance-card animate-in d1" style={{ marginTop: 18 }}>
        <div className="row-between">
          <span className="balance-label">Available balance</span>
          <span className="badge">NGN</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="balance-value">
            {balances.loading ? (
              <span className="skeleton" style={{ display: 'block', width: 190, height: 38 }} />
            ) : hidden ? (
              '₦ • • • • • •'
            ) : (
              formatAmount(ngn?.spendable ?? '0.00', 'NGN')
            )}
          </div>
          {/*
            Hiding the balance is not decoration. Somebody checks their phone
            in a danfo with a stranger's shoulder at theirs, and one tap is
            the difference between that being fine and not.
          */}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setHidden((h) => !h)}
            aria-label={hidden ? 'Show balance' : 'Hide balance'}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={20} />
          </button>
        </div>

        {ngn !== undefined && ngn.pending !== '0.00' && (
          <div className="balance-sub">
            {formatAmount(ngn.pending, 'NGN')} pending — held, not yet spendable
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
        <section className="card animate-in d2" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h2>Other balances</h2>
          </div>
          <div className="list">
            {others.map((b: Balance) => (
              <div className="list-row" key={b.currency}>
                <span className="row-icon"><Icon name="wallet" size={19} /></span>
                <span className="row-main">
                  <span className="row-title">{b.currency}</span>
                  {b.pending !== '0.00' && (
                    <span className="row-sub">{formatAmount(b.pending, b.currency)} pending</span>
                  )}
                </span>
                <span className="row-value amount">{formatAmount(b.spendable, b.currency)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="animate-in d2" style={{ marginTop: 22 }}>
        <div className="row-between" style={{ marginBottom: 12 }}>
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

      <section className="animate-in d3" style={{ marginTop: 22 }}>
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

      <section className="card animate-in d4" style={{ marginTop: 22 }}>
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
