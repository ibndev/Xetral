'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { exponentFor, formatAmount, isValidAmount } from '@xetral/client';
import { xetral } from '@/lib/session';
import { messageFor } from '@/lib/errors';
import { Nav } from '@/lib/nav';

export default function Transfer() {
  const router = useRouter();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const signedOut = useCallback(() => router.push('/signin'), [router]);

  /**
   * One key per attempt at THIS transfer, generated when the form is first
   * rendered and reused across retries.
   *
   * That is the whole point: a customer who taps Send twice, or whose
   * connection drops mid-request, must not send twice. Generating it inside
   * the submit handler would defeat it entirely.
   */
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const amountValid = amount === '' || isValidAmount(amount, exponentFor(currency));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);

    try {
      const { client } = xetral(signedOut);
      const result = await client.transfer({
        recipient,
        amount,
        currency,
        pin,
        idempotencyKey,
      });
      setDone(
        `Sent ${formatAmount(result.amount, result.currency)}${
          result.fee === '0.00' ? '' : ` (fee ${formatAmount(result.fee, result.currency)})`
        }.`,
      );
      // The PIN is cleared immediately and never kept in state between
      // actions. It is not a password: it authorises one instruction.
      setPin('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <Nav />

      <form className="panel" onSubmit={submit}>
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
            <option value="NGN">NGN</option>
            <option value="USD">USD</option>
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

        {error !== undefined && <p className="error">{error}</p>}
        {done !== undefined && <p className="ok">{done}</p>}
      </form>
    </main>
  );
}
