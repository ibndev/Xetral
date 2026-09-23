'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CRYPTO_PAIRS, cryptoPortfolio, formatAmount, formatMinor, formatQuantity, currencyName } from '@xetral/client';
import type { CryptoAddress, CryptoQuote } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { VerifyPrompt } from '@/ui/verify-prompt';
import { Toast } from '@/ui/toast';

/**
 * WHAT THE CUSTOMER ACTUALLY HOLDS, and what it is worth — the comp's
 * portfolio card, then its holdings list.
 *
 * THE DOLLAR FIGURES ARE `/v1/wallets/total`'s OWN LINES, not a second
 * calculation here. That route prices every balance at what a conversion
 * would actually pay — the published rate, the published spread, rounded
 * down — so the portfolio value and the home screen's headline are the same
 * arithmetic and cannot disagree about one coin.
 *
 * AN UNPRICED ASSET IS NAMED, NEVER VALUED AT A GUESS. BTC has no dollar
 * price until an operator publishes one; its row then says "No price yet"
 * and the card says what was left out, because a total that silently skipped
 * a balance reads as money gone.
 *
 * AND THE COMP'S "+4.2% today" IS NOT DRAWN. A daily move needs yesterday's
 * price, which this platform does not keep — `fx_published_rates` holds the
 * price in force, not a history of them. A percentage with no source is the
 * "+₦150,000 this week" chip in a second place. The line says what the
 * figure IS instead: dollars, at today's rate.
 *
 * The arithmetic is `cryptoPortfolio` in `@xetral/client`, shared with the
 * phone. Zero rows are shown, because an asset missing from the list is
 * indistinguishable from one that failed to load.
 */
