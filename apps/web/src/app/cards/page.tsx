'use client';

import { useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { Card } from '@xetral/client';
import { Nav } from '@/lib/nav';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * Virtual USD cards.
 *
 * The balance shown is the LEDGER's, not Bitnob's. A provider figure can lag a
 * settlement by days, and the ledger is what we owe — showing the provider's
 * number would mean a customer watching a balance that disagrees with what
 * they can actually spend.
 */
export default function Cards() {
  const client = useXetral();
  const { data, loading, error, reload } = useLoad(() => client.cards(), [client]);

  return (
    <main className="shell">
      <Nav />

      <div className="panel">
        <h1>Cards</h1>
        <h2>Virtual dollar cards, funded from your wallet</h2>

        {loading && <p className="spinner">Loading…</p>}
        {error !== undefined && <p className="error">{error}</p>}

        {data !== undefined && data.length === 0 && (
          <p className="empty">No cards yet.</p>
        )}

        {data?.map((card) => (
          <CardRow key={card.id} card={card} onChange={reload} />
        ))}
      </div>

      <Issue onIssued={reload} />
    </main>
  );
}

function CardRow({ card, onChange }: { card: Card; onChange: () => void }) {
  const client = useXetral();
  const { busy, error, run } = useSubmit();
  const [pin, setPin] = useState('');
  const [open, setOpen] = useState(false);
  const funding = useIdempotencyKey();
  const [amount, setAmount] = useState('');

  const badge =
    card.status === 'active' ? 'ok' : card.status === 'frozen' ? 'warn' : 'danger';

  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      <div className="balance">
        <div>
          <div className="amount">{formatAmount(card.balance, card.currency)}</div>
          <div className="pending mono">
            {card.last4 === null ? 'issuing' : `•••• ${card.last4}`}
            {card.expiry_month !== null &&
              ` · ${String(card.expiry_month).padStart(2, '0')}/${String(card.expiry_year).slice(-2)}`}
          </div>
        </div>
        <span className={`badge ${badge}`}>{card.status}</span>
      </div>

      {card.status !== 'terminated' && (
        <div className="actions" style={{ marginTop: 12 }}>
          {/*
            Freezing asks for nothing. The server does not require a PIN either,
            and the reason is the same on both sides: a customer watching
            fraudulent charges land should not have to remember a PIN before
            they can stop them. Unfreezing re-enables spending, so it asks.
          */}
          {card.status === 'active' ? (
            <button
              type="button"
              className="ghost small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await client.freezeCard(card.id);
                  onChange();
                  return 'Card frozen.';
                })
              }
            >
              Freeze
            </button>
          ) : (
            <button
              type="button"
              className="ghost small"
              disabled={busy || pin === ''}
              onClick={() =>
                void run(async () => {
                  await client.unfreezeCard(card.id, pin);
                  setPin('');
                  onChange();
                  return 'Card unfrozen.';
                })
              }
            >
              Unfreeze
            </button>
          )}

          <button type="button" className="ghost small" onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Add money'}
          </button>
        </div>
      )}

      {(open || card.status === 'frozen') && (
        <div style={{ marginTop: 12 }}>
          {open && (
            <label>
              Amount (USD)
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="25.00"
              />
            </label>
          )}
          <label>
            Transaction PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
          {open && (
            <button
              type="button"
              disabled={busy || amount === '' || pin === ''}
              onClick={() =>
                void run(async () => {
                  await client.fundCard(card.id, {
                    amount,
                    pin,
                    idempotencyKey: funding.key,
                  });
                  // A NEW key after a success: this form is now available for a
                  // genuinely different top-up, and reusing the old one would
                  // have the server replay the first and report success for
                  // money that never moved.
                  funding.next();
                  setAmount('');
                  setPin('');
                  setOpen(false);
                  onChange();
                  return 'Card funded.';
                })
              }
            >
              {busy ? 'Working…' : 'Add money to card'}
            </button>
          )}
        </div>
      )}

      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
}

function Issue({ onIssued }: { onIssued: () => void }) {
  const client = useXetral();
  const { busy, error, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [name, setName] = useState('');
  const [funding, setFunding] = useState('');
  const [pin, setPin] = useState('');

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await client.issueCard({
            nameOnCard: name,
            initialFunding: funding,
            pin,
            idempotencyKey: attempt.key,
          });
          attempt.next();
          setPin('');
          onIssued();
          return 'Card requested.';
        });
      }}
    >
      <h2>Get a new card</h2>

      <label>
        Name on the card
        <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
      </label>

      <div className="field-row two">
        <label>
          Starting balance (USD)
          <input
            inputMode="decimal"
            value={funding}
            onChange={(e) => setFunding(e.target.value)}
            placeholder="25.00"
            required
          />
        </label>

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
      </div>

      <button type="submit" disabled={busy}>
        {busy ? 'Requesting…' : 'Get a card'}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
      {done !== undefined && <p className="ok">{done}</p>}

      <p className="hint">
        You need a verified identity before a card can be issued.
      </p>
    </form>
  );
}
