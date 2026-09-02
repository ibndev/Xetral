'use client';

import { useState } from 'react';
import { formatAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import type { FxQuote } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Select } from '@/ui/select';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * What can be converted between.
 *
 * The same four a customer can send, because conversion and transfer are the
 * two ways money leaves one balance — and a currency that could be reached by
 * one and not the other is a wallet with a way in and no way out. Which PAIRS
 * are actually quotable is decided by the API from published spread policies:
 * an unpublished pair is refused rather than quoted from a default, so this
 * list is what may be ASKED and the answer is the operator's.
 */
const CURRENCIES = TRANSFER_CURRENCIES;

/**
 * Converting between currencies, and sending across them.
 *
 * One form for both, because a remittance IS a conversion with a recipient —
 * and on the server it is ONE journal entry for exactly that reason. Two
 * screens would suggest two operations, and two operations would leave a
 * window where a crash strands the money in a wallet the sender never meant to
 * hold.
 */
export default function Fx() {
  const client = useXetral();
  const [from, setFrom] = useState<string>('NGN');
  const [to, setTo] = useState<string>('USD');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [pin, setPin] = useState('');
  const [quote, setQuote] = useState<FxQuote | undefined>();
  const attempt = useIdempotencyKey();
  const { busy, error, code, done, run } = useSubmit();
  const trades = useLoad(() => client.fxTrades(), [client]);

  return (
    <Shell>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            /*
             * CONVERTING TAKES NO PIN; SENDING IT TO SOMEBODY DOES.
             *
             * A PIN is the second factor for money LEAVING the account, and
             * converting moves a customer's own money between their own
             * wallets — the balance afterwards is the same balance in another
             * denomination. Two calls rather than one with an optional
             * recipient, because the API split them for the same reason: the
             * PIN-free route's schema has no recipient field, so the path that
             * skips the PIN cannot be handed somebody to pay.
             */
            const movement = {
              from,
              to,
              amount,
              // What the customer agreed to receive. Rates move between the
              // quote and the request, and without this the difference is
              // simply absorbed by whoever is not looking — which is the
              // customer.
              ...(quote === undefined ? {} : { minReceived: quote.receives }),
              idempotencyKey: attempt.key,
            };
            const trade =
              recipient === ''
                ? await client.convert(movement)
                : await client.remit({ ...movement, recipient, pin });
            attempt.next();
            setPin('');
            setQuote(undefined);
            trades.reload();
            return `Received ${formatAmount(trade.received, trade.to)}.`;
          });
        }}
      >
        <h1>Convert</h1>
        <h2>Between your own balances, or straight to someone else</h2>

        <div className="field-row two">
          <label id="fx-from-label">
            From
            <Select
              labelledBy="fx-from-label"
              value={from}
              onChange={(value) => {
                setFrom(value);
                setQuote(undefined);
              }}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
          </label>

          <label id="fx-to-label">
            To
            <Select
              labelledBy="fx-to-label"
              value={to}
              onChange={(value) => {
                setTo(value);
                setQuote(undefined);
              }}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
          </label>
        </div>

        <label>
          Amount
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setQuote(undefined);
            }}
            required
          />
        </label>

        <div className="actions" style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="accent small"
            disabled={amount === '' || from === to}
            onClick={() =>
              void run(async () => {
                setQuote(await client.fxQuote(from, to, amount));
                return undefined;
              })
            }
          >
            Get a rate
          </button>
        </div>

        {quote !== undefined && (
          <div className="notice">
            <p>
              You send <strong className="amount">{formatAmount(quote.amount, quote.from)}</strong>{' '}
              and receive{' '}
              <strong className="amount">{formatAmount(quote.receives, quote.to)}</strong>.
            </p>
            {/*
              The spread is shown as its own line, not folded into the rate. A
              customer comparing us against a bureau de change is comparing the
              number they receive, and hiding our margin inside the rate would
              make that comparison quietly dishonest.
            */}
            <p className="hint">
              Rate {quote.rate} · our fee {formatAmount(quote.spread, quote.from)} · this rate
              holds until {new Date(quote.expires_at).toLocaleTimeString()}
            </p>
          </div>
        )}

        <label>
          Send to someone else (optional)
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Their email or phone — leave empty to convert your own balance"
          />
        </label>

        {/* ONLY WHEN IT IS GOING TO SOMEBODY. Converting your own balance is
            not a payment and asking for the PIN there teaches people to type
            it for things that are not payments. */}
        {recipient !== '' && (
          <label>
            Transaction PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
          </label>
        )}

        <button
          type="submit"
          disabled={busy || from === to || amount === '' || (recipient !== '' && pin === '')}
        >
          {busy ? 'Converting…' : recipient === '' ? 'Convert' : 'Convert and send'}
        </button>

        {from === to && <p className="hint">Pick two different currencies.</p>}
        <FormError error={error} code={code} />
        {done !== undefined && <p className="ok">{done}</p>}
      </form>

      <div className="card">
        <h2>Past conversions</h2>
        {trades.loading && <p className="spinner">Loading…</p>}
        {trades.data !== undefined && trades.data.length === 0 && (
          <p className="empty">Nothing yet.</p>
        )}
        {trades.data?.map((trade) => (
          <div className="row" key={trade.id}>
            <span>
              {new Date(trade.created_at).toLocaleDateString()}
              {trade.recipient !== null && (
                <div className="hint">to {trade.recipient}</div>
              )}
            </span>
            <span className="nowrap amount">
              {formatAmount(trade.amount, trade.from)} → {formatAmount(trade.received, trade.to)}
            </span>
          </div>
        ))}
      </div>
    </Shell>
  );
}
