'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { entryKindLabel, formatAmount, isPaused, symbolFor } from '@xetral/client';
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
  { href: '/esim',   label: 'eSIM',      icon: 'sim',     tone: 't-blue' },
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

/** The amount's class by length: the card is 212px and a figure is set
 *  smaller as it grows rather than overflowing. */
function fitClass(figure: string): string {
  if (figure.length > 15) return 'ccy-amt smallest';
  if (figure.length > 12) return 'ccy-amt smaller';
  return 'ccy-amt';
}

/**
 * THE TOTAL IS SET SMALLER AS IT GROWS, never cut and never wrapped. Jost Bold
 * at 48px draws about eleven characters across a 320px handset — "$3,447.52"
 * is nine, and a seven-figure total is thirteen. The phone does the same with
 * `adjustsFontSizeToFit`.
 */
function heroFit(figure: string): string {
  if (figure.length > 16) return 'balance-value fade-in fit-3';
  if (figure.length > 13) return 'balance-value fade-in fit-2';
  if (figure.length > 10) return 'balance-value fade-in fit-1';
  return 'balance-value fade-in';
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
  const services = useLoad(() => client.services(), [client]);
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
  /*
   * THE HEADLINE IS THE TOTAL AND NOTHING ELSE.
   *
   * It fell back to the SELECTED wallet whenever the total could not be
   * priced, so tapping a currency card appeared to change "Total balance" to
   * that currency — a figure that is not a total at all, under a label that
   * says it is. The dollar WALLET is a different number too: it is one of the
   * balances the total adds up. So the headline is the total in dollars, or
   * it says plainly that it cannot be shown; it is never borrowed from a card.
   */
  const headline = dollars.data;

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

        <div className="hero">
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
        <div
          className={heroFit(headline === undefined || hidden ? '' : formatAmount(headline.amount, 'USD'))}
          key={hidden ? 'masked' : 'shown'}
        >
          {dollars.loading ? (
            <span className="skeleton" style={{ display: 'block', width: 210, height: 42 }} />
          ) : headline === undefined ? (
            <span className="balance-unavailable">—</span>
          ) : hidden ? (
            `$ ${MASK}`
          ) : (
            <Figure amount={headline.amount} currency="USD" />
          )}
        </div>

        {/*
          WHAT THE HEADLINE IS, said in the comp's chip slot. The figure moves
          with the rate while the money stays in the currency it arrived in,
          and a balance with no published dollar price is NAMED, because a
          total that quietly skipped one reads as money gone. Pending money is
          on its own currency's card, not here: a chip that changed with the
          selected card made the headline look as if it changed with it.
        */}
        {!hidden && !dollars.loading && (
          <div className="balance-chips">
            <span className="delta-chip">
              <Icon name="swap" size={13} />
              {headline === undefined
                ? 'Your total cannot be priced right now'
                : headline.excluded.length === 0
                  ? 'All your wallets, in dollars at today’s rate'
                  : `In dollars · not counted: ${headline.excluded.join(', ')}`}
            </span>
          </div>
        )}

        </div>

        {/*
          FOUR ACTIONS, ONE OF THEM FILLED, DIRECTLY UNDER THE TOTAL. Send is
          what this app is for; the other three are beside it because they are
          beside it in somebody's head. They sit with the figure they act on,
          as small round buttons centred beneath it, rather than below the
          currency cards spread to the screen's edges.
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

        {/*
          THE RAIL REPLACED A DROPDOWN, and it answers a different question.

          A `<select>` says which currency the figure above is in; the rail
          shows what is in every one of them at once, which is what somebody
          holding four currencies opens this screen to see. Tapping a card
          chooses whose activity is listed below; the total above never moves.
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
                  {/* A FIGURE THAT DOES NOT FIT IS SET SMALLER, never cut: an
                      eight-decimal Bitcoin balance was clipped at the card's
                      edge, and a number half hidden is a number read wrong. */}
                  <span className={fitClass(hidden ? MASK : formatAmount(b.spendable, b.currency))}>
                    {hidden ? `${symbolFor(b.currency)} ${MASK}` : formatAmount(b.spendable, b.currency)}
                  </span>
                  <span className="ccy-sub">
                    {!hidden && !isZero(b.pending)
                      ? `Spendable · ${formatAmount(b.pending, b.currency)} pending`
                      : 'Spendable'}
                  </span>
                </button>
              ))}
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
              {/* Paused by an operator: the tile still opens a screen that
                  says so, rather than vanishing from a grid of four. */}
              {isPaused(services.data, p.href) && <span className="tile-soon">Soon</span>}
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