function Portfolio({ home }: { readonly home: string }) {
  const client = useXetral();
  const balances = useLoad(() => client.balances(), [client]);
  const total = useLoad(() => client.dollarTotal(), [client]);
  const p = cryptoPortfolio(total.data, balances.data);
  /* Buy pays from the customer's own money; Sell lands there. A home currency
     is fiat by construction, so the pair is never crypto into crypto. */
  const fiat = home;

  return (
    <>
      <div className="portfolio-card">
        <span className="portfolio-label">Portfolio value</span>
        <div className="portfolio-value">
          {total.data !== undefined ? formatMinor(p.totalMinor, 'USD') : total.error !== undefined ? '—' : '…'}
        </div>
        <span className="portfolio-note">
          {total.error !== undefined
            ? 'Prices are unavailable right now'
            : p.unpriced.length > 0
              ? `In dollars, at today’s rate · not counted: ${p.unpriced.join(', ')}`
              : 'In dollars, at today’s rate'}
        </span>
      </div>
      <div className="portfolio-actions">
        <Link className="btn" href={`/fx?from=${fiat}&to=USDT`}>
          Buy
        </Link>
        <Link className="btn quiet" href={`/fx?from=${p.largest ?? 'USDT'}&to=${fiat}`}>
          Sell
        </Link>
      </div>

      <span className="eyebrow">Holdings</span>
      {balances.loading && <p className="spinner">Loading…</p>}
      <div>
        {p.rows.map((row) => (
          <div className="tx-row" key={row.asset} style={{ cursor: 'default' }}>
            <span className="tx-mark">
              <span className="avatar">
                <CurrencyMark currency={row.asset} size={26} />
              </span>
            </span>
            <span className="tx-main">
              <span className="tx-name">{currencyName(row.asset)}</span>
              <span className="tx-sub">{formatQuantity(row.held, row.asset)}</span>
            </span>
            <span className="tx-side">
              <span className="tx-amt">
                {row.valueMinor !== undefined ? formatMinor(row.valueMinor, 'USD') : '—'}
              </span>
              {row.valueMinor === undefined && <span className="tx-time">No price yet</span>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Deposits and withdrawals on chain.
 *
 * Two things on this screen are not decoration. An address is shown with its
 * NETWORK stated as prominently as the address itself, because USDT sent to a
 * Tron address over Ethereum is gone; and a withdrawal asks the customer to
 * accept a maximum fee, because network fees move between the quote and the
 * request and a fee they did not agree to is money taken quietly.
 */
/*
 * THE PAIRS COME FROM `@xetral/client`, and this list is why.
 *
 * It read `TRON`, `ETHEREUM` and `BITCOIN`. The API's schema is
 * `z.enum(['bitcoin','ethereum','tron','bsc'])` and zod is case-sensitive, so
 * EVERY crypto action from a browser was refused with `400 invalid_request` on
 * the `network` field — a deposit address, a fee quote, a withdrawal — and the
 * customer read "Some details are missing or invalid" about a form they had
 * filled in correctly. BNB Chain was missing entirely.
 *
 * Nothing could see it: the API's e2e drives its endpoints with the right
 * casing, this file compiled because a string is a string, and the two lists
 * lived in different workspaces. One list now, and
 * `crypto-networks.test.ts` fails the build if it drifts from the schema.
 */
const ASSETS = CRYPTO_PAIRS;

export default function Crypto() {
  const client = useXetral();
  const withdrawals = useLoad(() => client.withdrawals(), [client]);
  const session = useLoad(() => client.currentSession(), [client]);

  // The address request is what trips the identity gate first, so its refusal
  // is the one that decides whether this whole screen is usable. Shown as an
  // invitation at the top rather than as red text buried in one panel.
  if (withdrawals.code === 'kyc_required') {
    return (
      <Shell back="/more" title="Crypto">
        <VerifyPrompt what="crypto" />
      </Shell>
    );
  }

  return (
    /*
      A BACK ARROW AND A TITLE, because this screen is reached from More and
      is not a tab. It drew the brand header — the one the home screen gets —
      so it read as a top-level destination with no way back to the list it
      was opened from.
    */
    <Shell back="/more" title="Crypto">
      <Portfolio home={session.data?.home_currency ?? 'NGN'} />
      <Receive />
      <Send onSent={withdrawals.reload} />

      <div className="card">
        <h2>Withdrawals</h2>
        {withdrawals.loading && <p className="spinner">Loading…</p>}
        {withdrawals.data !== undefined && withdrawals.data.length === 0 && (
          <p className="empty">Nothing yet.</p>
        )}
        {withdrawals.data?.map((w) => (
          <div className="row" key={w.id}>
            <span>
              <span className="mono">
                {w.destination.slice(0, 10)}…{w.destination.slice(-6)}
              </span>
              <div className="hint">
                {w.asset} on {w.network}
                {w.tx_hash !== null && ` · ${w.tx_hash.slice(0, 12)}…`}
              </div>
              {w.failure_reason !== null && <div className="hint">{w.failure_reason}</div>}
            </span>
            <span className="nowrap">
              <span className="amount">{formatAmount(w.amount, w.asset)}</span>{' '}
              <span
                className={`badge ${
                  w.status === 'sent' ? 'ok' : w.status === 'failed' ? 'danger' : 'warn'
                }`}
              >
                {w.status}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Receive() {
  const client = useXetral();
  const [choice, setChoice] = useState(0);
  const [address, setAddress] = useState<CryptoAddress | undefined>();
  const { busy, error, code, run } = useSubmit();
  const selected = ASSETS[choice];

  return (
    <div className="card">
      {/* A SECTION HEADING, NOT A SECOND PAGE TITLE. These were `<h1>` and
          `<h2>`, so "Receive" rendered LARGER than "Crypto" — two headings
          claiming to be the top of the same screen, with the bigger one
          halfway down it. The page title is the Shell's. */}
      <h2>Receive</h2>
      <p className="hint" style={{ marginTop: 4 }}>
        An address of your own, for one asset on one network
      </p>

      <label className="field" id="crypto-receive-pair">
        <span className="field-label">Asset and network</span>
        <Select
          labelledBy="crypto-receive-pair"
          value={String(choice)}
          onChange={(value) => {
            setChoice(Number(value));
            setAddress(undefined);
          }}
          options={ASSETS.map((a, index) => ({ value: String(index), label: a.label }))}
        />
      </label>

      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            if (selected === undefined) return undefined;
            setAddress(await client.cryptoAddress(selected.asset, selected.network));
            return undefined;
          })
        }
      >
        {busy ? 'Getting your address…' : 'Show my address'}
      </button>

      {address !== undefined && (
        <>
          <div className="notice warn" style={{ marginTop: 16 }}>
            <p>
              Send only <strong>{address.asset}</strong> on the{' '}
              <strong>{address.network}</strong> network to this address.
            </p>
            <p className="hint">
              Anything else sent here cannot be recovered by us or by anyone
              else.
            </p>
          </div>

          <p className="mono" style={{ wordBreak: 'break-all' }}>
            {address.address}
          </p>
          {address.memo !== null && (
            <p className="hint mono">
              Memo / tag: {address.memo} — a deposit without it may not be
              credited.
            </p>
          )}
        </>
      )}

      <FormError error={error} code={code} />
    </div>
  );
}

function Send({ onSent }: { onSent: () => void }) {
  const client = useXetral();
  const [choice, setChoice] = useState(0);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [quote, setQuote] = useState<CryptoQuote | undefined>();
  const attempt = useIdempotencyKey();
  const { busy, error, code, done, run, clear } = useSubmit();
  const selected = ASSETS[choice];

  return (
    /* EDGE TO EDGE, LIKE SEND. A withdrawal is money leaving to somewhere we
       cannot reach into — Phase 9's shape — so it reads as the Send bar: the
       amount is the hero well, the asset sits in it as a pill, and the fee is
       a line rather than a boxed notice. */
    <form
      className="send-step"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (selected === undefined) return undefined;
          await client.withdrawCrypto({
            asset: selected.asset,
            network: selected.network,
            destination,
            amount,
            // The fee the customer saw and accepted. If the network has moved
            // since, the server refuses rather than charging the new one —
            // which is what makes the quote a promise rather than an estimate.
            ...(quote === undefined ? {} : { maxFee: quote.fee }),
            pin,
            idempotencyKey: attempt.key,
          });
          attempt.next();
          setPin('');
          setQuote(undefined);
          onSent();
          return 'Sent. On-chain transfers cannot be recalled.';
        });
      }}
    >
      <h2>Send</h2>
      <p className="lead">On-chain, to any address you control.</p>

      <label className="field" id="crypto-send-pair">
        <span className="field-label">Asset and network</span>
        <Select
          labelledBy="crypto-send-pair"
          value={String(choice)}
          onChange={(value) => {
            setChoice(Number(value));
            setQuote(undefined);
          }}
          options={ASSETS.map((a, index) => ({ value: String(index), label: a.label }))}
        />
      </label>

      <label className="field">
        <span className="field-label">Destination address</span>
        <input
          className="mono"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <span className="hint">
          Check every character. We catch a typo; we cannot recall a payment
          sent to somebody else’s valid address.
        </span>
      </label>

      <div className="amount-card">
        <span className="field-label">You send</span>
        <div className="amount-row">
          <span className="currency-pill">{selected?.asset ?? ''}</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setQuote(undefined);
            }}
            placeholder="0"
            aria-label="Amount to send"
            required
          />
        </div>
        {quote !== undefined && (
          <span className="hint">
            Network fee {formatAmount(quote.fee, quote.asset)} · total{' '}
            {formatAmount(quote.total, quote.asset)}
          </span>
        )}
      </div>

      <button
        type="button"
        className="quiet block"
        disabled={busy || amount === ''}
        onClick={() =>
          void run(async () => {
            if (selected === undefined) return undefined;
            setQuote(
              await client.cryptoQuote({
                asset: selected.asset,
                network: selected.network,
                amount,
              }),
            );
            return undefined;
          })
        }
      >
        {quote === undefined ? 'Check the fee' : 'Refresh fee'}
      </button>

      <label className="field">
        <span className="field-label">Transaction PIN</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
      </label>

      <p className="arrival">
        <Icon name="alert" size={15} /> On-chain transfers cannot be recalled.
      </p>

      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send'}
      </button>

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

      {/*
        OVER the form as well as in it. An on-chain withdrawal cannot be
        recalled, so whether it left is the one thing a customer must not have
        to guess at. The inline copy stays, so a refusal can be re-read.
      */}
      <Toast message={done} tone="ok" onDone={clear} />
      <Toast message={error} tone="bad" onDone={clear} />
    </form>
  );
}
