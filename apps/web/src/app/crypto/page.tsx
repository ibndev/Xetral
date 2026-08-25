'use client';

import { useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { CryptoAddress, CryptoQuote } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { VerifyPrompt } from '@/ui/verify-prompt';

/**
 * Deposits and withdrawals on chain.
 *
 * Two things on this screen are not decoration. An address is shown with its
 * NETWORK stated as prominently as the address itself, because USDT sent to a
 * Tron address over Ethereum is gone; and a withdrawal asks the customer to
 * accept a maximum fee, because network fees move between the quote and the
 * request and a fee they did not agree to is money taken quietly.
 */
const ASSETS = [
  { asset: 'USDT', network: 'TRON', label: 'USDT on Tron (TRC-20)' },
  { asset: 'USDT', network: 'ETHEREUM', label: 'USDT on Ethereum (ERC-20)' },
  { asset: 'BTC', network: 'BITCOIN', label: 'Bitcoin' },
] as const;

export default function Crypto() {
  const client = useXetral();
  const withdrawals = useLoad(() => client.withdrawals(), [client]);

  // The address request is what trips the identity gate first, so its refusal
  // is the one that decides whether this whole screen is usable. Shown as an
  // invitation at the top rather than as red text buried in one panel.
  if (withdrawals.code === 'kyc_required') {
    return (
      <Shell>
        <VerifyPrompt what="crypto" detail={withdrawals.error} />
      </Shell>
    );
  }

  return (
    <Shell>
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
  const { busy, error, run } = useSubmit();
  const selected = ASSETS[choice];

  return (
    <div className="card">
      <h1>Receive</h1>
      <h2>An address of your own, for one asset on one network</h2>

      <label>
        Asset and network
        <select
          value={choice}
          onChange={(e) => {
            setChoice(Number(e.target.value));
            setAddress(undefined);
          }}
        >
          {ASSETS.map((a, index) => (
            <option key={a.label} value={index}>
              {a.label}
            </option>
          ))}
        </select>
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

      {error !== undefined && <p className="error">{error}</p>}
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
  const { busy, error, done, run } = useSubmit();
  const selected = ASSETS[choice];

  return (
    <form
      className="card"
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

      <label>
        Asset and network
        <select
          value={choice}
          onChange={(e) => {
            setChoice(Number(e.target.value));
            setQuote(undefined);
          }}
        >
          {ASSETS.map((a, index) => (
            <option key={a.label} value={index}>
              {a.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Destination address
        <input
          className="mono"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <span className="hint">
          Check every character. We verify the checksum, which catches a
          mistyped address — but an address that is valid and belongs to
          somebody else cannot be undone.
        </span>
      </label>

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
          className="ghost small"
          disabled={amount === ''}
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
          Check the fee
        </button>
      </div>

      {quote !== undefined && (
        <div className="notice">
          <p>
            Network fee <strong className="amount">{formatAmount(quote.fee, quote.asset)}</strong>{' '}
            · total{' '}
            <strong className="amount">{formatAmount(quote.total, quote.asset)}</strong>
          </p>
        </div>
      )}

      <label>
        Transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
      </label>

      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send'}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
      {done !== undefined && <p className="ok">{done}</p>}
    </form>
  );
}
