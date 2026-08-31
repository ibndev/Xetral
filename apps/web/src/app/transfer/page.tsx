'use client';

import { useState } from 'react';
import { exponentFor, formatAmount, isValidAmount } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';

export default function Transfer() {
  const client = useXetral();
  const [recipient, setRecipient] = useState('');
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
   * THE CURRENCIES COME FROM THE API, not from two hardcoded options.
   *
   * This select offered NGN and USD, which was the whole of the answer even on
   * a deployment holding USDT — so a customer with a stablecoin balance could
   * see it on the home screen and had no way to send it. `/v1/wallets` now
   * returns everything the platform offers, so the list is the platform's own.
   */
  const balances = useLoad(() => client.balances(), [client]);
  const options = balances.data?.map((b) => b.currency) ?? ['NGN'];

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

  return (
    <Shell>

      <form className="card" onSubmit={submit}>
        <h1>Send money</h1>
        <h2>To another Xetral account</h2>

        <label>
          Recipient email
          <input
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required
          />
        </label>

        <label>
          Currency
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {options.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
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
