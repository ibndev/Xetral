'use client';

import { Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  currencyName,
  exponentFor,
  feeOn,
  formatAmount,
  groupTyped,
  PAD,
  pressKey,
  isValidAmount,
  nationalDigits,
  networkLabel,
  phoneHint,
  sendableFor,
  symbolFor,
  SENT_TITLE,
  sentMessage,
} from '@xetral/client';
import type {
  IconName,
  Recipient,
  RecipientKind,
  RecipientResolution,
  XetralCountry,
} from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * SENDING MONEY, AS ONE FLOW.
 *
 * IT WAS THREE PRODUCTS UNDER ONE HEADING. The screen opened by asking
 * "Xetral, bank or mobile money?" — a question about OUR PLUMBING, put to
 * somebody who only wants to pay a person — and each answer led to a different
 * form, a different set of fields and a different endpoint. A customer who
 * picked wrong got a dead end rather than a redirect, and the tabs meant the
 * commonest send took two decisions before a number could be typed.
 *
 * Four steps now, and each asks one thing:
 *
 *   who       the people already paid, so the second payment costs a tap
 *   currency  what the recipient RECEIVES, which is the only question that
 *             decides everything after it
 *   details   the country is read off the currency, and the rail is a list of
 *             networks with the Xetral account among them
 *   amount    what leaves, what lands, and what it costs
 *
 * THE RAIL IS A ROW IN A LIST RATHER THAN A TAB ACROSS THE TOP. That is the
 * whole of the unification: "how does this reach them" is one question with
 * several answers, and an internal Xetral transfer is one of the answers
 * rather than a separate product — so a customer who does not know whether
 * their friend has an account picks from one list and finds out.
 */
export default function TransferPage() {
  return (
    <Suspense fallback={null}>
      <Transfer />
    </Suspense>
  );
}

type Step = 'who' | 'currency' | 'method' | 'details' | 'amount' | 'success';

/**
 * HOW THE MONEY REACHES THEM, asked as its own step.
 *
 * IT USED TO BE A ROW IN THE NETWORK PICKER — "XETRAL" sitting above MTN,
 * Telecel and AirtelTigo — which put two different questions in one list. A
 * customer choosing between "an account on this app" and "a mobile money
 * wallet" is choosing a PRODUCT; a customer choosing between MTN and Telecel
 * is choosing a network. Collapsing them made the first choice look like a
 * fourth network, and it meant the number field and its label had to be right
 * for both before either had been decided.
 *
 * The order is what makes the rest of the flow derivable: currency fixes the
 * country, the METHOD fixes the rail, and the rail decides what is asked for
 * and whether a name can be looked up.
 */
type Method = 'xetral' | 'bank' | 'momo';

function Transfer() {
  const client = useXetral();
  const params = useSearchParams();

  const session = useLoad(() => client.currentSession(), [client]);
  const wallets = useLoad(() => client.balances(), [client]);
  const saved = useLoad(() => client.recipients(), [client]);
  const countries = useLoad(() => client.session.countries(), [client]);

  /*
   * ARRIVED FROM A PAYMENT LINK, which skips straight past the address book.
   *
   * `/pay/<x>` sends somebody here with the identifier in `to`. They have
   * already been told who they are paying, so asking them to pick from a list
   * they have never seen would be a step backwards — the flow opens on the
   * details screen with the number filled in.
   */
  const arrivedWith = params.get('to') ?? '';
  const [step, setStep] = useState<Step>(arrivedWith === '' ? 'who' : 'details');

  const router = useRouter();

  /* WHAT WAS JUST SENT, held until the customer dismisses it. Cleared by the
     dialog's own button rather than by a timer: a confirmation that money
     left should not disappear because somebody looked away. */
  const [sent, setSent] = useState<
    {
      amount: string;
      currency: string;
      name: string;
      destination: string;
      /** Absent for a wallet transfer, which returns none — see `onSent`. */
      reference?: string;
      instant: boolean;
    } | undefined
  >(undefined);

  /** The recipient being paid — chosen from the list, or built by the flow. */
  const [chosen, setChosen] = useState<Recipient | undefined>(undefined);
  const [draft, setDraft] = useState<RecipientResolution | undefined>(undefined);

  /** What the RECIPIENT receives. Chosen on step two and read by every step
   *  after it, because it decides the country, the rail and the conversion. */
  const [receive, setReceive] = useState('');
  /** How it reaches them — step three, and what the details form is FOR. */
  const [method, setMethod] = useState<Method>('xetral');

  const home = session.data?.home_currency ?? 'NGN';

  const back = () => {
    if (step === 'amount') setStep('details');
    else if (step === 'details') setStep(arrivedWith === '' ? 'method' : 'who');
    else if (step === 'method') setStep('currency');
    else if (step === 'currency') setStep('who');
  };

  /*
   * EACH STEP CARRIES THE COMP'S OWN TITLE, and the header is the shared one.
   *
   * The way back used to be a floating control at the BOTTOM RIGHT, on the
   * reasoning that a chevron above a heading costs a band of empty space and
   * sits where a thumb cannot reach. The first half was true of a chevron on
   * its OWN line; the comp puts the button and the title on one line, so the
   * band is the title's and costs nothing extra — and the whole product now
   * uses that header, so a flow with its own back control would be the one
   * screen where the way out is somewhere else.
   */
  const TITLES: Readonly<Record<Step, string>> = {
    who: 'Send money',
    currency: 'What are you sending?',
    method: 'How does it arrive?',
    details: 'Recipient details',
    amount: 'Enter amount',
    /* NO TITLE AND NO BACK ON SUCCESS. The money has gone; there is nothing
       to return to and no question left to answer. The screen's own heading
       is the confirmation. */
    success: '',
  };

  return (
    <Shell
      title={TITLES[step]}
      {...(step === 'who'
        ? { back: '/wallet' }
        : step === 'success'
          ? { bare: true }
          : { onBack: back })}
    >

      {step === 'who' && (
        <ChooseRecipient
          recipients={saved.data ?? []}
          home={home}
          onPick={(recipient) => {
            setChosen(recipient);
            setDraft(undefined);
            setReceive(recipient.currency);
            setStep('amount');
          }}
          onRemove={async (id) => {
            await client.removeRecipient(id);
            saved.reload();
          }}
          onNew={() => {
            setChosen(undefined);
            setDraft(undefined);
            setStep('currency');
          }}
        />
      )}

      {step === 'currency' && (
        <ChooseCurrency
          home={home}
          onPick={(currency) => {
            setReceive(currency);
            setStep('method');
          }}
        />
      )}

      {step === 'method' && (
        <ChooseMethod
          receive={receive === '' ? home : receive}
          countries={countries.data ?? []}
          onPick={(picked) => {
            setMethod(picked);
            setStep('details');
          }}
        />
      )}

      {step === 'details' && (
        <RecipientDetails
          receive={receive === '' ? home : receive}
          method={method}
          countries={countries.data ?? []}
          initialDestination={arrivedWith}
          onReady={(resolution, recipient) => {
            setDraft(resolution);
            setChosen(recipient);
            /*
             * A XETRAL SEND KEEPS THE CURRENCY THE CUSTOMER CHOSE, and that is
             * the whole of a bug that read as the flow defaulting to cedis.
             *
             * The server answers a Xetral lookup with the RECIPIENT'S OWN
             * currency — a Ghanaian holds GHS — and this line overwrote the
             * answer given one step earlier on a screen headed "What currency
             * are you sending?". So somebody who chose naira, typed a Ghanaian
             * friend's number and pressed Continue was quoted in cedis, with
             * nothing on screen saying their choice had been discarded.
             *
             * A Xetral wallet is multi-currency, so paying a Ghanaian in naira
             * is an ordinary transfer. Every OTHER kind keeps the server's
             * answer: a momo wallet in Accra cannot receive naira, and there
             * the currency really is a fact about the destination.
             */
            setReceive(resolution.kind === 'xetral' ? receive : resolution.currency);
            saved.reload();
            setStep('amount');
          }}
        />
      )}

      {step === 'amount' && (draft !== undefined || chosen !== undefined) && (
        <SendAmount
          /* One of the two is always present at this point: a saved recipient
             carries everything a draft does, and a draft is what a new one
             becomes before it is saved. */
          to={chosen ?? toRecipient(draft as RecipientResolution)}
          /* WHAT THE RECIPIENT RECEIVES IS THE FLOW'S ANSWER, not the row's.
             A saved recipient sets it on being picked; the details step sets
             it from the choice for Xetral and from the rail otherwise. */
          receiveCurrency={receive === '' ? home : receive}
          balances={wallets.data ?? []}
          home={home}
          onSent={(result) => {
            setSent(result);
            saved.reload();
            wallets.reload();
            setStep('success');
          }}
        />
      )}

      {/*
        MONEY LEAVING DESERVES A SCREEN, not a dialog and not a toast that
        fades.

        It was a dialog, which was already the right call against a strip at
        the bottom saying "Sent to Olawale" — that names no amount and removes
        itself after a few seconds, so a customer who looked away has no
        confirmation at all of the one action in this product that cannot be
        undone. The comp goes one further and gives it the whole screen, which
        is what lets it carry the DESTINATION and the REFERENCE as well as the
        figure: the three things somebody quotes when they ring up to ask
        where their money is.
      */}
      {step === 'success' && sent !== undefined && (
        <Sent
          sent={sent}
          onDone={() => {
            setSent(undefined);
            setChosen(undefined);
            setDraft(undefined);
            setStep('who');
            router.push('/wallet');
          }}
          onAgain={() => {
            setSent(undefined);
            setChosen(undefined);
            setDraft(undefined);
            setStep('who');
          }}
        />
      )}

    </Shell>
  );
}

