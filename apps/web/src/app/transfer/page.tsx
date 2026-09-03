'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { exponentFor, formatAmount, isValidAmount, sendableFor } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';

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
  const { busy, error, code, done, run } = useSubmit();

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

  const amountValid = amount === '' || isValidAmount(amount, exponentFor(currency));

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
                currency,
                pin,
                idempotencyKey: attempt.key,
              })
              // One shape for the success line below. A payout answers with
              // its own view, and mapping it here keeps the two branches from
              // each growing their own copy of the wording.
              .then((p) => ({ amount: p.amount, fee: p.fee, currency: p.currency }))
          : await client.transfer({
              recipient,
              amount,
              currency,
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
            <div className="row">
              <span className="muted">To</span>
              <span className="mono">{recipient}</span>
            </div>
          )}
          <div className="row">
            <span className="muted">Amount</span>
            <span className="mono">{formatAmount(amount || '0', currency)}</span>
          </div>

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
            {busy ? 'Sending…' : `Send ${formatAmount(amount || '0', currency)}`}
          </button>

          <FormError error={error} code={code} />
          {done !== undefined && <p className="ok">{done}</p>}
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="card" onSubmit={review}>
        <h1>Send money</h1>
        <h2>{mobileMoney ? 'To a Xetral account or a mobile money wallet' : 'To a Xetral account or a bank account'}</h2>

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
              {mobileMoney ? 'Mobile money' : 'Bank account'}
            </button>
          </div>
        )}

        {destination === 'bank' ? (
          <>
            <label id="transfer-bank-label">
              {mobileMoney ? 'Mobile money provider' : 'Bank'}
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
              {mobileMoney ? 'Wallet number' : 'Account number'}
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
                <span className="hint ok">{beneficiary}</span>
              )}
              {lookupFailed && (
                <span className="hint">
                  We could not find that account. Check the number and the bank.
                </span>
              )}
            </label>
          </>
        ) : (
        <label>
          Who are you paying?
          <input
            // `text`, never `email`. ONE FIELD TAKES ALL FOUR SHAPES — a
            // handle, an email address, a phone number and a whole payment
            // link — because the API resolves all four from one string. A
            // browser refusing anything without an `@` would reject three.
            type="text"
            inputMode="text"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="@handle, email, phone or payment link"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required
          />
          <span className="hint">
            Your own link is on <Link href="/settings">your settings page</Link>.
          </span>
        </label>
        )}

        <label id="transfer-currency-label">
          Currency
          <Select
            labelledBy="transfer-currency-label"
            value={currency}
            onChange={setCurrency}
            options={offered.map((code) => ({
              value: code,
              label: code,
              // What is actually behind the choice, so a customer picking a
              // currency they hold none of learns it here rather than from
              // `insufficient_funds` after typing an amount.
              ...(held.has(code) ? { hint: formatAmount(held.get(code) ?? '0', code) } : {}),
            }))}
          />
        </label>

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
        </label>
        {!amountValid && (
          // Caught by the form rather than by a 400 from a money-moving
          // endpoint — and the check counts decimals per currency, so USDT
          // gets six and naira gets two.
          <p className="error">
            Enter an amount with at most {exponentFor(currency)} decimal places.
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
              : recipient === '')
          }
        >
          Review
        </button>

        <FormError error={error} code={code} />
        {done !== undefined && <p className="ok">{done}</p>}
      </form>
    </Shell>
  );
}
