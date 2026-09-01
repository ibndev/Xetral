'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { exponentFor, formatAmount, isValidAmount, TRANSFER_CURRENCIES } from '@xetral/client';
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
   * WHO IS BEING PAID, asked first.
   *
   * A transfer used to be "type an email address", which is the identifier
   * people are most careful with and least willing to post — so the ordinary
   * case, paying somebody whose payment link you were sent, had no shape at
   * all. Both routes end at the same field because the API resolves all four
   * forms; what differs is what the screen ASKS FOR, and asking for the wrong
   * thing is what makes somebody paste an address into a box labelled link.
   */
  // A link already answered "who are you paying?", so the chooser is skipped.
  const [via, setVia] = useState<'link' | 'wallet' | undefined>(
    arrivedWith === '' ? undefined : 'link',
  );

  const amountValid = amount === '' || isValidAmount(amount, exponentFor(currency));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await client.transfer({
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

  if (via === undefined) {
    return (
      <Shell>
        <div className="card">
          <h1>Send money</h1>
          <h2>Who are you paying?</h2>

          <div className="choice-list">
            <button type="button" className="choice" onClick={() => setVia('link')}>
              <span className="choice-icon"><Icon name="globe" size={20} /></span>
              <span className="choice-main">
                <span className="choice-title">A payment link</span>
                <span className="choice-sub">
                  Somebody sent you their Xetral link or @handle
                </span>
              </span>
              <Icon name="chevronRight" size={18} />
            </button>

            <button type="button" className="choice" onClick={() => setVia('wallet')}>
              <span className="choice-icon"><Icon name="wallet" size={20} /></span>
              <span className="choice-main">
                <span className="choice-title">A Xetral wallet</span>
                <span className="choice-sub">
                  You know their email address or phone number
                </span>
              </span>
              <Icon name="chevronRight" size={18} />
            </button>
          </div>

          <p className="hint">
            Both go to the same place. Your own link is on{' '}
            <Link href="/settings">your settings page</Link> if somebody needs it.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>

      <form className="card" onSubmit={submit}>
        <div className="section-head">
          <h1>Send money</h1>
          <button type="button" className="btn link" onClick={() => setVia(undefined)}>
            Change
          </button>
        </div>
        <h2>{via === 'link' ? 'Using a payment link' : 'To a Xetral wallet'}</h2>

        <label>
          {via === 'link' ? 'Their link or @handle' : 'Their email or phone number'}
          <input
            // `text`, not `email`, on BOTH paths. The API resolves a link, an
            // @handle, an address and a phone number from one field, and a
            // browser refusing anything without an `@` in it would reject
            // three of the four.
            type="text"
            inputMode={via === 'link' ? 'url' : 'email'}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={via === 'link' ? '@olawale' : 'you@example.com'}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required
          />
        </label>

        <label id="transfer-currency-label">
          Currency
          <Select
            labelledBy="transfer-currency-label"
            value={currency}
            onChange={setCurrency}
            options={TRANSFER_CURRENCIES.map((code) => ({
              value: code,
              label: code,
              // What is actually behind the choice, so a customer picking a
              // currency they hold none of learns it here rather than from
              // `insufficient_funds` after typing an amount and a PIN.
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

        <label>
          Transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            maxLength={6}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={busy || !amountValid || amount === ''}>
          {busy ? 'Sending…' : 'Send'}
        </button>

        <FormError error={error} code={code} />
        {done !== undefined && <p className="ok">{done}</p>}
      </form>
    </Shell>
  );
}