/**
 * THE CONFIRMATION, AS A WHOLE SCREEN.
 *
 * It was a portalled dialog — portalled because `.screen-in` animates
 * `<main>`, an animation creates a containing block, and a `position: fixed`
 * child of one is positioned against it rather than against the viewport.
 * A step needs none of that: it IS the screen.
 *
 * WHAT THE EXTRA ROOM BUYS is the three things somebody quotes when they ring
 * up to ask where their money went — who it went to, which account, and the
 * reference. A dialog had room for a figure and a name.
 *
 * THE REFERENCE ROW IS ABSENT WHERE THERE IS NO REFERENCE. A bank payout and
 * a conversion both come back with an id; `POST /v1/wallets/transfers`
 * answers an amount, a fee and a currency and nothing to quote. Showing an
 * empty row, or inventing one, would be worse than the row not being there —
 * the same call as the fee row on the step before this.
 */
function Sent({
  sent,
  onDone,
  onAgain,
}: {
  readonly sent: {
    readonly amount: string;
    readonly currency: string;
    readonly name: string;
    readonly destination: string;
    readonly reference?: string;
    readonly instant: boolean;
  };
  readonly onDone: () => void;
  readonly onAgain: () => void;
}) {
  return (
    <section className="sent">
      <div className="sent-body">
        {/* TWO CIRCLES, the outer tinted and the inner solid — the comp's
            shape, and it is what makes the mark read as a stamp rather than
            as an icon on a coloured disc. */}
        <span className="sent-mark" aria-hidden="true">
          <span className="sent-mark-in">
            <Icon name="check" size={30} />
          </span>
        </span>

        <h2 className="sent-title">Money sent</h2>
        <p className="sent-lede">
          You sent <b>{formatAmount(sent.amount, sent.currency)}</b> to {sent.name}.{' '}
          {sent.instant ? 'It has arrived.' : 'It usually arrives within minutes.'}
        </p>

        <div className="sent-card">
          <div className="sent-row">
            <span>To</span>
            <span>{sent.name}</span>
          </div>
          <div className="sent-row">
            <span>Account</span>
            <span className="mono">{sent.destination}</span>
          </div>
          {sent.reference !== undefined && (
            <div className="sent-row">
              <span>Reference</span>
              <span className="mono">{sent.reference}</span>
            </div>
          )}
        </div>
      </div>

      <button type="button" onClick={onDone}>Done</button>
      <button type="button" className="sent-again" onClick={onAgain}>
        Send to someone else
      </button>
    </section>
  );
}

/**
 * The people already paid.
 *
 * A SEND FLOW WHOSE FIRST STEP IS AN EMPTY FIELD makes every payment cost the
 * same typing as the first. The list is the difference between a product
 * somebody uses twice and one they use weekly — which is why it is the
 * opening screen rather than a convenience tucked behind the form.
 */
