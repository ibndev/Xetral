'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  currencyName,
  exponentFor,
  formatAmount,
  isValidAmount,
  sendableFor,
  symbolFor,
} from '@xetral/client';
import type {
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

type Step = 'who' | 'currency' | 'details' | 'amount';

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

  const home = session.data?.home_currency ?? 'NGN';

  const back = () => {
    if (step === 'amount') setStep('details');
    else if (step === 'details') setStep(arrivedWith === '' ? 'currency' : 'who');
    else if (step === 'currency') setStep('who');
  };

  return (
    <Shell title="Send">
      {step !== 'who' && (
        <button type="button" className="icon-btn back" onClick={back} aria-label="Back">
          <Icon name="chevronLeft" size={20} />
        </button>
      )}

      {step === 'who' && (
        <ChooseRecipient
          recipients={saved.data ?? []}
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
            setStep('details');
          }}
        />
      )}

      {step === 'details' && (
        <RecipientDetails
          receive={receive === '' ? home : receive}
          countries={countries.data ?? []}
          initialDestination={arrivedWith}
          onReady={(resolution, recipient) => {
            setDraft(resolution);
            setChosen(recipient);
            setReceive(resolution.currency);
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
  onPick,
  onRemove,
  onNew,
}: {
  recipients: readonly Recipient[];
  onPick: (recipient: Recipient) => void;
  onRemove: (id: string) => Promise<void>;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<string | undefined>(undefined);

  /*
   * THE CHIPS ARE THE CURRENCIES THIS CUSTOMER ACTUALLY PAYS, not every
   * currency the platform offers. A filter for a currency nobody in the list
   * holds filters to nothing, which reads as a broken control rather than as
   * an empty result.
   */
  const currencies = useMemo(
    () => [...new Set(recipients.map((r) => r.currency))].sort(),
    [recipients],
  );

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
      <h1 className="sf-title">Who do you want to send money to?</h1>

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
        <div className="sf-chips" role="group" aria-label="Filter by currency">
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
          {currencies.map((currency) => (
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
                    {r.rail_name ?? 'Xetral account'} &nbsp;|&nbsp; &middot;&middot;&middot;
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

      <div className="sf-newbtn-row">
        <button type="button" className="sf-newbtn" onClick={onNew}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="9" y1="2" x2="9" y2="16" />
            <line x1="2" y1="9" x2="16" y2="9" />
          </svg>
          New recipient
        </button>
      </div>
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

  const favourites = all.filter((c) => (c === home || c === 'USD') && matches(c));
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
      <h1 className="sf-title">What currency should your recipient receive?</h1>

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
            <CurrencyMark currency={code} size={44} />
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
 * number whose owner Flutterwave will name was reported as unfindable. Where
 * the rail genuinely has none — Kenya's M-PESA — the screen ASKS FOR A LABEL
 * rather than refusing, because a bare number in an address book is how
 * somebody pays the wrong person.
 */
function RecipientDetails({
  receive,
  countries,
  initialDestination,
  onReady,
}: {
  receive: string;
  countries: readonly XetralCountry[];
  initialDestination: string;
  onReady: (resolution: RecipientResolution, saved: Recipient | undefined) => void;
}) {
  const client = useXetral();
  const { busy, error, code, run } = useSubmit();

  const country = countries.find((c) => c.currency === receive);
  const [rail, setRail] = useState('');
  const [destination, setDestination] = useState(initialDestination.replace(/[^0-9]/g, ''));
  const [found, setFound] = useState<RecipientResolution | undefined>(undefined);
  const [sheet, setSheet] = useState(false);

  const banks = useLoad(
    async () => (country === undefined ? [] : client.payoutBanks(country.code)),
    [country?.code],
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
  const rails = [
    { value: 'xetral', label: 'Xetral account — instant, no fee' },
    ...(banks.data ?? []).map((bank) => ({ value: bank.code, label: bank.name })),
  ];

  const kind: RecipientKind =
    rail === 'xetral' ? 'xetral' : country?.payout_method === 'mobile_money' ? 'momo' : 'bank';

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

  const isMomoCountry = country?.payout_method === 'mobile_money';
  const pickerLabel = isMomoCountry ? 'Network' : 'Bank';
  const numberLabel = kind === 'bank' ? 'Account number' : 'Phone number';
  const railLabel = rails.find((r) => r.value === rail)?.label;

  /**
   * Ask the server who holds this destination.
   *
   * FOR MOMO THIS NEVER BLOCKS. The server's resolve path is now best-effort
   * for a wallet — it returns the name where the rail can answer and null
   * where it cannot, and never throws — so a momo send proceeds straight to
   * the amount. A bank or a Xetral account still resolves a name to confirm,
   * and a Xetral number that belongs to nobody still fails here, which is the
   * one refusal on this screen that is real.
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
          if (rail === '' || !enough) return;
          void run(async () => {
            /*
             * ONE TAP FOR MOMO, TWO FOR A NAMED RAIL. A wallet has no name to
             * confirm, so Continue resolves and proceeds in a single press —
             * the mockup's flow. A bank or Xetral account shows the resolved
             * name first, so the customer confirms who they are paying.
             */
            if (found !== undefined) {
              await proceed(found);
            } else {
              const resolution = await doResolve();
              if (kind === 'momo') await proceed(resolution);
              else setFound(resolution);
            }
            return undefined;
          });
        }}
      >
        <h1 className="sf-title">Who are you sending to?</h1>
        <p className="sf-sub">Fill in the necessary details of your recipient</p>

        <div className="sf-group">
          <span className="sf-label">Recipient country</span>
          <input className="sf-field" value={country?.name ?? receive} readOnly />
        </div>

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
            <span className="sf-select-arrow">{sheet ? '▲' : '▼'}</span>
          </div>
        </div>

        <div className="sf-group">
          <span className="sf-label">{numberLabel}</span>
          <input
            className="sf-field"
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setFound(undefined);
            }}
            onBlur={() => {
              // A named rail confirms on blur so the name is on screen before
              // the button; momo has nothing to confirm and waits for Continue.
              if (kind === 'momo' || rail === '' || !enough) return;
              void run(async () => {
                setFound(await doResolve());
                return undefined;
              });
            }}
            inputMode="numeric"
            placeholder={kind === 'bank' ? '0123456789' : 'Enter phone number'}
            autoComplete="off"
          />
        </div>

        {found?.resolved_name != null && (
          <div className="sf-group">
            <span className="sf-label">Account name</span>
            <input className="sf-field" value={found.resolved_name} readOnly />
          </div>
        )}

        <FormError error={error} code={code} />

        <button type="submit" className="sf-primary" disabled={busy || rail === '' || !enough}>
          {busy ? 'Checking…' : kind === 'momo' || found !== undefined ? 'Continue' : 'Check details'}
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
  balances,
  home,
  onSent,
}: {
  to: Recipient;
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

  const balance = balances.find((b) => b.currency === sendCurrency)?.spendable ?? '0';
  const sameCurrency = sendCurrency === to.currency;

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
      const got = await client.fxQuote(sendCurrency, to.currency, amount);
      return { forAmount: amount, ...got };
    },
    [sendCurrency, to.currency, amount, sameCurrency],
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
              to: to.currency,
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
              amount,
              currency: to.currency,
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
      <header className="send-to">
        <span className="row-icon">{initialsOf(to.display_name)}</span>
        <span className="row-main">
          <span className="row-title">{to.display_name}</span>
          <span className="row-sub">
            {to.rail_name ?? 'Xetral account'} &middot; {to.destination}
          </span>
        </span>
      </header>

      <h1>
        Send {to.currency} to {firstNameOf(to.display_name)}
      </h1>

      <div className={enough || amount === '' ? 'amount-card' : 'amount-card invalid'}>
        <span className="field-label">You send</span>
        <div className="amount-row">
          <Select
            value={sendCurrency}
            onChange={setSendCurrency}
            options={balances.map((b) => ({ value: b.currency, label: b.currency }))}
            renderMark={(value) => <CurrencyMark currency={value} size={18} />}
            compact
          />
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            aria-label="Amount to send"
          />
        </div>
        <span className="hint">
          Balance: {formatAmount(balance, sendCurrency)}
        </span>
        {amount !== '' && !enough && (
          <span className="error">Enter an amount in {sendCurrency}.</span>
        )}
      </div>

      <div className="amount-card">
        <span className="field-label">{firstNameOf(to.display_name)} receives</span>
        <div className="amount-row">
          <span className="currency-pill">
            <CurrencyMark currency={to.currency} size={18} />
            {to.currency}
          </span>
          <strong className="lands">
            {sameCurrency
              ? formatAmount(amount === '' ? '0' : amount, to.currency)
              : lands === undefined
                ? '—'
                : formatAmount(lands.receives, to.currency)}
          </strong>
        </div>
        {!sameCurrency && lands !== undefined && (
          <span className="hint">
            1 {sendCurrency} = {lands.rate} {to.currency}
          </span>
        )}
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

      <p className="arrival">
        <Icon name="zap" size={15} />
        {to.kind === 'xetral' ? 'Arrives instantly' : 'Usually arrives within minutes'}
      </p>

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
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** "Send GHS to Rabi" reads better than the whole legal name, and the whole
 *  name is on the header directly above it. */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
