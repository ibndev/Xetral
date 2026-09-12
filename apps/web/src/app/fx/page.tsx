'use client';

import { useState } from 'react';
import { formatAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import type { FxQuote } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { Toast } from '@/ui/toast';

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
  const { busy, error, code, done, run, clear } = useSubmit();
  const trades = useLoad(() => client.fxTrades(), [client]);

  return (
    <Shell>

      {/*
        EDGE TO EDGE, LIKE SEND. Convert IS a remittance with the recipient
        left off, and on the server it is the same one journal entry — so it
        reads as the same flow the customer already knows: two hero amount
        cards (what leaves, what lands), the rate stated as a line rather than
        folded into a number, and the page ground carrying it rather than a
        recessed grey box inside the page's own padding.
      */}
      <form
        className="send-step"
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
        <p className="lead">Between your own balances, or straight to someone else.</p>

        {/* WHAT LEAVES. The currency lives in the amount row as a compact
            picker, the way Send puts it, so the number and its denomination
            are one control rather than a label floating above a dropdown. */}
        <div className="amount-card">
          <span className="field-label">You convert</span>
          <div className="amount-row">
            <Select
              value={from}
              onChange={(value) => {
                setFrom(value);
                setQuote(undefined);
              }}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              renderMark={(value) => <CurrencyMark currency={value} size={18} />}
              compact
            />
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setQuote(undefined);
              }}
              placeholder="0"
              aria-label="Amount to convert"
              required
            />
          </div>
          {from === to && <span className="error">Pick two different currencies.</span>}
        </div>

        {/* WHAT LANDS. A quote fills the figure; until one is fetched it is a
            dash, because the rate is the operator's answer and not a default. */}
        <div className="amount-card">
          <span className="field-label">You receive</span>
          <div className="amount-row">
            <span className="currency-pill">
              <CurrencyMark currency={to} size={18} /> {to}
            </span>
            <strong className="lands">
              {quote === undefined ? '—' : formatAmount(quote.receives, quote.to)}
            </strong>
          </div>
          {/* The spread is its own line, never folded into the rate. A customer
              comparing us against a bureau de change compares the number they
              receive, and hiding our margin inside the rate makes that
              comparison quietly dishonest. */}
          {quote !== undefined && (
            <span className="hint">
              1 {quote.from} = {quote.rate} {quote.to} · our fee{' '}
              {formatAmount(quote.spread, quote.from)}
            </span>
          )}
        </div>

        {/* To is chosen here, beside its own card, as a plain field — the
            compact picker in the receive row would fight the landed figure for
            the same space, so the choice sits under the two cards. */}
        <label className="field" id="fx-to-field">
          <span className="field-label">Convert to</span>
          <Select
            value={to}
            onChange={(value) => {
              setTo(value);
              setQuote(undefined);
            }}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            renderMark={(value) => <CurrencyMark currency={value} size={18} />}
          />
        </label>

        <button
          type="button"
          className="quiet block"
          disabled={busy || amount === '' || from === to}
          onClick={() =>
            void run(async () => {
              setQuote(await client.fxQuote(from, to, amount));
              return undefined;
            })
          }
        >
          {quote === undefined ? 'Get today’s rate' : 'Refresh rate'}
        </button>

        {quote !== undefined && (
          <p className="arrival">
            <Icon name="zap" size={15} /> This rate holds until{' '}
            {new Date(quote.expires_at).toLocaleTimeString()}
          </p>
        )}

        <label className="field">
          <span className="field-label">Send to someone else (optional)</span>
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
          <label className="field">
            <span className="field-label">Transaction PIN</span>
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

        <FormError error={error} code={code} />
        {done !== undefined && <p className="ok">{done}</p>}

        {/*
          OVER the form as well as in it. Buying a conversion moves money, and
          the outcome has to be unmistakable on a phone where the keyboard is
          closing over the line above. The inline copy stays, so a refusal can
          still be re-read after this has gone.
        */}
        <Toast message={done} tone="ok" onDone={clear} />
        <Toast message={error} tone="bad" onDone={clear} />
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
