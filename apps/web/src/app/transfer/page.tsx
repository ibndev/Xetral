'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { e164, exponentFor, formatAmount, isValidAmount, sendableFor } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { CountryMark } from '@/ui/currency-mark';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { Toast } from '@/ui/toast';

/** Zero, written the way this currency writes it — "0.00" for naira,
 *  "0.000000" for USDT. The API sends major units, so the string differs. */
const isZero = (amount: string): boolean => /^-?0(\.0+)?$/.test(amount);


/**
 * `useSearchParams` suspends, so the screen it is read on must sit inside a
 * boundary or the whole route opts out of static rendering with a build error
 * naming neither this file nor the hook.
 */
export default function TransferPage() {
  return (
    <Suspense fallback={null}>
      <Transfer />
    </Suspense>
  );
}

function Transfer() {
  const client = useXetral();
  const params = useSearchParams();

  /*
   * ARRIVED FROM A PAYMENT LINK.
   *
   * `/pay/<handle>` redirects here with the handle in `to`, so somebody who
   * followed a link does not retype what the link already said. It is the
   * INITIAL value of ordinary state rather than a controlled one, because the
   * customer must be able to correct it — a recipient the page keeps putting
   * back is a recipient they cannot change.
   */
  const arrivedWith = params.get('to') ?? '';
  const [recipient, setRecipient] = useState(arrivedWith);

  /*
   * WHERE THE MONEY IS GOING, and this is the half the screen was missing.
   *
   * Sending has only ever meant sending to another Xetral customer, which is
   * the smaller half of what this product is for: money arrives through a
   * dedicated account number and the only ways out were a card, a bill or
   * crypto. A customer could not pay their landlord.
   *
   * Two destinations on ONE screen rather than two screens, because the
   * question a customer is answering is the same one — who am I paying — and
   * the shape of the answer is the only thing that differs. It also keeps the
   * amount, the currency and the PIN step in one place rather than in two
   * copies that drift.
   *
   * Arriving from a payment link pins it to `xetral`: a link names a Xetral
   * customer and nothing else, so offering a bank tab to somebody who
   * followed one is offering a wrong turn.
   */
  const [destination, setDestination] = useState<'xetral' | 'bank'>('xetral');
  /*
   * THE RECIPIENT'S DIALLING CODE IS THE RECIPIENT'S COUNTRY.
   *
   * A Xetral-to-Xetral payment is now addressed by phone number, and the
   * picker in front of the field does two jobs at once: it builds the E.164
   * string the server stores, so a sender can type the number the way they
   * have it saved; and it says WHERE THE MONEY IS GOING without any lookup at
   * all. That second part matters — asking the server "which country is this
   * number in?" would be an endpoint that says which numbers belong to
   * customers, one request at a time.
   */
  const [recipientDial, setRecipientDial] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [pin, setPin] = useState('');

  /*
   * ON THE SHARED HOOKS, which is what gives this screen the error CODE.
   *
   * It kept its own busy/error/done state and only ever saw the sentence, so
   * a customer with no transaction PIN was told to set one with no way to get
   * there — on the screen where that refusal is most likely to happen. The
   * hooks carry the code alongside the message, which is what `FormError`
   * needs to offer the next step.
   */
  const { busy, error, code, done, run, clear } = useSubmit();

  /**
   * One key per attempt at THIS transfer, generated when the form is first
   * rendered and reused across retries.
   *
   * That is the whole point: a customer who taps Send twice, or whose
   * connection drops mid-request, must not send twice. Generating it inside
   * the submit handler would defeat it entirely.
   */
  const attempt = useIdempotencyKey();

  /*
   * WHAT MAY BE SENT, NOT WHAT IS HELD.
   *
   * This list came from `/v1/wallets` — the customer's own balances — which
   * reads as sensible and is the wrong question twice over. A customer holding
   * only naira was offered exactly one option, so the picker looked broken;
   * and anything that happened to appear as a balance became a transfer option
   * nothing had decided to offer.
   *
   * `TRANSFER_CURRENCIES` is the decision, shared with the phone app and
   * checked against the API's own enum by `wallet-currencies.test.ts`. Gift
   * cards are deliberately not in it: selling one is an offer we review, not
   * money sent to somebody.
   *
   * Balances are still loaded, to show what is behind each choice.
   */
  const balances = useLoad(() => client.balances(), [client]);
  const held = new Map((balances.data ?? []).map((b) => [b.currency, b.spendable]));

  /*
   * THE PIN IS ASKED ABOUT BEFORE THE FORM, NOT AFTER IT.
   *
   * Every money-moving route verifies a transaction PIN, and a customer who
   * has never set one could only find that out by filling in a recipient, an
   * amount and a PIN box — and being told the PIN box was never going to
   * work. `has_pin` is on the session for exactly this, so the refusal
   * arrives as a step to take rather than as an error at the end.
   */
  const session = useLoad(() => client.currentSession(), [client]);


  /*
   * ANOTHER COUNTRY'S LOCAL CURRENCY IS NOISE IN THIS PICKER.
   *
   * `TRANSFER_CURRENCIES` is what the API ACCEPTS and now includes cedis and
   * shillings, because a Ghanaian must be able to send them. Showing all of
   * them to everybody would give a Nigerian two options that answer
   * `insufficient_funds` and nothing on the screen saying which. So the local
   * ones are filtered to their own, plus any they are actually holding —
   * money can arrive in a currency somebody cannot normally send from, and
   * once it is theirs they must be able to move it.
   */
  const offered = sendableFor(session.data?.home_currency, [...held.keys()]);

  /*
   * Bank payouts are a per-country rail, so the country comes from the
   * customer rather than from a picker. `FALLBACK_HOME_CURRENCY`'s lesson,
   * applied to a country: an account opened before 040 has none, and Nigeria
   * is the only corridor this platform has opened.
   */
  const homeCountry = session.data?.country ?? 'NG';

  /*
   * HOW MONEY LEAVES WHERE THIS CUSTOMER IS — data, not a `switch`.
   *
   * The bank tab offered a Nigerian bank list to everybody. In Ghana and
   * Kenya money moves to a mobile money wallet on a phone number, not to a
   * ten-digit NUBAN, so a customer in Accra was being offered a product their
   * money cannot reach. 046 puts the answer on the country row, which is
   * where 040 says a fact about a country belongs.
   *
   * Falls back to 'bank' while the list loads and on an API that predates
   * 046 — the conservative answer, and the one Nigeria needs.
   */
  const countries = useLoad(() => client.session.countries(), [client]);
  const payoutMethod =
    countries.data?.find((c) => c.code === homeCountry)?.payout_method ?? 'bank';
  const mobileMoney = payoutMethod === 'mobile_money';
  /*
   * The bank list, loaded only when it is needed.
   *
   * It is a provider call behind our API, so a customer who never opens the
   * bank tab never pays for it — and on a deployment with no Bitnob address
   * the list simply fails to load and the tab says so, rather than the whole
   * Send screen failing to render.
   */
  const banks = useLoad(
    async () => (destination === 'bank' ? client.payoutBanks(homeCountry) : []),
    [client, destination, homeCountry],
  );

  /*
   * WHERE THE MONEY IS GOING, from the dialling code and nothing else.
   *
   * No lookup, deliberately. An endpoint answering "which country is this
   * number in?" would answer differently for a number that belongs to a
   * customer and one that does not, which is a way to enumerate the customer
   * base one request at a time — the rule 039 already applies to handles. The
   * dial code IS the country, it is a fact about the number rather than about
   * the person, and it is true before the recipient has even signed up.
   */
  const recipientCountry = countries.data?.find((c) => c.dial_code === recipientDial);
  const recipientCurrency = recipientCountry?.currency;
  const homeCurrency = session.data?.home_currency ?? 'NGN';

  /*
   * A LOCAL PAYOUT IS IN THE LOCAL CURRENCY, AND THERE IS NO PICKER.
   *
   * Money leaving to a Nigerian bank is naira, to a Ghanaian wallet is cedis,
   * to a Kenyan one is shillings — that is what the rail is. Offering a
   * currency box there was offering a choice the provider cannot honour: the
   * only outcomes were the customer picking their own currency anyway, or
   * picking another one and being refused after typing a PIN.
   *
   * International is the Xetral-to-Xetral side, which keeps its picker.
   */
  const sendCurrency = destination === 'bank' ? homeCurrency : currency;

  /*
   * WHAT THE RECIPIENT ACTUALLY RECEIVES, quoted by the server.
   *
   * Only when the two currencies differ — a same-currency transfer converts
   * nothing and a rate line under it would be noise. The rate comes from
   * `fx_spread_policies` through `/v1/fx/quote`, so what the customer reads
   * here is the rate they will get rather than a number this screen worked
   * out: an unpublished pair is REFUSED rather than quoted from a default,
   * and the refusal must show up before the PIN rather than after it.
   */
  /*
   * WHO IS BEING PAID, as one string for the API.
   *
   * A customer who followed a payment LINK arrives with the recipient already
   * named — a handle, resolved server-side — and must not be asked to type a
   * phone number they do not have. Everybody else is paying by number, and
   * `e164()` builds the one canonical form from the picker and the digits.
   *
   * The link case keeps working for the reason 039 gives: a link is how
   * somebody OUTSIDE Xetral pays a customer, and it resolves to the same
   * person their number does.
   */
  const payee = arrivedWith !== '' ? recipient : e164(recipientDial, recipientPhone);

  const converting =
    destination === 'xetral' &&
    recipientCurrency !== undefined &&
    recipientCurrency !== sendCurrency;

  const quote = useLoad(async () => {
    if (!converting || recipientCurrency === undefined) return undefined;
    // A rate is quoted against an amount, so an empty box asks for one unit —
    // enough to render the rate line before the customer has typed anything.
    const forAmount = amount === '' || !isValidAmount(amount, exponentFor(sendCurrency))
      ? '1'
      : amount;
    return client.fxQuote(sendCurrency, recipientCurrency, forAmount).catch(() => undefined);
  }, [client, converting, recipientCurrency, sendCurrency, amount]);
  /*
   * ONLY WHEN WE KNOW. `has_pin` is `boolean | null` and null means the server
   * could not tell — which must NOT route somebody into creating a PIN they
   * already have. That is exactly what happened when a failed query answered
   * `false`: a customer who had set one was sent back to set it again.
   *
   * Unknown falls through to the ordinary form, where the server's own
   * `pin_not_set` refusal decides — and that refusal already carries a link to
   * the right screen, so the worst case is one extra step rather than a loop.
   */
  const needsPin = session.data?.has_pin === false;

  /*
   * ONE FIELD, NOT A CHOICE BETWEEN TWO SCREENS.
   *
   * This asked "a payment link, or a Xetral wallet?" first, and both answers
   * led to THE SAME INPUT — because `#recipientByIdentifier` resolves a
   * handle, an email, a phone number and a whole payment link from one
   * string. The question was a step that changed nothing but the label, and
   * getting it wrong meant pasting an address into a box that said link.
   *
   * It was also what broke the layout. `.choice` was a <button> holding a
   * sentence, and the global button rule sets `white-space: nowrap` — so the
   * sub-line could not wrap and forced the page 41px wider than a 360px
   * handset, which is the sideways scroll on this screen. Measured before and
   * after; one field cannot do that.
   */
  const [stage, setStage] = useState<'details' | 'confirm'>('details');

  /*
   * THE NAME THE BANK HOLDS, fetched before the customer confirms.
   *
   * This is the one control a bank payout has that a Xetral transfer does
   * not need: an account number that passes every format check can still
   * belong to a stranger, and the only claim about the beneficiary that does
   * not come from the sender is the bank's own.
   *
   * It is shown, and it is NOT sent. The server looks it up again for itself
   * — anything this page can send is something a stolen session can send, so
   * a name from here would make the confirmation a formality. What is shown
   * here is for the customer to read.
   */
  const [beneficiary, setBeneficiary] = useState<string | undefined>(undefined);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);

  async function lookUp(code: string, number: string): Promise<void> {
    // Ten digits is a NUBAN, which is the point at which asking is useful
    // rather than noise on every keystroke.
    if (code === '' || number.length < 10) {
      setBeneficiary(undefined);
      setLookupFailed(false);
      return;
    }
    setLookingUp(true);
    setLookupFailed(false);
    try {
      const found = await client.lookupBankAccount({
        country: homeCountry,
        bankCode: code,
        accountNumber: number,
      });
      setBeneficiary(found.account_name);
    } catch {
      // Deliberately not distinguishing "no such account" from "the bank did
      // not answer": a lookup that told them apart would let somebody map
      // which numbers are live at which bank, one request at a time.
      setBeneficiary(undefined);
      setLookupFailed(true);
    } finally {
      setLookingUp(false);
    }
  }

  // Against the currency actually being SENT. On the payout side there is no
  // picker and the rail decides, so checking the picked one would count
  // decimals for a currency this transfer is not in.
  const amountValid = amount === '' || isValidAmount(amount, exponentFor(sendCurrency));

  /*
   * THE PIN IS NOT PART OF THE FORM.
   *
   * It used to sit under the amount, so a customer typed the secret that
   * authorises the payment BEFORE they had seen what they were authorising —
   * and a mistyped recipient was discovered after the PIN, or not at all. A
   * PIN answers "yes, this one", which is a question that cannot be asked
   * before the thing exists.
   *
   * So: details, then a review of what is about to happen, then the PIN. The
   * PIN never enters this component's state until that last step and is
   * cleared the moment the request returns.
   */
  function review(event: React.FormEvent) {
    event.preventDefault();
    // A bank payout cannot be reviewed without a name to review. Advancing
    // with an unresolved account would put a confirmation screen in front of
    // a customer that confirms nothing — which is worse than no screen,
    // because they will read it as having been checked.
    if (destination === 'bank' && beneficiary === undefined) return;
    setStage('confirm');
  }

  function confirm(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result =
        destination === 'bank'
          ? await client
              .payToBank({
                country: homeCountry,
                bankCode,
                accountNumber,
                amount,
                // THE LOCAL CURRENCY, not a picked one. There is no picker on
                // this side and the rail decides — see the row that replaced
                // it.
                currency: homeCurrency,
                pin,
                idempotencyKey: attempt.key,
              })
              // One shape for the success line below. A payout answers with
              // its own view, and mapping it here keeps the two branches from
              // each growing their own copy of the wording.
              .then((p) => ({ amount: p.amount, fee: p.fee, currency: p.currency }))
          : converting && recipientCurrency !== undefined
            ? /*
               * ACROSS CURRENCIES IS A REMITTANCE, NOT A TRANSFER.
               *
               * `remit` is ONE journal entry that converts and delivers — the
               * shape Phase 10 chose deliberately, because convert-then-send
               * leaves a window where a crash strands the money in a wallet
               * the sender never meant to hold. Calling `transfer` here
               * instead would have moved naira into a Ghanaian's naira
               * wallet, which is money they cannot spend where they live.
               */
              await client
                .remit({
                  from: sendCurrency,
                  to: recipientCurrency,
                  amount,
                  recipient: payee,
                  pin,
                  idempotencyKey: attempt.key,
                })
                .then((t) => ({ amount: t.amount, fee: '0.00', currency: t.from }))
            : await client.transfer({
                recipient: payee,
                amount,
                currency: sendCurrency,
                pin,
                idempotencyKey: attempt.key,
              });
      // The attempt is over, so the next Send is a new transfer and needs a
      // new key — reusing this one would have the server replay this transfer
      // and report success for money that never moved.
      attempt.next();
      // The PIN is cleared immediately and never kept in state between
      // actions. It is not a password: it authorises one instruction.
      setPin('');
      // Back to an empty form: a success is the end of this transfer, and
      // leaving the review on screen invites a second tap on money that has
      // already moved.
      setStage('details');
      setAmount('');
      setRecipient('');
      setRecipientPhone('');
      setAccountNumber('');
      setBeneficiary(undefined);
      return `Sent ${formatAmount(result.amount, result.currency)}${
        result.fee === '0.00' ? '' : ` (fee ${formatAmount(result.fee, result.currency)})`
      }.`;
    });
  }

  if (session.loading) {
    return (
      <Shell>
        <div className="card"><p className="spinner">Loading…</p></div>
      </Shell>
    );
  }

  if (needsPin) {
    return (
      <Shell>
        <div className="card">
          <h1>First, a transaction PIN</h1>
          <h2>It authorises every payment you make</h2>
          <p className="lead">
            A separate PIN approves money leaving your account. You set it once.
          </p>
          <Link className="btn" href="/settings#transaction-pin">
            Set my transaction PIN
          </Link>
        </div>
      </Shell>
    );
  }

  if (stage === 'confirm') {
    return (
      <Shell>
        <form className="card" onSubmit={confirm}>
          <div className="section-head">
            <h1>Confirm</h1>
            <button
              type="button"
              className="btn link"
              onClick={() => {
                setPin('');
                setStage('details');
              }}
            >
              Edit
            </button>
          </div>
          <h2>Check this before you approve it</h2>

          {/* What is about to happen.
              For a XETRAL transfer the recipient is echoed exactly as typed
              rather than resolved to a name: resolving would be a lookup that
              says which handles and addresses exist, and this screen is
              reachable by anybody.
              For a BANK payout it is the opposite, and deliberately — the
              name comes from the bank, the sender did not author it, and
              showing it is the only thing standing between a transposed digit
              and money that cannot be recalled. */}
          {destination === 'bank' ? (
            <>
              <div className="row">
                <span className="muted">To</span>
                <span>{beneficiary}</span>
              </div>
              <div className="row">
                <span className="muted">Account</span>
                <span className="mono">
                  {accountNumber} · {banks.data?.find((b) => b.code === bankCode)?.name ?? ''}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="row">
                <span className="muted">To</span>
                <span className="mono">{payee}</span>
              </div>
              {recipientCountry !== undefined && (
                <div className="row">
                  <span className="muted">In</span>
                  <span>{recipientCountry.name}</span>
                </div>
              )}
            </>
          )}
          <div className="row">
            <span className="muted">Amount</span>
            <span className="mono">{formatAmount(amount || '0', sendCurrency)}</span>
          </div>
          {/*
            THE LAST PLACE THE CONVERSION CAN BE CHECKED.

            The rate and the figure are both on the form, and a customer who
            scrolled past them on a handset should not approve a PIN without
            seeing what the person at the other end gets. Nothing here is a
            new claim — it is the same quote, repeated where the decision is
            actually made.
          */}
          {converting && quote.data !== undefined && (
            <div className="row">
              <span className="muted">They receive</span>
              <span className="mono">
                {formatAmount(quote.data.receives, recipientCurrency ?? sendCurrency)}
              </span>
            </div>
          )}

          <label>
            Transaction PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              maxLength={6}
              onChange={(e) => setPin(e.target.value)}
              // Focused here rather than on the details form, because this is
              // the first moment the PIN is the thing being asked for.
              autoFocus
              required
            />
          </label>

          <button type="submit" disabled={busy || pin === ''}>
            {busy ? 'Sending…' : `Send ${formatAmount(amount || '0', sendCurrency)}`}
          </button>

          <FormError error={error} code={code} />
          {done !== undefined && <p className="ok">{done}</p>}

          {/*
            OVER the form as well as in it. The form resets itself on a
            success and the keyboard is closing at the same moment, so the
            line above is easy to miss on a handset — and "did my ₦50,000 go?"
            is the one question this product must never leave open. The inline
            copy stays, so a refusal can still be re-read after this has gone.
          */}
          <Toast message={done} tone="ok" onDone={clear} />
          <Toast message={error} tone="bad" onDone={clear} />
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="card" onSubmit={review}>
        <h1>Send money</h1>
        <h2>{mobileMoney ? 'To a Xetral account or a Momo account' : 'To a Xetral account or a bank account'}</h2>

        {/* Two destinations, one screen. Deliberately NOT the `.choice`
            pattern that broke this page's layout once: the global button rule
            sets `white-space: nowrap`, so a button holding a sentence forced
            the page 41px wider than a 360px handset. These hold one word. */}
        {arrivedWith === '' && (
          <div className="segmented" role="group" aria-label="Where the money is going">
            <button
              type="button"
              className={destination === 'xetral' ? 'active' : ''}
              onClick={() => setDestination('xetral')}
            >
              Xetral
            </button>
            <button
              type="button"
              className={destination === 'bank' ? 'active' : ''}
              onClick={() => setDestination('bank')}
            >
              {mobileMoney ? 'Momo account' : 'Bank account'}
            </button>
          </div>
        )}

        {destination === 'bank' ? (
          <>
            <label id="transfer-bank-label">
              {mobileMoney ? 'Momo provider' : 'Bank'}
              <Select
                labelledBy="transfer-bank-label"
                /* PASTE-OR-TYPE, because the list is long. Paystack returns
                   upwards of a hundred Nigerian banks; scrolling one
                   alphabetically to reach Kuda is the customer doing the
                   computer's work. */
                searchable
                searchPlaceholder={
                  mobileMoney ? 'Search providers…' : 'Search banks…'
                }
                value={bankCode}
                onChange={(code) => {
                  setBankCode(code);
                  void lookUp(code, accountNumber);
                }}
                options={(banks.data ?? []).map((bank) => ({
                  value: bank.code,
                  label: bank.name,
                }))}
              />
            </label>

            <label>
              {mobileMoney ? 'Momo number' : 'Account number'}
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder={mobileMoney ? '0244123456' : '0123456789'}
                value={accountNumber}
                maxLength={20}
                onChange={(e) => {
                  // Digits only, so a pasted number carrying spaces or
                  // dashes does not fail a lookup that would have worked.
                  const digits = e.target.value.replace(/[^0-9]/g, '');
                  setAccountNumber(digits);
                  void lookUp(bankCode, digits);
                }}
                required
              />
              {/* THE ONLY THING ON THIS SCREEN THE SENDER DID NOT WRITE. */}
              {lookingUp && <span className="hint">Checking the name…</span>}
              {beneficiary !== undefined && (
                <span className="beneficiary">{beneficiary}</span>
              )}
              {lookupFailed && (
                <span className="hint">
                  We could not find that account. Check the number and the bank.
                </span>
              )}
            </label>
          </>
        ) : (
        arrivedWith !== '' ? (
          /*
            ARRIVED FROM A PAYMENT LINK, so the recipient is already named and
            must not be asked for again. A link names one Xetral customer —
            that is what 039 built it for, and it is how somebody OUTSIDE
            Xetral is given a way to pay one — so showing a phone picker here
            would ask a sender for a number they were never given.
          */
          <div className="row">
            <span className="muted">Paying</span>
            <span className="mono">{recipient}</span>
          </div>
        ) : (
        <>
          {/*
            THE PHONE NUMBER IS THE IDENTIFIER, and the picker in front of it
            is doing two jobs.

            It builds the E.164 string the server stores, so a customer can
            type the number the way they have it saved — with the leading zero
            every Nigerian writes — instead of being told there is no such
            customer because a plus was missing. And it says which COUNTRY the
            money is going to, which is what the rate line below reads. The
            second job is why it is a picker rather than a free-text field: a
            number pasted whole would have to be parsed, and the parse would
            be a guess about somebody else's country.

            The list says "Ghana" and the trigger says "+233", the same
            arrangement the signup form uses and for the same reason: a
            country's name in front of a phone number pushes the digits off a
            handset.
          */}
          <div className="field">
            <label htmlFor="recipient-phone" id="recipient-country-label">
              Recipient&apos;s phone number
            </label>
            <div className="input-affix dial">
              <div className="dial-select">
                <Select
                  compact
                  labelledBy="recipient-country-label"
                  value={recipientDial}
                  onChange={setRecipientDial}
                  placeholder="+—"
                  renderMark={(dial) => (
                    <CountryMark
                      country={countries.data?.find((c) => c.dial_code === dial)?.code ?? ''}
                      size={18}
                    />
                  )}
                  renderTrigger={(dial) => <span className="dial-digits">+{dial}</span>}
                  options={(countries.data ?? []).map((c) => ({
                    value: c.dial_code,
                    label: c.name,
                    hint: c.currency,
                  }))}
                />
              </div>
              <input
                id="recipient-phone"
                type="tel"
                inputMode="numeric"
                placeholder="8031234567"
                value={recipientPhone}
                autoComplete="off"
                onChange={(e) => setRecipientPhone(e.target.value.replace(/[^0-9]/g, ''))}
                required
              />
            </div>
            <p className="hint">
              {recipientCountry === undefined
                ? 'Choose the country their number is in.'
                : `Going to ${recipientCountry.name} — they receive ${recipientCountry.currency}.`}
            </p>
          </div>
        </>
        )
        )}

        {/*
          A CURRENCY PICKER ON THE XETRAL SIDE AND NONE ON THE PAYOUT SIDE.

          A local payout IS its currency: money to a Nigerian bank is naira,
          to a Ghanaian wallet is cedis, to a Kenyan one is shillings. A box
          offering anything else offered a choice the rail cannot honour, and
          the only outcomes were picking your own currency anyway or being
          refused after typing a PIN. Xetral-to-Xetral is the international
          half of this product and keeps the choice.
        */}
        {destination === 'bank' ? (
          <div className="row">
            <span className="muted">Currency</span>
            <span>
              <span className="mono">{homeCurrency}</span>{' '}
              <span className="muted">
                · {mobileMoney ? 'mobile money' : 'bank'} transfers are local
              </span>
            </span>
          </div>
        ) : (
        <label id="transfer-currency-label">
          Currency
          <Select
            labelledBy="transfer-currency-label"
            value={currency}
            onChange={setCurrency}
            options={offered.map((code) => ({
              value: code,
              label: code,
              // ALWAYS a figure, including a zero. Omitting the hint for a
              // currency with no balance made "you have none of this" look
              // identical to "we did not say" — and now that every currency
              // is offered rather than filtered, that difference is the whole
              // information the picker carries.
              hint: formatAmount(held.get(code) ?? '0', code),
            }))}
          />
          {/*
            THE RATE, UNDER THE BOX THAT DECIDES IT, BEFORE ANY AMOUNT.

            A customer sending naira to Ghana is making two decisions at once
            — what to send and what it becomes — and the second was invisible
            until after the money had moved. `/v1/fx/quote` is the same
            published policy the conversion itself will use, so this is the
            rate they will get rather than one this screen worked out. An
            unpublished pair is REFUSED rather than quoted from a default, and
            saying so here is far better than saying so after the PIN.
          */}
          {converting && (
            <span className="hint">
              {quote.loading
                ? 'Getting today\u2019s rate…'
                : quote.data === undefined
                  ? `We cannot convert ${sendCurrency} to ${recipientCurrency ?? ''} yet.`
                  : `1 ${sendCurrency} = ${quote.data.rate} ${recipientCurrency ?? ''} today.`}
            </span>
          )}
        </label>
        )}

        {/*
          THE WAY OUT, on the screen where the dead end is.
          
          Sending cedis from a naira balance is the ordinary cross-border
          case, and it needs a conversion first. Without this line the
          customer picks GHS, types an amount, proves a PIN and is told
          `insufficient_funds` — a refusal that is true and says nothing
          about what to do.
        */}
        {isZero(held.get(sendCurrency) ?? '0') && (
          <p className="hint">
            You have no {sendCurrency}.{' '}
            <Link href="/fx">Convert some first</Link>, then come back.
          </p>
        )}

        <label>
          Amount
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
            required
          />
          {/*
            WHAT THEY WILL ACTUALLY GET, under the box that decides it.

            The rate line above answers "what is a naira worth today"; this
            answers the question the sender is really asking, which is whether
            the person at the other end receives enough. Both are needed: a
            rate with no figure makes the customer do arithmetic on a phone,
            and a figure with no rate cannot be checked against anything.

            Quoted for the amount typed, so it moves as they type.
          */}
          {converting && amount !== '' && amountValid && (
            <span className="hint">
              {quote.loading
                ? 'Working out what they receive…'
                : quote.data === undefined
                  ? 'We cannot say what they would receive yet.'
                  : `They receive about ${formatAmount(
                      quote.data.receives,
                      recipientCurrency ?? sendCurrency,
                    )}.`}
            </span>
          )}
        </label>
        {!amountValid && (
          // Caught by the form rather than by a 400 from a money-moving
          // endpoint — and the check counts decimals per currency, so USDT
          // gets six and naira gets two.
          <p className="error">
            Enter an amount with at most {exponentFor(sendCurrency)} decimal places.
          </p>
        )}

        {/* NO TRANSACTION PIN HERE. It is asked on the confirm step, once the
            customer can see what they are approving. */}
        <button
          type="submit"
          disabled={
            !amountValid ||
            amount === '' ||
            (destination === 'bank'
              ? // A payout cannot be reviewed without a name to review.
                beneficiary === undefined
              : // A phone number that `e164()` could not build from — no
                // country picked, or no digits — is not somebody to pay, and
                // advancing would put a review screen in front of a customer
                // naming nobody.
                payee === '')
          }
        >
          Review
        </button>

        <FormError error={error} code={code} />
        {done !== undefined && <p className="ok">{done}</p>}

        <Toast message={done} tone="ok" onDone={clear} />
        <Toast message={error} tone="bad" onDone={clear} />
      </form>
    </Shell>
  );
}