function ChooseRecipient({
  recipients,
  home,
  onPick,
  onRemove,
  onNew,
}: {
  recipients: readonly Recipient[];
  home: string;
  onPick: (recipient: Recipient) => void;
  onRemove: (id: string) => Promise<void>;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<string | undefined>(undefined);

  const shown = recipients.filter((r) => {
    if (query.trim() === '') return true;
    const needle = query.trim().toLowerCase();
    return (
      r.display_name.toLowerCase().includes(needle) ||
      r.destination.includes(needle.replace(/[^0-9]/g, '')) ||
      (r.rail_name ?? '').toLowerCase().includes(needle)
    );
  });

  return (
    <section className="sf">
      <div className="sf-search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or account details"
          aria-label="Search recipients"
        />
      </div>

      {/*
        NEW RECIPIENT IS A ROW UNDER THE SEARCH, which is where the comp puts
        it — and it used to be a pill FIXED over the bottom of the screen,
        rendered through a portal to escape an ancestor's transform.

        That portal existed because `position: fixed` is contained by any
        transformed ancestor and `screen-in` animates `<main>`, so the pill
        laid out against a 900px main and sat 275px below the viewport:
        fixed, correct and invisible. An ordinary row in the flow has no
        ancestor to escape, so the whole mechanism goes with it — and the
        control is now beside the list it adds to rather than floating over
        the list it is not part of.
      */}
      <button type="button" className="sf-new" onClick={onNew}>
        <span className="sf-new-ico">
          <Icon name="plus" size={20} />
        </span>
        New recipient
      </button>

      {/*
        THERE IS NO CURRENCY FILTER HERE, and removing it is the correction.

        A row of chips — All, NGN, USD, USDT, More — sat between the search
        and the list. `docs/mockups/app.html` has none: its recipients step is
        the search, New recipient, an "ALL RECIPIENTS" eyebrow and the rows.
        The chips were this app's addition, they carried the old blue accent
        that made the flow look like a different product, and the search box
        immediately above them already filters on name AND account details —
        which is a superset of what a currency chip could do.
      */}
      {recipients.length === 0 ? (
        <p className="sf-empty">
          Nobody here yet. Add the first person you want to pay and they stay on
          this list.
        </p>
      ) : (
        <>
          <div className="sf-list-label">All recipients</div>
          <div className="sf-divider" />
          {shown.map((r) => (
            <div key={r.id} className="sf-recip">
              <button type="button" className="sf-recip-open" onClick={() => onPick(r)}>
                <span className="sf-avatar-wrap">
                  <span className="sf-avatar">{initialsOf(r.display_name)}</span>
                  <span className="sf-avatar-flag">
                    <CurrencyMark currency={r.currency} size={20} />
                  </span>
                </span>
                <span className="sf-recip-info">
                  <span className="sf-recip-name">{r.display_name}</span>
                  <span className="sf-recip-bank">
                    {railLabelOf(r)} &nbsp;|&nbsp; &middot;&middot;&middot;
                    {r.destination.slice(-4)}
                  </span>
                </span>
              </button>
              {/*
                REMOVING IS BEHIND A SECOND PRESS, not a swipe and not a
                one-tap icon. This list is tapped to SEND, so a destructive
                control beside the tap target is one thumb-width from deleting
                somebody's landlord.
              */}
              {menu === r.id ? (
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    setMenu(undefined);
                    void onRemove(r.id);
                  }}
                >
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  className="sf-dots"
                  aria-label={`More for ${r.display_name}`}
                  onClick={() => setMenu(r.id)}
                >
                  <span />
                  <span />
                  <span />
                </button>
              )}
            </div>
          ))}
          {shown.length === 0 && <p className="sf-empty">Nobody on this list matches that.</p>}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ step 2 */

/**
 * What the RECIPIENT receives.
 *
 * ASKED BEFORE THE NUMBER, and that order is the reason this flow can be one
 * flow. The currency decides the country, the country decides the rail, and
 * the rail decides whether a name can be looked up — so everything the details
 * screen needs to draw itself comes from this one answer. Asking for a number
 * first would mean guessing which of those it belonged to.
 */
function ChooseCurrency({
  home,
  onPick,
}: {
  home: string;
  onPick: (currency: string) => void;
}) {
  const [query, setQuery] = useState('');

  /*
   * WHAT THIS PLATFORM CAN ACTUALLY DELIVER, from `sendableFor` — the same
   * list the old screen used. A picker offering a currency nothing can pay out
   * is a choice that fails three screens later, which 046 records as the
   * failure that reads to a customer as their own details being wrong.
   */
  const all = sendableFor(home);
  const needle = query.trim().toLowerCase();
  const matches = (code: string): boolean =>
    needle === '' ||
    code.toLowerCase().includes(needle) ||
    currencyName(code).toLowerCase().includes(needle);

  /*
   * FAVOURITES ARE THE FOUR THIS PLATFORM OPERATES IN, in that order: naira,
   * cedi, shilling, dollar — not "your own currency and the dollar".
   *
   * The narrower rule put ONE row above the fold for a Nigerian and made every
   * corridor this product exists for — NGN to GHS, NGN to KES — something to
   * be found by scrolling the alphabetical tail. A favourites list of one is a
   * heading with nothing under it.
   *
   * `sendableFor` still decides what is OFFERED; this only decides the order,
   * so a currency the platform cannot pay out never appears here either.
   */
  const FAVOURITE_ORDER = ['NGN', 'GHS', 'KES', 'USD'];
  const favourites = [...all]
    .filter((c) => FAVOURITE_ORDER.includes(c) && matches(c))
    .sort((a, b) => FAVOURITE_ORDER.indexOf(a) - FAVOURITE_ORDER.indexOf(b));
  const stablecoins = all.filter((c) => (c === 'USDT' || c === 'USDC') && matches(c));
  const rest = all
    .filter((c) => !favourites.includes(c) && !stablecoins.includes(c) && matches(c))
    .sort((a, b) => currencyName(a).localeCompare(currencyName(b)));

  /*
   * THE ALPHABETICAL TAIL IS GROUPED BY LETTER, exactly as the mockup shows
   * (…B, C…). Each letter is its own labelled section with a divider, built
   * from the currency NAME so "Baht" files under B and "Cedi" under C.
   */
  const letters = new Map<string, string[]>();
  for (const code of rest) {
    const letter = currencyName(code).charAt(0).toUpperCase();
    (letters.get(letter) ?? letters.set(letter, []).get(letter)!).push(code);
  }

  const empty = favourites.length + stablecoins.length + rest.length === 0;

  return (
    <section className="sf">

      <div className="sf-search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search currency or country"
          aria-label="Search currencies"
        />
      </div>

      <CurrencyGroup heading="Favourites" codes={favourites} onPick={onPick} />
      <CurrencyGroup heading="Stablecoins" codes={stablecoins} onPick={onPick} />
      {[...letters.entries()].map(([letter, codes]) => (
        <CurrencyGroup key={letter} heading={letter} codes={codes} onPick={onPick} />
      ))}

      {empty && <p className="sf-empty">No currency matches that.</p>}
    </section>
  );
}

function CurrencyGroup({
  heading,
  codes,
  onPick,
}: {
  heading: string;
  codes: readonly string[];
  onPick: (currency: string) => void;
}) {
  if (codes.length === 0) return null;
  return (
    <div className="sf-section">
      <div className="sf-section-label">{heading}</div>
      <div className="sf-divider" />
      {codes.map((code) => (
        <button key={code} type="button" className="sf-row" onClick={() => onPick(code)}>
          <span className="sf-icon">
            {/* 38, not 44. At the larger size the discs dominated a list that
                is read by its NAMES, and four of them filled a handset screen
                before the first divider. */}
            <CurrencyMark currency={code} size={38} />
          </span>
          <span>
            <div className="sf-cur-name">{currencyName(code)}</div>
            <div className="sf-cur-code">
              {code} ({symbolFor(code)})
            </div>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ step 2 and a half */

/**
 * WHAT THIS PLATFORM CAN ACTUALLY DELIVER, per country.
 *
 * A XETRAL ACCOUNT IS ALWAYS ONE OF THEM, in every currency, because it is a
 * transfer between two balances on this platform rather than a rail at all.
 *
 * THE OTHER TWO COME FROM `countries.payout_method`, and that is why a country
 * offers one of them rather than both. 046 put that column there so the SCREEN
 * would stop offering a product the customer's money cannot reach, and 067
 * made the SERVER read the same row: the destination is normalised as a phone
 * number where it says `mobile_money` and left as typed where it says `bank`.
 * One value, one shape. Offering both in Ghana would send a bank account
 * number down a path that normalises it as an MTN wallet — the failure 046
 * exists to prevent, in the direction that cannot be recalled.
 *
 * So a country that pays out by wallet offers Mobile Money and Xetral, one
 * that pays out to banks offers Bank transfer and Xetral, and a currency
 * belonging to no country — the dollar and the stablecoins — offers Xetral
 * alone, which is the truth about what can be paid out in it.
 */
function methodsFor(country: XetralCountry | undefined): readonly Method[] {
  if (country === undefined) return ['xetral'];

  /*
   * READ FROM `payout_methods`, WHICH IS A SET SINCE 070.
   *
   * It was `payout_method`, one value, so a country offered a wallet OR a
   * bank and never both — and in Ghana and Kenya it is both: most people are
   * paid into an MTN or M-PESA wallet, plenty into a bank account. Widening
   * the screen alone would have been worse than the gap: the SERVER
   * normalised the destination by that same single value, so a bank account
   * number typed on a country marked `mobile_money` was rewritten as a phone
   * number and sent to a wallet nobody holds. 070 made the column a set and
   * the request carry which one, so both halves now agree.
   *
   * ORDERED BY THE COUNTRY'S OWN DEFAULT, so the rail most people there use
   * is the first row rather than whichever happens to sort first.
   */
  const offered = country.payout_methods ?? [country.payout_method];
  const rails: Method[] = [];
  for (const rail of offered) {
    if (rail === 'mobile_money') rails.push('momo');
    else if (rail === 'bank') rails.push('bank');
  }
  const opensOn: Method = country.payout_method === 'mobile_money' ? 'momo' : 'bank';
  rails.sort((a, b) => Number(b === opensOn) - Number(a === opensOn));

  /* XETRAL LAST RATHER THAN FIRST, deliberately: a customer who came here to
     pay a bank or a wallet should not have to read past an option about this
     app. It is never absent, because a transfer between two balances here is
     not a rail and is always available. */
  return [...rails, 'xetral'];
}

const METHOD_COPY: Readonly<Record<Method, { title: string; sub: string; icon: IconName }>> = {
  bank: {
    title: 'Send via bank transfer',
    sub: 'Use bank transfer to send money to a previous or new recipient',
    icon: 'bank',
  },
  momo: {
    title: 'Send via Mobile Money',
    sub: 'Send to a mobile money wallet instantly',
    icon: 'phone',
  },
  xetral: {
    title: 'Send to a Xetral user',
    sub: 'Instant and free, straight to their Xetral balance',
    icon: 'send',
  },
};

/**
 * How the money reaches them.
 *
 * THE STEP THAT WAS MISSING, and its absence is what made the network picker
 * carry two questions. "Xetral, a bank, or a wallet?" is a question about the
 * PRODUCT; "MTN or Telecel?" is a question about a network — and a list that
 * asked both put the Xetral account in the position of a fourth mobile money
 * operator.
 *
 * IT IS SKIPPED WHERE THERE IS ONE ANSWER. A screen offering a single option
 * is a tap that asks nothing, so a currency with one deliverable method goes
 * straight on to the details.
 */
function ChooseMethod({
  receive,
  countries,
  onPick,
}: {
  receive: string;
  countries: readonly XetralCountry[];
  onPick: (method: Method) => void;
}) {
  const country = countries.find((c) => c.currency === receive);
  const methods = methodsFor(country);

  /* ONE ANSWER IS NOT A QUESTION. `useEffect` rather than picking during the
     render, because setting a parent's state while rendering a child is what
     React refuses — and the list has to have been computed to know. */
  useEffect(() => {
    if (methods.length === 1 && methods[0] !== undefined) onPick(methods[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receive]);
  if (methods.length === 1) return null;

  return (
    <section className="sf">

      <div className="sf-methods">
        {methods.map((method) => (
          <button
            key={method}
            type="button"
            className="sf-method"
            onClick={() => onPick(method)}
          >
            <span className="sf-method-icon">
              {/* THE SHARED TABLE, not a mark drawn here. `@xetral/client`'s
                  icons are what both apps render, so a method row on the phone
                  and on the web cannot come to show different glyphs. */}
              <Icon name={METHOD_COPY[method].icon} size={22} />
            </span>
            <span className="sf-method-text">
              <span className="sf-method-title">{METHOD_COPY[method].title}</span>
              <span className="sf-method-sub">{METHOD_COPY[method].sub}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ step 3 */

/**
 * Where it lands, and who holds it.
 *
 * THE COUNTRY IS READ OFF THE CURRENCY AND CANNOT BE TYPED. Cedis land in
 * Ghana; offering a country picker here would let somebody select Kenya and
 * GHS and produce a destination no rail can reach. It is shown because a
 * customer should be able to SEE what was inferred, and it is not editable
 * because changing it means changing the currency, which is one step back.
 *
 * THE ACCOUNT NAME IS FETCHED, NEVER TYPED — where the rail can answer. That
 * is the whole of what "the momo details cannot be found" was: the adapter
 * matched a network code and refused before making the call, so a Ghanaian
 * number whose owner Flutterwave will name was reported as unfindable.
 *
 * AND WHERE THE RAIL *CAN* ANSWER, SILENCE IS A REFUSAL. `name_status` tells
 * the two apart: `unavailable` means no name enquiry EXISTS on this rail —
 * Kenya's M-PESA, 067's rule — and the send goes on, because demanding a claim
 * that cannot exist is an outage rather than a control. `failed` means one
 * exists and did not answer, which on a Ghanaian wallet means the number is
 * wrong or the wallet is dead. Money sent to a wallet is unrecoverable, so
 * Continue is REFUSED there and the screen says which number to check.
 *
 * THE DIALLING CODE IS DRAWN, NOT TYPED. The currency step already fixed the
 * country, so the field shows `+233` and holds the national digits — and the
 * trunk zero comes off as it is typed, because `+233 0244…` is a number
 * belonging to nobody and a customer must never be looking at a string the
 * server is about to change behind them.
 */
function RecipientDetails({
  receive,
  method,
  countries,
  initialDestination,
  onReady,
}: {
  receive: string;
  /** Decided one step earlier. It is what this form is FOR, so nothing here
   *  re-derives it from a row in the rail picker. */
  method: Method;
  countries: readonly XetralCountry[];
  initialDestination: string;
  onReady: (resolution: RecipientResolution, saved: Recipient | undefined) => void;
}) {
  const client = useXetral();
  const { busy, error, code, run } = useSubmit();

  const country = countries.find((c) => c.currency === receive);
  /* A XETRAL SEND HAS NO RAIL TO PICK, so the picker is not drawn and the
     value is settled. Where there is one, it starts empty: a default network
     is a network somebody sends to without choosing it. */
  const [rail, setRail] = useState(method === 'xetral' ? 'xetral' : '');
  const [destination, setDestination] = useState(nationalDigits(initialDestination));
  const [found, setFound] = useState<RecipientResolution | undefined>(undefined);
  const [sheet, setSheet] = useState(false);
  /* GHANA REFUSES A BANK TRANSFER WITHOUT A BRANCH CODE. Nowhere else asks,
     so the picker exists only when the server answers with branches. */
  const [branch, setBranch] = useState('');
  const [branchSheet, setBranchSheet] = useState(false);

  /* THE CATALOGUE FOR THE RAIL THE CUSTOMER CHOSE. A country offering both
     (070) has two, and they are not interchangeable — an MTN network code is
     not a bank code, and a picker built from the wrong one is a selection that
     fails at the transfer and reads as the customer's own number being wrong. */
  const banks = useLoad(
    async () =>
      country === undefined || method === 'xetral'
        ? []
        : client.payoutBanks(country.code, method === 'momo' ? 'mobile_money' : 'bank'),
    [country?.code, method],
  );

  /*
   * THE XETRAL ACCOUNT IS A ROW IN THE SAME LIST AS THE NETWORKS.
   *
   * That is the unification. "How does this reach them" is ONE question with
   * several answers, and an internal transfer is one of the answers rather
   * than a separate product behind a tab — so a customer who does not know
   * whether their friend has an account picks from one list and finds out. It
   * is first because it is instant and free, which is the answer most people
   * want when it applies.
   */
  /*
   * THE PICKER ASKS ONE QUESTION NOW, and that is the whole of what moving the
   * method out changed.
   *
   * `XETRAL` used to sit in this list above MTN, Telecel and AirtelTigo — so a
   * customer choosing between "an account on this app" and "a mobile money
   * wallet" was choosing from the same control as somebody choosing between
   * two networks, and the Xetral account read as a fourth operator. The method
   * step asks that first; this list is now only networks, or only banks.
   *
   * A MOMO NETWORK IS NAMED THE WAY PEOPLE SAY IT: MTN, TELECEL, AIRTELTIGO.
   * The rail returns "MTN Mobile Money Ghana", a provider catalogue string
   * rather than a name a customer picks from a list.
   */
  const isMomoCountry = method === 'momo';
  const rails = (banks.data ?? []).map((bank) => ({
    value: bank.code,
    label: isMomoCountry ? networkLabel(bank.code, bank.name) : bank.name,
  }));

  const kind: RecipientKind = method;

  /*
   * THE BRANCHES OF THE CHOSEN BANK, and an empty list is the common answer.
   *
   * Flutterwave refuses a Ghanaian transfer without a `destination_branch_code`
   * — 070 gave Ghana a bank rail and every send on it would have failed. The
   * SERVER decides whether a corridor needs one, so this screen draws a picker
   * when something comes back and nothing when it does not, rather than
   * carrying a list of countries that need branches.
   */
  const branches = useLoad(
    async () =>
      country === undefined || method !== 'bank' || rail === ''
        ? []
        : client.payoutBranches(country.code, rail),
    [country?.code, method, rail],
  );
  const needsBranch = (branches.data ?? []).length > 0;
  const branchName = (branches.data ?? []).find((b) => b.code === branch)?.name;

  /*
   * ENOUGH TYPED TO BE WORTH ASKING ABOUT, and the floor is PER RAIL.
   *
   * A Ghanaian MTN number and a Kenyan Safaricom number are NINE national
   * digits; a NUBAN is ten. A flat floor of ten meant the lookup never fired
   * for a customer who typed theirs without the trunk zero — so no request was
   * made, nothing came back, and the button stayed disabled with nothing on
   * screen saying why.
   *
   * ONE DEFINITION, read by the lookup AND by the button. Two copies of this
   * condition is exactly what made the old screen's button enable and do
   * nothing, and `momo-send.test.ts` fails the build on either re-deriving it.
   */
  const mobileMoney = kind !== 'bank';
  const minimumDigits = mobileMoney ? 9 : 10;
  const enough = destination.replace(/[^0-9]/g, '').length >= minimumDigits;

  const pickerLabel = isMomoCountry ? 'Network' : 'Bank';
  /* Nothing to choose on a Xetral send: the destination is a Xetral account
     and the only question left is the number. */
  const needsRail = method !== 'xetral';
  const numberLabel = kind === 'bank' ? 'Account number' : 'Phone number';
  const railLabel = rails.find((r) => r.value === rail)?.label;

  /*
   * A DIAL PREFIX NEEDS A COUNTRY, and `USD`, `USDT` and `USDC` belong to
   * none — `sendableFor` offers them to everybody precisely because they are
   * nobody's national money. A Xetral send in one of those falls back to the
   * plain field, where the customer types the number whole, rather than being
   * shown a `+` with nothing after it.
   */
  const dialCode = (country?.dial_code ?? '').replace(/[^0-9]/g, '');
  const isPhone = kind !== 'bank' && dialCode !== '';

  /**
   * Ask the rail as soon as the field is left.
   *
   * ON BLUR RATHER THAN ON SUBMIT, so the holder's name is on screen before
   * the button is pressed — and so a number that cannot be verified says so
   * while the customer is still looking at the digits they typed.
   */
  function askTheRail(): void {
    if ((needsRail && rail === '') || !enough) return;
    void run(async () => {
      setFound(await doResolve());
      return undefined;
    });
  }

  /*
   * WHETHER THE NAME IS A GATE, decided by whether one could ever have come.
   *
   * `failed` is the only blocking answer, and it can only be given by a rail
   * that HAS a name enquiry — Ghana's wallets, every bank, a Xetral account.
   * `unavailable` is Kenya, where no such call exists at all, and gating on it
   * would refuse every M-PESA send on a claim the rail cannot make.
   */
  const blocked = found?.name_status === 'failed';

  /**
   * Ask the server who holds this destination.
   *
   * IT ALWAYS ANSWERS — the resolve path does not throw on a rail that cannot
   * name a holder — so what comes back carries `name_status`, and this screen
   * decides what to do with it. A Xetral number that belongs to nobody still
   * fails here, which is the one refusal on this screen that is a 404.
   */
  async function doResolve(): Promise<RecipientResolution> {
    return client.resolveRecipient({
      kind,
      /* THE COUNTRY GOES EVEN ON THE XETRAL BRANCH — a national number has no
         country in it, and leaving it off is what made `08031234567` resolve
         to nobody. This flow fixed one at the currency step, so the server
         normalises through THAT country's dial code, not the sender's. */
      ...(country === undefined ? {} : { country: country.code }),
      ...(kind === 'xetral' ? {} : { railCode: rail }),
      /* Ghana refuses a transfer without a branch, and this is the screen
         that picks one — so it travels with the resolution to the row a later
         tap will send from without re-reading. */
      ...(branch === '' ? {} : { branchCode: branch }),
      destination,
    });
  }

  async function proceed(resolution: RecipientResolution): Promise<void> {
    /*
     * SAVING IS BEST-EFFORT AND NEVER GATES THE SEND. The recipient book fills
     * from paying people (mockup 2 is that list), so every send saves — but a
     * save that fails must not strand a customer who only wanted to pay once.
     * The amount step reads `draft` when there is no saved row, and toRecipient
     * gives it a display name, so the send works either way.
     */
    let saved: Recipient | undefined;
    try {
      saved = await client.saveRecipient({
        kind: resolution.kind,
        ...(resolution.country === '' ? {} : { country: resolution.country }),
        ...(resolution.rail_code === null ? {} : { railCode: resolution.rail_code }),
        ...(resolution.branch_code === null ? {} : { branchCode: resolution.branch_code }),
        destination: resolution.destination,
        ...(resolution.resolved_name === null
          ? { label: destination.replace(/[^0-9]/g, '') }
          : {}),
      });
    } catch {
      saved = undefined;
    }
    onReady(resolution, saved);
  }

  return (
    <>
      <form
        className="sf"
        onSubmit={(event) => {
          event.preventDefault();
          if ((needsRail && rail === '') || !enough || blocked) return;
          if (needsBranch && branch === '') return;
          void run(async () => {
            /*
             * THE NAME IS SHOWN BEFORE THE MONEY MOVES, wherever one exists.
             *
             * A rail that CAN name the holder shows it and the customer
             * confirms; a rail that cannot — Kenya — proceeds in one press,
             * because there is nothing to confirm and asking for a label
             * instead is a confirmation screen that confirms nothing (043).
             * A rail that can and DID NOT answer stops here: `blocked` above
             * disables the button, and this re-check is the server-side half
             * of that rule at the one place it matters.
             */
            const resolution = found ?? (await doResolve());
            setFound(resolution);
            if (resolution.name_status === 'failed') return undefined;
            if (found !== undefined || resolution.name_status === 'unavailable') {
              await proceed(resolution);
            }
            return undefined;
          });
        }}
      >
        <p className="sf-sub">
          {method === 'xetral'
            ? 'Their Xetral phone number — the money arrives instantly'
            : method === 'momo'
              ? 'Fill in the mobile money details of your recipient'
              : 'Fill in the bank details of your recipient'}
        </p>

        <div className="sf-group">
          <span className="sf-label">Recipient country</span>
          <input className="sf-field" value={country?.name ?? receive} readOnly />
        </div>

        {needsRail && (
        <div className="sf-group">
          <span className="sf-label">{pickerLabel}</span>
          <div className="sf-select-wrap">
            <button
              type="button"
              className={sheet ? 'sf-select open' : railLabel ? 'sf-select' : 'sf-select placeholder'}
              onClick={() => setSheet(true)}
            >
              {railLabel ?? pickerLabel}
            </button>
            {/* A DRAWN CHEVRON. `▼` is a font glyph, so it rendered as a fat
                black triangle on Android and a hairline one on iOS — the same
                control looking like a different control per device. */}
            <span className={sheet ? 'sf-select-arrow up' : 'sf-select-arrow'}>
              <Icon name="chevronDown" size={18} />
            </span>
          </div>
        </div>
        )}

        {/* ONLY WHERE THE RAIL ASKS. Ghana refuses a transfer without a
            branch; every other corridor answers an empty list and this is
            not drawn at all. */}
        {needsBranch && (
          <div className="sf-group">
            <span className="sf-label">Branch</span>
            <div className="sf-select-wrap">
              <button
                type="button"
                className={
                  branchSheet ? 'sf-select open' : branchName ? 'sf-select' : 'sf-select placeholder'
                }
                onClick={() => setBranchSheet(true)}
              >
                {branchName ?? 'Branch'}
              </button>
              <span className={branchSheet ? 'sf-select-arrow up' : 'sf-select-arrow'}>
                <Icon name="chevronDown" size={18} />
              </span>
            </div>
          </div>
        )}

        <div className="sf-group">
          <span className="sf-label">{numberLabel}</span>
          {isPhone ? (
            /*
             * THE COUNTRY CODE IS A LABEL AND THE BOX HOLDS THE REST. One
             * place a country is stated — 040's rule that a second picker
             * lets somebody select Ghana and +234 — and it comes off the
             * country the currency step already fixed.
             */
            <div className="sf-phone">
              <span className="sf-dial">
                +{(country?.dial_code ?? '').replace(/[^0-9]/g, '')}
                <span className="sf-dial-country">{country?.name ?? ''}</span>
              </span>
              <input
                value={destination}
                onChange={(e) => {
                  setDestination(nationalDigits(e.target.value));
                  setFound(undefined);
                }}
                onBlur={askTheRail}
                inputMode="numeric"
                placeholder={phoneHint(country?.dial_code)}
                autoComplete="off"
                aria-label={numberLabel}
              />
            </div>
          ) : (
            <input
              className="sf-field"
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value.replace(/[^0-9]/g, ''));
                setFound(undefined);
              }}
              onBlur={askTheRail}
              inputMode="numeric"
              placeholder={kind === 'bank' ? '0123456789' : '+234 803 123 4567'}
              autoComplete="off"
            />
          )}
        </div>

        {/* THE NAME, THE MOMENT IT ARRIVES. Not a read-only input dressed as a
            field — a field invites editing, and this is the rail's answer
            rather than anything the customer may change. */}
        {found?.resolved_name != null && (
          <span className="sf-verified">
            <Icon name="check" size={16} />
            {found.resolved_name}
          </span>
        )}

        {/*
          A RAIL THAT CAN NAME A HOLDER AND DID NOT IS A STOP, not a warning.
          Ghana's wallets resolve, so silence means the number is wrong or the
          wallet is inactive — and momo is unrecoverable once sent. Kenya has
          no name enquiry at all, so nothing is said and nothing is blocked.
        */}
        {blocked && (
          <span className="sf-verify-bad">
            We could not verify this {railLabel ?? 'account'} number. Check the digits with
            your recipient — we will not send to a number nobody answers for.
          </span>
        )}

        <FormError error={error} code={code} />

        <button
          type="submit"
          className="sf-primary"
          disabled={
            busy || (needsRail && rail === '') || (needsBranch && branch === '') || !enough || blocked
          }
        >
          {busy
            ? 'Checking…'
            : blocked
              ? 'Number not verified'
              : found !== undefined
                ? 'Continue'
                : 'Check details'}
        </button>
      </form>

      {branchSheet && (
        <div
          className="sf-sheet-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setBranchSheet(false)}
        >
          <div className="sf-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sf-sheet-handle-row">
              <div className="sf-sheet-handle" />
            </div>
            <div className="sf-sheet-head">
              <span className="sf-sheet-title">Select a branch</span>
              <button
                type="button"
                className="sf-sheet-close"
                aria-label="Close"
                onClick={() => setBranchSheet(false)}
              >
                ✕
              </button>
            </div>
            <div>
              {(branches.data ?? []).map((b) => (
                <button
                  key={b.code}
                  type="button"
                  className="sf-net"
                  onClick={() => {
                    setBranch(b.code);
                    setBranchSheet(false);
                  }}
                >
                  <span className="sf-net-name">{b.name}</span>
                  <span className={branch === b.code ? 'sf-radio on' : 'sf-radio'} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {sheet && (
        <div
          className="sf-sheet-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setSheet(false)}
        >
          <div className="sf-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sf-sheet-handle-row">
              <div className="sf-sheet-handle" />
            </div>
            <div className="sf-sheet-head">
              <span className="sf-sheet-title">
                Select a {isMomoCountry ? 'network provider' : 'bank'}
              </span>
              <button
                type="button"
                className="sf-sheet-close"
                aria-label="Close"
                onClick={() => setSheet(false)}
              >
                ✕
              </button>
            </div>
            <div>
              {rails.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className="sf-net"
                  onClick={() => {
                    setRail(r.value);
                    setFound(undefined);
                    /* A BRANCH BELONGS TO A BANK. Keeping the old one would
                       send a transfer to a branch of a different bank, which
                       the rail would refuse in a sentence about the account. */
                    setBranch('');
                    setSheet(false);
                  }}
                >
                  <span className="sf-net-name">{r.label}</span>
                  <span className={rail === r.value ? 'sf-radio on' : 'sf-radio'} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ step 4 */

/**
 * What leaves, what lands, and what it costs.
 *
 * TWO CARDS RATHER THAN ONE FIELD, because a cross-border payment has two
 * amounts and a customer cares about the second. The old screen showed one
 * box and a line of text; here "they receive" is a figure in its own right,
 * and the currency on each side is a control rather than a label.
 */
function SendAmount({
  to,
  receiveCurrency,
  balances,
  home,
  onSent,
}: {
  to: Recipient;
  /** What the recipient RECEIVES, as the flow decided it — not as the row
   *  records it. A Xetral account holds its own country's money and the
   *  customer may have chosen to send something else. */
  receiveCurrency: string;
  balances: readonly { currency: string; spendable: string }[];
  home: string;
  /* WHAT LEFT AND WHO GOT IT, because the confirmation names both. A
     callback taking nothing meant the parent had to re-derive an amount the
     step it just finished already knew. */
  onSent: (sent: {
    amount: string;
    currency: string;
    name: string;
    destination: string;
    /** Absent for a wallet transfer, which returns none. */
    reference?: string;
    instant: boolean;
  }) => void;
}) {
  const client = useXetral();
  const { busy, error, code, done, run } = useSubmit();
  const { key, next } = useIdempotencyKey();
  /*
   * READ ONCE WHEN THE SCREEN OPENS. A fee is a proportion, so the POLICY is
   * fetched and applied to whatever is typed — asking the server again on
   * every keystroke would be a round trip per digit. It is allowed to fail
   * silently: the fee row is a courtesy on a screen whose job is moving
   * money, and the authoritative charge is the ledger's either way.
   */
  const feePolicy = useLoad(() => client.transferFee().catch(() => undefined), [client]);

  /*
   * A PAYOUT CARRIES ONE CURRENCY, AND THIS SCREEN USED TO SEND IT TWO.
   *
   * THE BUG, WHICH WAS WORSE THAN THE REFUSAL IT PRODUCED. `payToBank` was
   * called with `amount` — the figure the customer TYPED, in the currency
   * they were sending — and `currency: lands_in`, the currency it LANDS in.
   * Those describe different things, and `/v1/payouts` performs no
   * conversion: it debits `walletAccount(user, currency)` by that amount.
   *
   * So a Ghanaian with ₵8.32 asking to send 2 cedis to a Nigerian bank had
   * ₦2 requested from a naira wallet holding nothing, and read "Your balance
   * will not cover this" beside a balance that plainly covered it. THE
   * DANGEROUS HALF IS THE OTHER CUSTOMER: somebody who DOES hold naira would
   * have had the request succeed and ₦2 leave, where the screen had just
   * promised ₦235.01. A wrong amount actually leaving is worse than a
   * refusal, and nothing in the ledger would have been unbalanced by it.
   *
   * THE CURRENCY IS THEREFORE FIXED FOR A PAYOUT, not corrected at the call
   * site. A bank account or a wallet receives exactly one currency, so the
   * send currency IS the payout currency — there is no second one for the
   * two to disagree about. Converting first is a separate, deliberate act on
   * the Convert screen, which is where a customer can see the rate they are
   * accepting rather than having one applied inside a send.
   *
   * A XETRAL RECIPIENT IS UNCHANGED and keeps the picker: a different
   * currency there is a REMITTANCE, which converts and pays in ONE entry —
   * 008's rule — so the two currencies are the point rather than a mismatch.
   */
  const [sendCurrency, setSendCurrency] = useState(
    to.kind === 'xetral' ? home : receiveCurrency,
  );
  const currencyIsFixed = to.kind !== 'xetral';
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');

  /*
   * WHAT LANDS IS `receiveCurrency`, NOT `to.currency`, ON EVERY LINE BELOW.
   *
   * The row records what a Xetral recipient's own country uses; the flow
   * records what the customer chose on the screen headed "What currency are
   * you sending?". Reading the row is what made a naira send to a Ghanaian
   * friend quote in cedis.
   */
  const lands_in = receiveCurrency;
  const balance = balances.find((b) => b.currency === sendCurrency)?.spendable ?? '0';
  const sameCurrency = sendCurrency === lands_in;

  /*
   * A QUOTE CARRIES THE AMOUNT IT IS A QUOTE FOR.
   *
   * `useLoad` keeps the last successful result while the next request is in
   * flight and after one fails, which is right for a balance and wrong for a
   * rate: type 25, clear it, type 20, and "they receive" goes on showing what
   * 25 converts to — correct arithmetic about an amount the customer has
   * already replaced. Stamping the answer with the amount and rendering only
   * on a match is structural; a debounce is not, because the stale figure
   * comes back on the next refusal either way.
   */
  const quote = useLoad(
    async () => {
      if (sameCurrency || !isValidAmount(amount, exponentFor(sendCurrency))) return undefined;
      const got = await client.fxQuote(sendCurrency, lands_in, amount);
      return { forAmount: amount, ...got };
    },
    [sendCurrency, lands_in, amount, sameCurrency],
  );
  const lands = quote.data?.forAmount === amount ? quote.data : undefined;

  /*
   * NO `Number(amount)` HERE, and the absence is the rule rather than an
   * omission. `isValidAmount` already refuses a negative (its pattern starts
   * `^[0-9]+`) and already refuses zero (it demands a digit 1-9), so the
   * `> 0` this line used to carry was redundant AND was a float holding
   * money — caught by `.semgrep/xetral.yml`, which is what that rule is for.
   */
  const enough = isValidAmount(amount, exponentFor(sendCurrency));

  /* THE GAP BETWEEN A VALID AMOUNT AND ITS RATE, which is the only moment the
     receiving box has nothing true to show. Saying "Converting…" there is the
     difference between a screen that is working and one that is refusing. */
  const converting = !sameCurrency && enough && lands === undefined && quote.code === undefined;
  /*
   * BELOW THE CORRIDOR'S FLOOR, and it only counts once something was typed.
   *
   * `useLoad` keeps the last error while the next request is in flight, so
   * gating on the amount being non-empty is what stops a stale refusal
   * describing a box the customer has since cleared — the same reason the
   * quote itself is stamped with `forAmount`.
   */
  const belowMinimum = amount !== '' && enough && quote.code === 'below_minimum';

  return (
    <form
      className="send-step"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          /*
           * THREE PATHS, AND THE CUSTOMER CHOSE NONE OF THEM.
           *
           * A Xetral account in the same currency is a wallet transfer; in a
           * different one it is a REMITTANCE, which converts and pays in one
           * entry rather than leaving money in a wallet the sender never
           * meant to hold. Anything else leaves through a payout. The old
           * screen made this a tab; here it follows from the recipient and
           * the currency, which is the whole of the unification.
           */
          /*
           * THE RESULT IS CAPTURED, because the confirmation screen names a
           * reference — and only two of the three paths have one.
           *
           * `POST /v1/wallets/transfers` answers an amount, a fee and a
           * currency: there is nothing on it a customer could quote. A bank
           * payout and a conversion both come back with an id. The screen
           * omits the row rather than inventing a string, which is the same
           * call the fee row makes one step earlier.
           */
          let reference: string | undefined;
          /*
           * AND THE AMOUNT THE CONFIRMATION SHOWS IS THE SERVER'S, NOT THE
           * ONE THAT WAS TYPED.
           *
           * `formatAmount` renders whatever fraction it is given, so the typed
           * "1200" came out as `₦1,200` on the screen that RECORDS what left
           * the account — where the canonical `₦1,200.00` belongs. Every one
           * of these calls answers with the figure the ledger posted, which
           * is both correctly scaled and, for a conversion, the amount
           * actually filled rather than the one quoted.
           */
          let recorded = amount;
          if (to.kind === 'xetral' && sameCurrency) {
            recorded = (await client.transfer({
              recipient: to.destination,
              amount,
              currency: sendCurrency,
              pin,
              idempotencyKey: key,
            })).amount;
          } else if (to.kind === 'xetral') {
            const trade = await client.remit({
              from: sendCurrency,
              to: lands_in,
              amount,
              recipient: to.destination,
              pin,
              idempotencyKey: key,
            });
            reference = trade.id;
            recorded = trade.amount;
          } else {
            const payout = await client.payToBank({
              country: to.country,
              bankCode: to.rail_code ?? '',
              accountNumber: to.destination,
              /* WHICH RAIL, from the recipient's own kind rather than from the
                 country's default. Ghana and Kenya offer both since 070, and the
                 server normalises the destination by this — a wallet number to
                 E.164, a bank account exactly as typed. */
              method: to.kind === 'momo' ? 'mobile_money' : 'bank',
              /* OFF THE SAVED ROW. A Ghanaian bank recipient is tapped from
                 the list without re-reading, so the branch has to be on the
                 row rather than asked again on a screen that tap skips. */
              ...(to.branch_code === null ? {} : { branchCode: to.branch_code }),
              amount,
              /* THE CURRENCY THE AMOUNT IS IN, which for a payout is fixed to
                 the recipient's own — see `currencyIsFixed` above. It used to
                 be `lands_in` while `amount` was the send currency's figure,
                 which is a request describing two different sums of money. */
              currency: sendCurrency,
              pin,
              idempotencyKey: key,
            });
            reference = payout.id;
            recorded = payout.amount;
          }
          next();
          setAmount('');
          setPin('');
          onSent({
            amount: recorded,
            currency: sendCurrency,
            name: to.display_name,
            destination: to.destination,
            ...(reference === undefined ? {} : { reference }),
            instant: to.kind === 'xetral',
          });
          return `Sent to ${to.display_name}.`;
        });
      }}
    >
      {/* WHO IS BEING PAID — the rail's own answer for the name where there is
          one, and the number only when there is not. */}
      <header className="sf-payee">
        <span className="sf-avatar-wrap" style={{ width: 44, height: 44 }}>
          <span className="sf-avatar" style={{ width: 44, height: 44, fontSize: 15 }}>
            {initialsOf(to.display_name)}
          </span>
        </span>
        <span className="sf-recip-info">
          <span className="sf-payee-name">{to.display_name}</span>
          <span className="sf-payee-sub">
            {railLabelOf(to)} &middot; {to.destination}
          </span>
        </span>
      </header>

      {/*
        THE AMOUNT IS ONE CENTRED FIGURE WITH A KEYPAD UNDER IT, which is what
        the comp draws — and it was two stacked boxes with typed inputs, one
        for what leaves and one for what lands.

        Two boxes made the screen a FORM. The comp makes it a til: the figure
        is the biggest thing on it, what the recipient gets is one quiet line
        beneath, and the digits are a 3×4 grid under the thumb. On a handset
        that is the difference between reaching for a keyboard that covers
        half the screen and tapping four keys.

        THE INPUT IS STILL A REAL `<input>`, positioned over the figure and
        transparent. A laptop has a keyboard and an accessibility tool needs
        something focusable with a label; the keypad writes into the same
        state. Rendering only a `<div>` would make this screen typable by
        exactly one kind of visitor.
      */}
      <div className="sf-enter">
        <span className="sf-enter-label">You send</span>
        <div className={enough || amount === '' ? 'sf-enter-figure' : 'sf-enter-figure bad'}>
          <span aria-hidden="true">
            {symbolFor(sendCurrency)}
            {amount === '' ? '0' : groupTyped(amount)}
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label={`Amount to send in ${sendCurrency}`}
          />
        </div>

        {/* WHICH CURRENCY, where the rail has not already decided it. Stated
            rather than offered where it has — a picker whose only valid
            answer is the one already shown is a control that can only be got
            wrong, and getting it wrong here sent two different sums of money
            in one request. */}
        {!currencyIsFixed && (
          <div className="sf-enter-ccy">
            <Select
              value={sendCurrency}
              onChange={setSendCurrency}
              options={balances.map((b) => ({ value: b.currency, label: b.currency }))}
              renderMark={(value) => <CurrencyMark currency={value} size={18} />}
              compact
            />
          </div>
        )}

        {/*
         * A FIGURE, NEVER A DASH AND NEVER A STALE ZERO.
         *
         * The conversion is automatic: type 100 naira and the cedi figure
         * follows as soon as the quote lands. What it must not do is sit at
         * zero in the gap — a zero beside a typed amount reads as "this
         * corridor pays nothing", which is a sentence about the product. So
         * while the rate is in flight the line says so, and only an EMPTY
         * amount box renders a zero.
         */}
        <p className="sf-enter-recv">
          {firstNameOf(to.display_name)} receives{' '}
          <strong>
            {converting
              ? '…'
              : sameCurrency
                ? formatAmount(amount === '' ? '0' : amount, lands_in)
                : formatAmount(lands?.receives ?? '0', lands_in)}
          </strong>
        </p>

        {/*
          ONE SENTENCE AT A TIME, and only when there is one to say.

          THE MINIMUM APPEARS ONLY ONCE A CUSTOMER HAS TYPED LESS THAN IT. A
          corridor's floor printed on an empty field is noise on every send;
          printed the moment somebody asks for 2 cedis it is the one sentence
          that gets them to a working amount. Before this the refusal reached
          the screen as nothing at all — the quote failed, the receives line
          fell back to a generic hint, and the customer was left to guess
          upward.
        */}
        {amount !== '' && !enough ? (
          <span className="sf-enter-chip bad">
            Exceeds your {formatAmount(balance, sendCurrency)} balance
          </span>
        ) : belowMinimum ? (
          <span className="sf-enter-chip bad">{quote.error}</span>
        ) : quote.code === 'pair_not_supported' ? (
          <span className="sf-enter-chip bad">
            We cannot convert {sendCurrency} to {lands_in} yet
          </span>
        ) : !sameCurrency && lands !== undefined ? (
          <span className="sf-enter-chip">
            1 {sendCurrency} = {formatAmount(lands.rate, lands_in)}
          </span>
        ) : (
          <span className="sf-enter-chip">
            {to.kind === 'xetral' ? 'Arrives instantly' : 'Usually arrives within minutes'}
          </span>
        )}
      </div>

      {/*
        THE FEE IS READ FROM THE SERVER AND NEVER ASSUMED.

        It is a POLICY in basis points — `GET /v1/wallets/fee` — applied to
        what is in the box, because a fee is a proportion and asking again on
        every keystroke would be a round trip per digit. The authoritative
        charge is still the ledger's, computed on the entry; this is so a
        customer is not surprised by it.

        THE ROW IS ABSENT UNTIL THE ANSWER ARRIVES, rather than showing a zero
        while it is in flight. "Fee ₦0.00" that becomes "Fee ₦25.00" a moment
        later is worse than a row that was not there yet.
      */}
      {feePolicy.data !== undefined && (
        <div className="sf-fee">
          <span>Fee</span>
          <span>{formatAmount(feeOn(amount, feePolicy.data.basis_points, sendCurrency), sendCurrency)}</span>
        </div>
      )}

      {/* THE KEYPAD. `type="button"` on every key, because a bare <button>
          inside a <form> submits it — which here would send money on a
          digit. */}
      <div className="sf-pad" role="group" aria-label="Amount keypad">
        {PAD.map((key) => (
          <button
            key={key}
            type="button"
            className="sf-key"
            onClick={() => setAmount((was) => pressKey(was, key))}
            aria-label={key === '<' ? 'Delete' : key}
          >
            {/*
              DRAWN, NOT A GLYPH AND NOT A BORROWED ICON.

              `⌫` (U+232B) is absent from Manrope and from every fallback in
              the stack, so it rendered as a box with a cross in it. Reaching
              for `chevronLeft` instead was worse in a quieter way: that is
              the product's BACK arrow, and a back arrow on a keypad says
              "previous screen" on the one key that means "delete a digit".
            */}
            {key === '<' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L2.5 12 9 5Z" />
                <path d="M18 9.5 13 14.5M13 9.5l5 5" />
              </svg>
            ) : key}
          </button>
        ))}
      </div>

      <label className="field">
        <span className="field-label">Transaction PIN</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          maxLength={12}
        />
      </label>

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

      {/* AND THE BUTTON IS REFUSED WHILE THE AMOUNT IS BELOW THE FLOOR. The
          note above says what the minimum is; letting Continue through anyway
          would spend a PIN attempt to be told the same thing by the server. */}
      <button type="submit" disabled={busy || !enough || belowMinimum || pin === ''}>
        {busy ? 'Sending…' : 'Continue'}
      </button>

      <p className="hint">
        Wrong person? <Link href="/transfer">Choose somebody else</Link>.
      </p>
    </form>
  );
}

/* --------------------------------------------------------------- the small */

/** A draft, rendered by the same component a saved recipient is. */
function toRecipient(found: RecipientResolution): Recipient {
  return {
    id: '',
    kind: found.kind,
    country: found.country,
    currency: found.currency,
    rail_code: found.rail_code,
    rail_name: found.rail_name,
    branch_code: found.branch_code,
    destination: found.destination,
    display_name: found.resolved_name ?? found.destination,
    resolved_name: found.resolved_name,
    last_used_at: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Initials, for the disc beside a name.
 *
 * TWO LETTERS AT MOST. A name with five words produces five letters in a
 * 42-pixel circle, which renders as an illegible smudge rather than as an
 * avatar — and the point of the disc is to be recognisable at a glance.
 */
/**
 * The name a customer picks a network by.
 *
 * Flutterwave's catalogue says "MTN Mobile Money", "Vodafone Cash Ghana",
 * "AirtelTigo Money" — provider strings, not names. A picker is read at a
 * glance, so it reads MTN, VODAFONE, AIRTELTIGO, and XETRAL sits among them.
 */


/** The rail as it should READ on a row: "MTN", not "MTN Mobile Money". */
function railLabelOf(to: Recipient): string {
  if (to.kind === 'xetral') return 'XETRAL';
  return networkLabel(to.rail_code, to.rail_name ?? 'XETRAL');
}

/**
 * The name on the RECEIVING label — "Rabi receives", "553921133 receives".
 *
 * The whole legal name is on the header two rows above it, so repeating it
 * here wraps the label onto a second line on a 360px handset and says nothing
 * new. Where the rail could not name the holder, `display_name` is the number
 * and this is the number — which is what the customer typed and recognises.
 */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
