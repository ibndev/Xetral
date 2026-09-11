'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { exponentFor, formatAmount, isValidAmount, sendableFor } from '@xetral/client';
import { CURRENCIES } from '@xetral/shared';
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

/**
 * What a currency is CALLED, from the money registry rather than a second list.
 *
 * A picker showing bare codes asks a customer to know that GHS is the cedi.
 * The registry is where every currency this system can represent is already
 * described — a hand-written map here would be the fourth copy of the asset
 * list `crypto-networks.test.ts` exists to bind, and the one nobody updates.
 */
function nameOf(code: string): string {
  const known = (CURRENCIES as Record<string, { name?: string } | undefined>)[code];
  return known?.name ?? code;
}

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
    <section className="card send-step">
      <h1>Who do you want to send money to?</h1>

      <label className="field search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or account details"
          aria-label="Search recipients"
        />
      </label>

      {currencies.length > 0 && (
        <div className="chip-rail" role="group" aria-label="Filter by currency">
          <button
            type="button"
            className={filter === '' ? 'chip on' : 'chip'}
            onClick={() => setFilter('')}
          >
            All
          </button>
          {currencies.map((currency) => (
            <button
              key={currency}
              type="button"
              className={filter === currency ? 'chip on' : 'chip'}
              onClick={() => setFilter(currency)}
            >
              <CurrencyMark currency={currency} size={16} />
              {currency}
            </button>
          ))}
        </div>
      )}

      {recipients.length === 0 ? (
        <p className="lead">
          Nobody here yet. Add the first person you want to pay and they stay on
          this list.
        </p>
      ) : (
        <ul className="list recipient-list">
          {shown.map((r) => (
            <li key={r.id} className="list-row">
              <button type="button" className="row-open tappable" onClick={() => onPick(r)}>
                <span className="row-icon">{initialsOf(r.display_name)}</span>
                <span className="row-main">
                  <span className="row-title">{r.display_name}</span>
                  <span className="row-sub">
                    {r.rail_name ?? 'Xetral account'} &middot;&middot;&middot;
                    {r.destination.slice(-4)}
                  </span>
                </span>
                <CurrencyMark currency={r.currency} size={18} />
              </button>
              {/*
                REMOVING IS BEHIND A SECOND PRESS, not a swipe and not a
                one-tap icon. This list is tapped to SEND, so a destructive
                control beside the tap target is one thumb-width from deleting
                somebody's landlord.
              */}
              <span className="row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`More for ${r.display_name}`}
                  onClick={() => setMenu(menu === r.id ? undefined : r.id)}
                >
                  <Icon name="menu" size={18} />
                </button>
                {menu === r.id && (
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
                )}
              </span>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="hint">Nobody on this list matches that.</li>
          )}
        </ul>
      )}

      <button type="button" className="fab" onClick={onNew}>
        <Icon name="plus" size={18} />
        New recipient
      </button>
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
    nameOf(code).toLowerCase().includes(needle);

  const favourites = all.filter((c) => (c === home || c === 'USD') && matches(c));
  const stablecoins = all.filter((c) => (c === 'USDT' || c === 'USDC') && matches(c));
  const rest = all
    .filter((c) => !favourites.includes(c) && !stablecoins.includes(c) && matches(c))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  return (
    <section className="card send-step">
      <h1>What currency should your recipient receive?</h1>

      <label className="field search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search currency or country"
          aria-label="Search currencies"
        />
      </label>

      <CurrencyGroup heading="Favourites" codes={favourites} onPick={onPick} />
      <CurrencyGroup heading="Stablecoins" codes={stablecoins} onPick={onPick} />
      <CurrencyGroup heading="All currencies" codes={rest} onPick={onPick} />

      {favourites.length + stablecoins.length + rest.length === 0 && (
        <p className="hint">No currency matches that.</p>
      )}
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
    <>
      <h2 className="group-head">{heading}</h2>
      <ul className="list">
        {codes.map((code) => (
          <li key={code} className="list-row">
            <button type="button" className="row-open tappable" onClick={() => onPick(code)}>
              <span className="row-icon">
                <CurrencyMark currency={code} size={22} />
              </span>
              <span className="row-main">
                <span className="row-title">{nameOf(code)}</span>
                <span className="row-sub">{code}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
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
  const [label, setLabel] = useState('');
  const [save, setSave] = useState(true);
  const [found, setFound] = useState<RecipientResolution | undefined>(undefined);

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

  const numberLabel =
    kind === 'bank' ? 'Account number' : kind === 'momo' ? 'Mobile Money number' : 'Phone number';

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

  async function look(): Promise<void> {
    if (!enough || rail === '') return;
    await run(async () => {
      const resolution = await client.resolveRecipient({
        kind,
        /*
         * THE COUNTRY GOES EVEN ON THE XETRAL BRANCH, and leaving it off is
         * what made `08031234567` resolve to nobody. A national number has no
         * country in it; this flow already fixed one at the currency step, so
         * the server normalises through THAT country's dialling code rather
         * than guessing the sender's.
         */
        ...(country === undefined ? {} : { country: country.code }),
        ...(kind === 'xetral' ? {} : { railCode: rail }),
        destination,
      });
      setFound(resolution);
      return undefined;
    });
  }

  const nameUnavailable = found !== undefined && found.resolved_name === null;
  const ready =
    found !== undefined && (found.resolved_name !== null || label.trim().length >= 2);

  return (
    <form
      className="card send-step"
      onSubmit={(event) => {
        event.preventDefault();
        if (found === undefined) {
          void look();
          return;
        }
        void run(async () => {
          const recipient = save
            ? await client.saveRecipient({
                kind: found.kind,
                /* `found.destination` is already the international form, so
                   re-resolving needs no country — but an empty one would fail
                   the two-character schema, which is why this checks the
                   VALUE rather than the kind. */
                ...(found.country === '' ? {} : { country: found.country }),
                ...(found.rail_code === null ? {} : { railCode: found.rail_code }),
                destination: found.destination,
                ...(label.trim() === '' ? {} : { label: label.trim() }),
              })
            : undefined;
          onReady(found, recipient);
          return undefined;
        });
      }}
    >
      <h1>Who are you sending to?</h1>
      <p className="lead">Fill in the necessary details of your recipient</p>

      <div className="field">
        <span className="field-label">Recipient country</span>
        {/*
          READ-ONLY AS TEXT, not as a disabled input. A disabled box reads as a
          bug — somebody taps it, nothing happens, and the screen has given
          them no way forward. A line of text is the same restriction stated as
          a fact.
        */}
        <p className="readonly">{country?.name ?? receive}</p>
      </div>

      <label className="field">
        <span className="field-label">Network</span>
        <Select
          value={rail}
          onChange={(next) => {
            setRail(next);
            setFound(undefined);
          }}
          options={[{ value: '', label: 'Network' }, ...rails]}
          searchable={rails.length > 6}
          searchPlaceholder="Search networks…"
        />
      </label>

      <label className="field">
        <span className="field-label">{numberLabel}</span>
        <input
          value={destination}
          onChange={(e) => {
            setDestination(e.target.value);
            setFound(undefined);
          }}
          onBlur={() => void look()}
          inputMode="numeric"
          placeholder={kind === 'bank' ? '0123456789' : '0553921133'}
          autoComplete="off"
        />
      </label>

      {found?.resolved_name != null && (
        <div className="field">
          <span className="field-label">Account name</span>
          {/*
            THE RAIL'S OWN ANSWER, and the only thing on this screen presented
            as confirmation. A name the SENDER typed shown here would be a
            confirmation screen that confirms nothing while looking exactly
            like one — 043's rule, and the reason the label below is a
            separate, differently worded field.
          */}
          <p className="readonly">{found.resolved_name}</p>
        </div>
      )}

      {nameUnavailable && (
        <label className="field">
          <span className="field-label">Name this recipient</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What you want to call them"
            maxLength={140}
          />
          <span className="hint">
            This network cannot confirm the account name, so nobody has checked
            it. Give them a name you will recognise — and check the number.
          </span>
        </label>
      )}

      <label className="row toggle">
        <span>Save as beneficiary</span>
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
      </label>

      <FormError error={error} code={code} />

      <button type="submit" disabled={busy || rail === '' || !enough || (found !== undefined && !ready)}>
        {busy ? 'Checking…' : found === undefined ? 'Check details' : 'Continue'}
      </button>
    </form>
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
