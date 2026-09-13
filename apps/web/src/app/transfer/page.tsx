'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  currencyName,
  exponentFor,
  formatAmount,
  isValidAmount,
  nationalDigits,
  networkLabel,
  phoneHint,
  sendableFor,
  symbolFor,
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

type Step = 'who' | 'currency' | 'method' | 'details' | 'amount';

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

  return (
    <Shell title="Send">
      {/* THE WAY BACK IS AT THE BOTTOM RIGHT, not the top left. A chevron above
          the heading cost a band of empty space on a handset and sat at the one
          corner a thumb holding the phone cannot reach. */}
      {step !== 'who' && <FlowBack onClick={back} />}

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
          onSent={() => {
            saved.reload();
            wallets.reload();
            setStep('who');
          }}
        />
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ step 1 */

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
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<string | undefined>(undefined);
  /* THE RAIL STAYS ON ONE LINE. Five chips do not fit a 360px handset, so
     three are shown and the rest sit behind "More" — which wraps them onto a
     second line rather than scrolling them out of reach. */
  const [allChips, setAllChips] = useState(false);
  const CHIP_LIMIT = 3;

  /*
   * THE CHIPS ARE WHAT THIS PLATFORM CAN SEND — NGN, USD, GHS, KES and the
   * stablecoins — not only the currencies already in the address book.
   *
   * Deriving them from saved recipients meant a customer with one Ghanaian
   * payee saw one chip, and a customer with none saw no rail at all: a filter
   * that appears once you no longer need it. `sendableFor` is the platform's
   * own answer, and the currencies actually used are ordered first so the
   * common ones stay in front of "More".
   */
  const currencies = useMemo(() => {
    const used = new Set(recipients.map((r) => r.currency));
    const offered = sendableFor(home);
    return [...offered].sort((a, b) => {
      const byUse = Number(used.has(b)) - Number(used.has(a));
      return byUse !== 0 ? byUse : offered.indexOf(a) - offered.indexOf(b);
    });
  }, [recipients, home]);

  const shown = recipients.filter((r) => {
    if (filter !== '' && r.currency !== filter) return false;
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
      <h1 className="sf-title">Send money to who?</h1>

      <div className="sf-search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or account details"
          aria-label="Search recipients"
        />
      </div>

      {currencies.length > 0 && (
        <div
          className={allChips ? 'sf-chips wrap' : 'sf-chips'}
          role="group"
          aria-label="Filter by currency"
        >
          <button
            type="button"
            className={filter === '' ? 'sf-chip on' : 'sf-chip'}
            onClick={() => setFilter('')}
          >
            {/* The 2×2 grid mark the mockup gives the All chip. */}
            <svg width="14" height="14" viewBox="0 0 14 14" fill={filter === '' ? '#3B6FE8' : '#2A2E3E'} aria-hidden="true">
              <rect x="0" y="0" width="5.5" height="5.5" rx="1.2" />
              <rect x="8.5" y="0" width="5.5" height="5.5" rx="1.2" />
              <rect x="0" y="8.5" width="5.5" height="5.5" rx="1.2" />
              <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.2" />
            </svg>
            All
          </button>
          {(allChips ? currencies : currencies.slice(0, CHIP_LIMIT)).map((currency) => (
            <button
              key={currency}
              type="button"
              className={filter === currency ? 'sf-chip on' : 'sf-chip'}
              onClick={() => setFilter(currency)}
            >
              <span className="sf-chip-flag">
                <CurrencyMark currency={currency} size={18} />
              </span>
              {currency}
            </button>
          ))}
          {!allChips && currencies.length > CHIP_LIMIT && (
            <button type="button" className="sf-chip" onClick={() => setAllChips(true)}>
              More
            </button>
          )}
        </div>
      )}

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

      <NewRecipientPill onClick={onNew} />
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
      <h1 className="sf-title">What currency are you sending?</h1>

      <div className="sf-search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search currency or country"
          aria-label="Search currencies"
        />
      </div>

      <CurrencyGroup heading="Favorites" codes={favourites} onPick={onPick} />
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
      <h1 className="sf-title">How do you want to send {receive}?</h1>

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
        <h1 className="sf-title">Who are you sending to?</h1>
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
          disabled={busy || (needsRail && rail === '') || !enough || blocked}
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
  onSent: () => void;
}) {
  const client = useXetral();
  const { busy, error, code, done, run } = useSubmit();
  const { key, next } = useIdempotencyKey();

  const [sendCurrency, setSendCurrency] = useState(home);
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
          if (to.kind === 'xetral' && sameCurrency) {
            await client.transfer({
              recipient: to.destination,
              amount,
              currency: sendCurrency,
              pin,
              idempotencyKey: key,
            });
          } else if (to.kind === 'xetral') {
            await client.remit({
              from: sendCurrency,
              to: lands_in,
              amount,
              recipient: to.destination,
              pin,
              idempotencyKey: key,
            });
          } else {
            await client.payToBank({
              country: to.country,
              bankCode: to.rail_code ?? '',
              accountNumber: to.destination,
              /* WHICH RAIL, from the recipient's own kind rather than from the
                 country's default. Ghana and Kenya offer both since 070, and the
                 server normalises the destination by this — a wallet number to
                 E.164, a bank account exactly as typed. */
              method: to.kind === 'momo' ? 'mobile_money' : 'bank',
              amount,
              currency: lands_in,
              pin,
              idempotencyKey: key,
            });
          }
          next();
          setAmount('');
          setPin('');
          onSent();
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

      {/* ONE STRAIGHT FIELD PER AMOUNT: the figure on the left, the currency on
          the right, and what it means in small text under it. */}
      {/*
        ONE GRID CHILD PER AMOUNT — the label, the box and the note together.
        `.send-step` has a 16px gap between children, so as three siblings the
        label sat 22px above its own box with the margins added on top. The
        label belongs TO the box; the gap belongs BETWEEN the two amounts.
      */}
      <div className="sf-amount-block">
        <span className="sf-label">You send</span>
        <div className={enough || amount === '' ? 'sf-amount' : 'sf-amount invalid'}>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            aria-label="Amount to send"
          />
          <Select
            value={sendCurrency}
            onChange={setSendCurrency}
            options={balances.map((b) => ({ value: b.currency, label: b.currency }))}
            renderMark={(value) => <CurrencyMark currency={value} size={18} />}
            compact
          />
        </div>
        {/* GREEN, because it is what the customer HAS — the only figure on this
            screen that is neither leaving nor landing. */}
        <span
          className={
            amount !== '' && !enough ? 'sf-amount-note bad' : 'sf-amount-note good'
          }
        >
          {amount !== '' && !enough
            ? `Enter an amount in ${sendCurrency}.`
            : `Balance: ${formatAmount(balance, sendCurrency)}`}
        </span>
      </div>

      <div className="sf-amount-block">
        <span className="sf-label">{firstNameOf(to.display_name)} receives</span>
        <div className="sf-amount">
          {/*
           * A FIGURE, NEVER A DASH AND NEVER A STALE ZERO.
           *
           * The conversion is automatic: type 100 naira and the cedi figure
           * follows as soon as the quote lands. What it must not do is sit at
           * zero in the gap — a zero beside a typed amount reads as "this
           * corridor pays nothing", which is a sentence about the product. So
           * while the rate is in flight the field says so, and only an EMPTY
           * amount box renders a zero.
           *
           * The currency's own SYMBOL comes from `formatAmount` — ₵ for a cedi,
           * KSh for a shilling — because a screen quoting "1,250.00 GHS" beside
           * "₦100,000.00" is showing money in one currency and a database field
           * in the other.
           */}
          {converting ? (
            <span className="sf-amount-value waiting">Converting…</span>
          ) : (
            <span className="sf-amount-value">
              {sameCurrency
                ? formatAmount(amount === '' ? '0' : amount, lands_in)
                : formatAmount(lands?.receives ?? '0', lands_in)}
            </span>
          )}
          <span className="sf-ccy">
            <CurrencyMark currency={lands_in} size={18} />
            {lands_in}
          </span>
        </div>
        <span className={quote.code === 'pair_not_supported' ? 'sf-amount-note bad' : 'sf-amount-note'}>
          {!sameCurrency && lands !== undefined
            ? `1 ${sendCurrency} = ${formatAmount(lands.rate, lands_in)}`
            : !sameCurrency && quote.code === 'pair_not_supported'
              ? `We cannot convert ${sendCurrency} to ${lands_in} yet`
              : to.kind === 'xetral'
                ? 'Arrives instantly'
                : 'Usually arrives within minutes'}
        </span>
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

      <button type="submit" disabled={busy || !enough || pin === ''}>
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
/**
 * The New-recipient pill, JUST ABOVE THE TAB BAR — and portalled to the body.
 *
 * `position: fixed` is contained by any ancestor with a transform, and the
 * Shell's `<main>` carries `screen-in`, whose animation does exactly that. So
 * the pill was laid out against a 900px-tall main and sat 275px BELOW the
 * screen: fixed, correct, and invisible. A portal puts it outside every
 * animated ancestor, which is the only version of this that cannot regress.
 */
function NewRecipientPill({ onClick }: { onClick: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return createPortal(
    <button type="button" className="sf-newbtn" onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <line x1="9" y1="2" x2="9" y2="16" />
        <line x1="2" y1="9" x2="16" y2="9" />
      </svg>
      New recipient
    </button>,
    document.body,
  );
}

/**
 * THE WAY BACK, at the bottom right of every step but the first.
 *
 * PORTALLED FOR THE SAME REASON THE PILL IS. `position: fixed` is contained
 * by any ancestor carrying a transform, and the Shell's `<main>` has
 * `screen-in`, whose animation creates exactly that — so a fixed child is laid
 * out against a 900px-tall main and lands below the fold. Measured, not
 * reasoned about, the first time it happened.
 */
function FlowBack({ onClick }: { onClick: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return createPortal(
    <button type="button" className="sf-flow-back" onClick={onClick}>
      <Icon name="chevronLeft" size={16} />
      Back
    </button>,
    document.body,
  );
}

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
