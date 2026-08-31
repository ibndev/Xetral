'use client';

import { useState } from 'react';
import { exponentFor, formatAmount, isValidAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Select } from '@/ui/select';
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
