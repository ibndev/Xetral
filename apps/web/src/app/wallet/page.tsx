'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { entryKindLabel, formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { CurrencyMark } from '@/ui/currency-mark';
import type { IconName } from '@/ui/icon';
import { useLoad, useRemembered, useXetral } from '@/lib/hooks';
import { TxList } from '@/ui/tx-list';
import { TransactionSheet } from '@/ui/transaction-sheet';

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
   * `shown` is the fallback, because ABSENCE OF A PREFERENCE IS NOT A
   * PREFERENCE. It was `hidden`, on the reasoning that dots are the cautious
   * first paint — and since nothing is stored until somebody presses the eye,
   * the effect wrote that same fallback back and every customer who had never
   * used the control had their own balance permanently masked. The one number
   * the home screen exists for, replaced by six dots, on the screen they open
   * to check it. See `useRemembered` for why there is no flash the other way.
   */
  /* Which transaction's receipt is open, by id — the list grows as pages
     load, so an index would point at a different one after a reload. */
  const [openTx, setOpenTx] = useState<string | undefined>(undefined);

  const [visibility, setVisibility] = useRemembered<'hidden' | 'shown'>(
    'xetral-balance-visibility',
    'shown',
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
   * THE HEADLINE IS IN DOLLARS, because the card spends in dollars and a
   * customer paid in naira or cedis should read one figure for "what can I
   * spend", not do the conversion in their head. It is priced exactly as a
   * conversion would pay (see `dollarTotal`), and it is its OWN request: if
   * pricing is unavailable the headline falls back to the selected balance
   * below rather than the home screen going blank.
   */
  const dollars = useLoad(() => client.dollarTotal(), [client]);
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
  /* The dollar total when it priced; otherwise the selected balance, which
     is what this line showed before and is always true. */
  const headline =
    dollars.data !== undefined
      ? { amount: dollars.data.amount, currency: 'USD' }
      : { amount: active?.spendable ?? '0.00', currency };

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
          {balances.loading || dollars.loading ? (
            <span className="skeleton" style={{ display: 'block', width: 210, height: 42 }} />
          ) : hidden ? (
            `${symbolFor(headline.currency)} ${MASK}`
          ) : (
            <Figure amount={headline.amount} currency={headline.currency} />
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
        {/*
          WHAT THE HEADLINE IS, said in the comp's chip slot. "Approximately"
          is the honest word: the figure moves with the rate while the money
          stays in the currency it arrived in. A balance with no published
          dollar price is NAMED, because a total that quietly skipped one
          reads as money gone.
        */}
        {!hidden && (dollars.data !== undefined || (active !== undefined && !isZero(active.pending))) && (
          <div className="balance-chips">
            {dollars.data !== undefined && (
              <span className="delta-chip">
                <Icon name="swap" size={13} />
                {dollars.data.excluded.length === 0
                  ? 'In dollars, at today’s rate'
                  : `In dollars · not counted: ${dollars.data.excluded.join(', ')}`}
              </span>
            )}
            {active !== undefined && !isZero(active.pending) && (
              <span className="delta-chip">
                <Icon name="clock" size={13} />
                {formatAmount(active.pending, currency)} pending
              </span>
            )}
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
          {/* ITS OWN SCREEN. Request and Add both pointed here at
              `/add-money`, so two of the four actions led to one page — and
              the one headed "Add money", which is not what somebody asking to
              be paid came for. */}
          <Link href="/request" className="act">
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

      {/*
        THERE IS NO PROMO RAIL HERE, and removing it is the correction.

        Two marketing cards sat between Explore and Recent activity — "Send
        money home, instantly" and "Spend online in dollars". They are not in
        `docs/mockups/app.html`: that screen goes Explore tiles straight to
        Recent activity, and both cards were this app's own addition. A
        section the design does not have is a difference from the design,
        and on the home screen it pushed the customer's own transactions
        most of a handset further down for two things they did not ask for.
      */}
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
          THE SAME LIST THE ACTIVITY SCREEN DRAWS, from `ui/tx-list.tsx`. Two
          copies of a transaction row had already drifted into two different
          products, and "See all" led from the better one to the worse one.

          AND A ROW NOW OPENS THE RECEIPT RATHER THAN A DEAD LINK. It was
          `/activity?entry=<id>`, and the Activity screen has never read that
          query — so every tap on the home screen's own transactions landed on
          an unfiltered list with nothing open, on the screen a customer taps
          when somebody has asked them whether they paid.
        */}
        <TxList entries={history.data?.entries.slice(0, 6) ?? []} onOpen={setOpenTx} />

        {openTx !== undefined && (
          <TransactionSheet id={openTx} onClose={() => setOpenTx(undefined)} />
        )}

        {balances.error !== undefined && <p className="error">
          <Icon name="alert" size={16} /> {balances.error}
        </p>}
      </section>
    </Shell>
  );
}
