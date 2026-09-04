'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';
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

  const session = useLoad(() => client.currentSession(), [client]);
  const balances = useLoad(() => client.balances(), [client]);
  /*
   * THE ACCOUNT NUMBER, ON THE SCREEN THEY OPEN FIRST.
   *
   * It lived only on Add money, so a customer who wanted to be paid had to
   * remember which screen held it and go there — and the number is the one
   * thing on this app somebody reads out loud to another person. It belongs
   * where they already are.
   *
   * A READ, never an issue: `existingFundingAccount` opens nothing, which is
   * the distinction that stopped the Add money page from opening a bank
   * account as a side effect of being looked at. A customer with none gets
   * `null` and nothing renders, because not having one is the resting state
   * of a new account rather than a fault worth a line of text.
   */
  const fundingAccount = useLoad(
    () => client.existingFundingAccount().catch(() => null),
    [client],
  );
  // Narrowed ONCE, into a local: `fundingAccount.data` is a property access,
  // so TypeScript cannot carry a null check across the closure below.
  const inbound = fundingAccount.data;

  /** Reset by a timer, so the tick is feedback rather than a new state. */
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

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
      {/*
        BY NAME, and nothing under it.
        
        "Here is where your money stands today" was a subtitle that described
        the screen to somebody already looking at it — and it pushed the
        balance, which is what they opened the app for, a line further down.
        The name comes from the customer's own identity submission, which is
        the only place this system holds one; `there` is the honest fallback
        for somebody who has not made one yet.
      */}
      <h1 className="animate-in">Hello {session.data?.first_name ?? 'there'}</h1>

      <section className="balance-card animate-in d1">
        <div className="row-between">
          <span className="balance-label" id="balance-currency-label">
            Available balance
          </span>
          {/*
            THE SELECTOR IS HERE AND NOWHERE ELSE. There used to be a rail of
            currency chips under the balance as well, which meant two controls
            for one decision: the chips repeated every figure the balance was
            already showing, pushed Send and Top up toward the fold, and gave
            the card a different height depending on how many currencies the
            platform happened to offer. One dropdown, at the top, beside the
            number it changes.
          */}
          <div className="ccy-select">
            <Select
              labelledBy="balance-currency-label"
              value={currency}
              onChange={setPreferred}
              options={assets.map((b: Balance) => ({
                value: b.currency,
                label: b.currency,
                // The figure, so choosing is a decision made with the numbers
                // rather than one that reveals them.
                ...(hidden ? {} : { hint: formatAmount(b.spendable, b.currency) }),
              }))}
              renderMark={(code) => <CurrencyMark currency={code} size={20} />}
            />
          </div>
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
          WHERE MONEY COMES IN, read out in the order somebody says it:
          the name on the account, the bank, then the number.

          The name is the PROVIDER'S — what a sender's banking app will show
          them when they type this number in — so it is the string that
          confirms they have the right person. Ours would confirm nothing.

          `mono` and `tabular-nums` on the digits, because this is copied by
          eye into another app and a proportional font makes a ten-digit
          string hard to keep place in.
        */}
        {inbound !== null && inbound !== undefined && (
          <button
            type="button"
            className="account-line"
            onClick={() => {
              void navigator.clipboard?.writeText(inbound.account_number);
              setCopied(true);
            }}
            title="Copy your account number"
          >
            <span className="account-holder">{inbound.account_name}</span>
            <span className="account-number mono">
              {inbound.bank_name}: {inbound.account_number}
            </span>
            <Icon name={copied ? 'check' : 'copy'} size={15} />
          </button>
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
