'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
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

/**
 * The balance, with the minor units set quieter than the major.
 *
 * A customer reads the whole number and GLANCES at the kobo; setting both at
 * full contrast makes a seven-figure figure harder to take in, which is the
 * one thing this line exists to be good at. It splits on the LAST separator
 * rather than a dot, because `formatAmount` writes what the currency writes
 * and the eight decimals of a BTC balance are still the minor part.
 */
function Figure({ amount, currency }: { readonly amount: string; readonly currency: string }) {
  const text = formatAmount(amount, currency);
  const at = text.lastIndexOf('.');
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="minor">{text.slice(at)}</span>
    </>
  );
}

/**
 * What a currency is called, for the line under its code on a rail card.
 *
 * NAMED HERE AND NOT INVENTED FROM THE CODE. A three-letter code is not a
 * name, and a card reading "NGN / NGN" says nothing twice. Anything this does
 * not know falls back to the code alone rather than to a guess — the rail is
 * built from whatever `/v1/wallets` offers, so a currency added tomorrow must
 * render correctly today.
 */
const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  NGN: 'Nigerian Naira',
  GHS: 'Ghanaian Cedi',
  KES: 'Kenyan Shilling',
  USD: 'US Dollar',
  GBP: 'Pound Sterling',
  CAD: 'Canadian Dollar',
  USDT: 'Tether',
  USDC: 'USD Coin',
  BTC: 'Bitcoin',
};
const nameOf = (code: string) => CURRENCY_NAMES[code] ?? code;

/**
 * The day a transaction happened, as somebody would say it out loud.
 *
 * "TODAY" and "YESTERDAY" rather than a date, because those are the two days
 * a customer is actually checking against — and everything older gets the
 * date, because "3 days ago" makes a reader do arithmetic to compare it with
 * a bank statement.
 *
 * COMPARED ON THE LOCAL CALENDAR DAY, never on elapsed hours. A payment at
 * 23:50 and one at 00:10 are eleven hours apart in the same week and on two
 * different days, and a threshold in hours puts them under one heading.
 */
