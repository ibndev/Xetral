'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { convertPreset, formatAmount, groupTyped, TRANSFER_CURRENCIES } from '@xetral/client';
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
  // `useSearchParams` needs a boundary, or Next refuses to prerender the page.
  return (
    <Suspense fallback={null}>
      <Convert />
    </Suspense>
  );
}

function Convert() {
  const client = useXetral();
  const params = useSearchParams();
  const [from, setFrom] = useState<string>(() => convertPreset(params?.get('from'), params?.get('to')).from);
  const [to, setTo] = useState<string>(() => convertPreset(params?.get('from'), params?.get('to')).to);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<FxQuote | undefined>();
  const attempt = useIdempotencyKey();
  const { busy, error, code, done, run, clear } = useSubmit();
  const trades = useLoad(() => client.fxTrades(), [client]);
  /* The two balances the panels report. SPENDABLE, not total: pending money
     cannot be converted and offering it would produce a refusal the customer
     could not have predicted from the figure on screen. */
  const balances = useLoad(() => client.balances(), [client]);
  const fromBalance = balances.data?.find((b) => b.currency === from);
  const toBalance = balances.data?.find((b) => b.currency === to);

  return (
    <Shell back="/wallet" title="Convert">

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
             * ONE BUTTON, TWO STEPS — quote, then convert, and the quote is
             * what the second press is against. A rate moves between the two,
             * so `minReceived` carries what the customer was shown: without it
             * the difference is absorbed by whoever is not looking, which is
             * the customer.
             */
            if (quote === undefined) {
              setQuote(await client.fxQuote(from, to, amount));
              return undefined;
            }
            /*
             * CONVERTING TAKES NO PIN.
             *
             * A PIN is the second factor for money LEAVING the account, and
             * converting moves a customer's own money between their own
             * wallets — the balance afterwards is the same balance in another
             * denomination. Sending it to somebody IS a payment, and that is
             * the Send screen: since Phase 19 it derives the rail from the
             * recipient and the currency, so a converting transfer already
             * routes to the same one journal entry this endpoint posts. An
             * optional recipient here was a second, quieter way into it —
             * with its own PIN field, on a screen headed Convert.
             */
            const trade = await client.convert({
              from,
              to,
              amount,
              minReceived: quote.receives,
              idempotencyKey: attempt.key,
            });
            attempt.next();
            setQuote(undefined);
            setAmount('');
            trades.reload();
            /* BOTH PANELS REPORT A BALANCE, and a conversion changes both of
               them — without this the screen says the money is still where it
               was, on the screen that just moved it. */
            balances.reload();
            return `Received ${formatAmount(trade.received, trade.to)}.`;
          });
        }}
      >
        {/*
          TWO PANELS AND THE SWAP BETWEEN THEM, which is the comp's whole
          screen — and the currency was being asked TWICE before it: a chip in
          the receive row AND a "Convert to" select under both cards. Two
          controls for one answer, the fault the home screen's currency
          selector already replaced a badge and a rail to fix.
        */}
        <div className="cv-pair">
          <div className="cv-panel">
            <div className="cv-head">
              <span className="cv-label">From</span>
              <Select
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setQuote(undefined);
                }}
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                renderMark={(value) => <CurrencyMark currency={value} size={20} />}
                compact
              />
            </div>
            {/*
              GROUPED AS IT IS TYPED, the way the Send till groups it —
              `groupTyped` from `@xetral/client`, which is the one place that
              arithmetic lives and never produces a number. `50000` at 30px is
              read by counting zeros; `50,000` is read.

              The stored value stays UNGROUPED, so what reaches the API is a
              decimal string and not a display string, and every separator the
              customer's own keyboard might contribute is dropped on the way
              in rather than being sent.
            */}
            <input
              className="cv-figure"
              inputMode="decimal"
              value={groupTyped(amount)}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^0-9.]/g, '');
                // At most one decimal point: a second one is a typo, and
                // `parseFloat` is not available to decide that for us.
                const [whole = '', ...rest] = digits.split('.');
                setAmount(rest.length === 0 ? whole : `${whole}.${rest.join('')}`);
                setQuote(undefined);
              }}
              placeholder="0"
              aria-label="Amount to convert"
              required
            />
            {/* THE BALANCE UNDER THE FIGURE, which is what the comp draws and
                what answers the only other question somebody has here. It is
                the SPENDABLE figure, not the total: pending money cannot be
                converted and offering it would produce a refusal. */}
            <span className="cv-balance">
              {fromBalance === undefined
                ? ' '
                : `Balance ${formatAmount(fromBalance.spendable, from)}`}
            </span>
          </div>

          {/*
            THE ONE DECISION ON THIS SCREEN IS WHICH WAY ROUND, so it is a
            button rather than two pickers. It swaps the pair and drops the
            quote — a rate for NGN→USD is not a rate for USD→NGN, and 008's
            rule is that a rate is a RATIO which does not simply invert
            through a spread.
          */}
          <button
            type="button"
            className="cv-swap"
            aria-label={`Swap — convert ${to} to ${from} instead`}
            onClick={() => {
              setFrom(to);
              setTo(from);
              setQuote(undefined);
            }}
          >
            <Icon name="swapVertical" size={20} />
          </button>

          <div className="cv-panel to">
            <div className="cv-head">
              <span className="cv-label">To</span>
              <Select
                value={to}
                onChange={(value) => {
                  setTo(value);
                  setQuote(undefined);
                }}
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                renderMark={(value) => <CurrencyMark currency={value} size={20} />}
                compact
              />
            </div>
            {/* A quote fills the figure; until one is fetched it is a dash,
                because the rate is the operator's answer and not a default.
                An unpublished pair is refused rather than quoted. */}
            <span className={quote === undefined ? 'cv-figure waiting' : 'cv-figure'}>
              {quote === undefined ? '—' : formatAmount(quote.receives, quote.to)}
            </span>
            <span className="cv-balance">
              {toBalance === undefined ? ' ' : `Balance ${formatAmount(toBalance.spendable, to)}`}
            </span>
          </div>
        </div>

        {from === to && <p className="error">Pick two different currencies.</p>}

        {/*
          THE RATE IS ITS OWN LINE AND THE FEE IS BESIDE IT, never folded into
          the figure. A customer comparing us against a bureau de change
          compares what they receive, and hiding our margin inside the rate
          makes that comparison quietly dishonest.
        */}
        <div className="cv-rate">
          <span>Rate</span>
          <span>
            {quote === undefined
              ? 'Tap Convert to see today’s rate'
              : `1 ${quote.from} = ${quote.rate} ${quote.to}`}
          </span>
        </div>
        {quote !== undefined && (
          <div className="cv-rate" style={{ paddingTop: 0 }}>
            <span>Our fee</span>
            <span>{formatAmount(quote.spread, quote.from)}</span>
          </div>
        )}

        {/*
          ONE BUTTON THAT QUOTES AND THEN CONVERTS.

          It was two — a full-width "Get today's rate" above the field and a
          Convert under it — so the customer pressed a quiet button, read a
          figure, and pressed a loud one, with a rate expiring between them.
          The comp has one, and a quote is a read: fetching it on the way to
          the conversion costs a round trip and removes a step nobody wanted.
        */}
        <button
          type="submit"
          disabled={busy || from === to || amount === ''}
        >
          {busy ? 'Converting…' : quote === undefined ? 'Get today’s rate' : 'Convert now'}
        </button>

        {quote !== undefined && (
          <p className="arrival">
            <Icon name="zap" size={15} /> This rate holds until{' '}
            {new Date(quote.expires_at).toLocaleTimeString()}
          </p>
        )}

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