function dayOf(when: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(when)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

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

  return (
    <Shell greeting={{ name: session.data?.first_name }}>
      {/*
        BY NAME, and nothing under it.
        
        "Here is where your money stands today" was a subtitle that described
        the screen to somebody already looking at it — and it pushed the
        balance, which is what they opened the app for, a line further down.
        The name comes from the customer's own identity submission, which is
        the only place this system holds one; `there` is the honest fallback
        for somebody who has not made one yet.
      */}
      {/*
        THE GLOW SITS BEHIND THE BALANCE AND NOTHING ELSE.

        It is a light source rather than a fill: `pointer-events:none`, never
        on a surface that carries its own text, and behind the figure the
        screen exists to show. `.glow-wrap` raises every sibling above it so
        nothing is tinted by it.
      */}
      <section className="glow-wrap animate-in">
        <span className="glow" aria-hidden="true" />

        <div className="balance-head">
          <span className="balance-label" id="balance-currency-label">Total balance</span>
          {/*
            Hiding the balance is not decoration. Somebody checks their phone
            in a danfo with a stranger's shoulder at theirs, and one tap is
            the difference between that being fine and not — which is also why
            the choice is remembered rather than reset by a reload.
          */}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setVisibility(hidden ? 'shown' : 'hidden')}
            aria-pressed={hidden}
            aria-label={hidden ? 'Show balance' : 'Hide balance'}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>

        {/* Keyed on the state so React replaces the node and the figure
            cross-fades instead of snapping between dots and digits. */}
        <div className="balance-value fade-in" key={hidden ? 'masked' : 'shown'}>
          {balances.loading ? (
            <span className="skeleton" style={{ display: 'block', width: 210, height: 42 }} />
          ) : hidden ? (
            `${symbolFor(currency)} ${MASK}`
          ) : (
            <Figure amount={active?.spendable ?? '0.00'} currency={currency} />
          )}
        </div>

        {/*
          THE CHIP SAYS WHAT IS PENDING, WHICH IS THE ONE THING HERE THAT IS
          TRUE.

          The mockup puts a "+₦150,000 this week" chip in this slot. There is
          no figure behind it: `/v1/wallets` answers a spendable and a pending
          balance, and a week's inflow would have to be summed from ONE PAGE
          of history — which is however many entries that page happens to hold
          and not a week. A plausible number in the place a customer reads
          their money is the one thing this screen must not invent, so the
          slot carries money that is genuinely held instead, and is absent
          when there is none.
        */}
        {active !== undefined && !isZero(active.pending) && !hidden && (
          <div style={{ marginTop: 11 }}>
            <span className="delta-chip">
              <Icon name="clock" size={13} />
              {formatAmount(active.pending, currency)} pending
            </span>
          </div>
        )}

        {/*
          THE RAIL REPLACED A DROPDOWN, and it answers a different question.

          A `<select>` says which currency the figure above is in; the rail
          shows what is in every one of them at once, which is what somebody
          holding four currencies opens this screen to see. Tapping a card
          moves the big figure — so the rail is the selector as well, and
          there is still exactly one control for one decision.
        */}
        <div className="ccy-rail" role="tablist" aria-label="Currencies">
          {balances.loading
            ? [0, 1, 2].map((i) => (
                <span className="ccy-card" key={i} aria-hidden="true">
                  <span className="skeleton" style={{ display: 'block', width: 92, height: 26, borderRadius: 999 }} />
                  <span className="skeleton" style={{ display: 'block', width: 130, height: 24, marginTop: 18 }} />
                </span>
              ))
            : assets.map((b: Balance) => (
                <button
                  type="button"
                  key={b.currency}
                  role="tab"
                  aria-selected={b.currency === currency}
                  className={b.currency === currency ? 'ccy-card on' : 'ccy-card'}
                  onClick={() => setPreferred(b.currency)}
                >
                  <span className="ccy-top">
                    <CurrencyMark currency={b.currency} size={26} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="ccy-code">{b.currency}</span>
                      <span className="ccy-name">{nameOf(b.currency)}</span>
                    </span>
                  </span>
                  <span className="ccy-amt">
                    {hidden ? `${symbolFor(b.currency)} ${MASK}` : formatAmount(b.spendable, b.currency)}
                  </span>
                  <span className="ccy-sub">Spendable</span>
                </button>
              ))}
        </div>

        {/*
          FOUR ACTIONS, ONE OF THEM FILLED. Send is what this app is for; the
          other three are beside it because they are beside it in somebody's
          head, not because they are equal to it.
        */}
        <div className="act-row">
          <Link href="/transfer" className="act primary">
            <span className="act-ico"><Icon name="send" size={22} /></span>
            Send
          </Link>
          <Link href="/add-money" className="act">
            <span className="act-ico"><Icon name="plus" size={22} /></span>
            Add
          </Link>
          <Link href="/fx" className="act">
            <span className="act-ico"><Icon name="swap" size={22} /></span>
            Convert
          </Link>
          <Link href="/add-money" className="act">
            <span className="act-ico"><Icon name="download" size={22} /></span>
            Request
          </Link>
        </div>
      </section>

      {/*
        THERE IS NO "OTHER BALANCES" BOX, and its absence is deliberate.

        The currency SELECTOR on the balance card is the control for this: it
        names every currency this customer can hold and switches the figure
        above it. A second list repeating the same balances underneath is two
        controls for one decision — the exact reason the currency rail and the
        badge were collapsed into that selector in the first place — and it
        grew the page by however many currencies the platform happens to offer.
      */}
      <section className="animate-in d2">
        <div className="sec-head">
          <h2>Explore</h2>
          <Link href="/more" className="more">All services</Link>
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

      <section className="animate-in d4">
        <div className="sec-head">
          <h2>Recent activity</h2>
          <Link href="/activity" className="more">See all</Link>
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

        {/*
          GROUPED BY DAY, and the heading is what lets the row drop its own
          date — a list where every row repeats "Sep 20" spends a column
          saying the same thing six times. `seen` is the running heading
          rather than a pre-built map, because the list is already in order
          and a second pass to group it would be a second place the ordering
          has to agree with the ledger's.

          A HEADING CAN LEGITIMATELY REPEAT, and re-sorting to prevent it
          would be the bug. History is keyset paginated on the POSTING ID —
          which for ordinary traffic is time order, and deliberately is not
          when a reconciliation sweep posts a deposit today for money that
          arrived on Tuesday. Sorting this page by `occurred_at` would make it
          disagree with the cursor "See all" pages on, which is how a list
          grows duplicates and gaps. The heading describes the rows beneath
          it, and that stays true however many times it appears.
        */}
        <div>
          {(() => {
            let seen: string | undefined;
            return history.data?.entries.slice(0, 6).map((t: Transaction) => {
              const outgoing = t.amount.trim().startsWith('-');
              const when = new Date(t.occurred_at);
              const day = dayOf(when);
              const heading = day === seen ? undefined : day;
              seen = day;
              return (
                <div key={t.id}>
                  {heading !== undefined && <div className="day-head">{heading}</div>}
              <Link className="tx-row" href={`/activity?entry=${t.id}`}>
                <span className="tx-mark">
                  <span className="avatar">
                    <Icon name={outgoing ? 'arrowUpRight' : 'download'} size={19} />
                  </span>
                  {/* The currency rides ON the avatar rather than beside it,
                      so a row is two columns and not three — and is read at a
                      glance without a label taking a line. */}
                  <span className="tx-flag">
                    <CurrencyMark currency={t.currency} size={14} />
                  </span>
                </span>
                <span className="tx-main">
                  <span className="tx-name">{t.description}</span>
                  {/* THE TIME, NOT THE DATE. The day heading above already
                      said which day, and a row repeating it is a column of
                      identical text. */}
                  <span className="tx-sub">
                    {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </span>
                <span className="tx-side">
                  {/* MONEY LEAVING IS RED AND MONEY ARRIVING IS GREEN. It was
                      red for neither, so the only thing separating "you were
                      paid" from "you paid" at a glance was a minus sign. */}
                  <span className={outgoing ? 'tx-amt out' : 'tx-amt in'}>
                    {formatAmount(t.amount, t.currency)}
                  </span>
                </span>
              </Link>
                </div>
              );
            });
          })()}
        </div>

        {balances.error !== undefined && <p className="error">
          <Icon name="alert" size={16} /> {balances.error}
        </p>}
      </section>
    </Shell>
  );
}
