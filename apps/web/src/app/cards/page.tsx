'use client';

import { useEffect, useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { Card, CardSecrets } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { Logo } from '@/ui/logo';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { VerifyPrompt } from '@/ui/verify-prompt';

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
  const { data, loading, error, code, reload } = useLoad(() => client.cards(), [client]);

  // The name to print on the card face. A card cannot be issued without an
  // approved identity, so this is present whenever a card is — and it is the
  // customer's own verified name rather than anything the card carries.
  const identity = useLoad(() => client.kyc().catch(() => null), [client]);
  const holder = identity.data?.full_name;

  return (
    <Shell>

      <div className="card">
        <h1>Cards</h1>
        <h2>Virtual dollar cards, funded from your wallet</h2>

        {loading && <p className="spinner">Loading…</p>}
        {error !== undefined &&
          (code === 'kyc_required' ? (
            <VerifyPrompt what="a USD card" detail={error} />
          ) : (
            <p className="error">{error}</p>
          ))}

        {data !== undefined && data.length === 0 && (
          <p className="empty">No cards yet.</p>
        )}

        {data?.map((card) => (
          <CardRow key={card.id} card={card} holder={holder} onChange={reload} />
        ))}
      </div>

      <Issue onIssued={reload} />
    </Shell>
  );
}

function CardRow({
  card,
  holder,
  onChange,
}: {
  card: Card;
  /** The verified name, from KYC. See the card face below. */
  holder: string | undefined;
  onChange: () => void;
}) {
  const client = useXetral();
  const { busy, error, code, run } = useSubmit();
  const [pin, setPin] = useState('');
  const [open, setOpen] = useState(false);
  const funding = useIdempotencyKey();
  const [amount, setAmount] = useState('');
  /**
   * The revealed number, held ONLY while it is on screen.
   *
   * Component state, never a store, never `localStorage`, and cleared by the
   * timer below. A card number that outlives the moment a customer asked for
   * it is a card number sitting in a tab somebody walks away from.
   */
  const [secrets, setSecrets] = useState<CardSecrets | undefined>(undefined);

  // Sixty seconds is long enough to copy a number into a checkout and short
  // enough that an abandoned tab is not a card on display. The cleanup runs on
  // unmount too, so navigating away drops it immediately.
  useEffect(() => {
    if (secrets === undefined) return undefined;
    const timer = setTimeout(() => setSecrets(undefined), 60_000);
    return () => clearTimeout(timer);
  }, [secrets]);

  const badge =
    card.status === 'active' ? 'ok' : card.status === 'frozen' ? 'warn' : 'danger';

  const expiry =
    card.expiry_month === null || card.expiry_year === null
      ? '••/••'
      : `${String(card.expiry_month).padStart(2, '0')}/${String(card.expiry_year).slice(-2)}`;

  return (
    <div className="card card-holder">
      {/*
        THE CARD FACE.
        
        It was a figure and a grey box, which is an accurate summary of the
        row and looks nothing like the thing a customer thinks they have. A
        card is recognised before it is read — the shape, the mark, the four
        digits in the place four digits go — and that recognition is most of
        what tells somebody the product is real.

        NOTHING NEW IS SHOWN. The number is the same masked `last4` the list
        has always carried; there is no PAN here and no field that could hold
        one. The full number arrives only from a reveal, into `secrets`, which
        is separate state with a sixty-second life.

        The cardholder name comes from the VERIFIED IDENTITY, not from the
        card: `name_on_card` is sent to the provider at issue and never stored
        here, and a card cannot exist without an approved KYC record, so the
        name is always available and is the customer's own.
      */}
      <article className={`virtual-card is-${card.status}`} aria-label={`Card ending ${card.last4 ?? 'unknown'}`}>
        <div className="vc-head">
          <Logo size={20} tone="metal" />
          <span className={`badge ${badge}`}>{card.status}</span>
        </div>

        <div className="vc-number mono">
          {card.last4 === null ? '•••• •••• •••• ••••' : `•••• •••• •••• ${card.last4}`}
        </div>

        <div className="vc-foot">
          <div className="vc-field">
            <span className="vc-label">Cardholder</span>
            <span className="vc-value">{holder ?? '—'}</span>
          </div>
          <div className="vc-field">
            <span className="vc-label">Expires</span>
            <span className="vc-value mono">{expiry}</span>
          </div>
          <div className="vc-field vc-right">
            <span className="vc-label">Balance</span>
            <span className="vc-value mono">{formatAmount(card.balance, card.currency)}</span>
          </div>
        </div>
      </article>

      {card.status !== 'terminated' && (
        <div className="actions">
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

          {/*
            Reading the number asks for the PIN, because the server does. A
            number, a CVV and an expiry together are everything needed to spend
            online, and unlike a transfer there is no ledger entry afterwards
            for anyone to notice.
          */}
          <button
            type="button"
            className="ghost small"
            disabled={busy || pin === ''}
            onClick={() =>
              void run(async () => {
                setSecrets(await client.revealCard(card.id, pin));
                setPin('');
                return 'Showing your card details for one minute.';
              })
            }
          >
            Show details
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

      {secrets !== undefined && (
        <div className="panel">
          <div className="row">
            <span>Card number</span>
            <strong className="mono">{group(secrets.pan)}</strong>
          </div>
          <div className="row">
            <span>Expiry</span>
            <strong className="mono">
              {String(secrets.expiry_month).padStart(2, '0')}/
              {String(secrets.expiry_year).slice(-2)}
            </strong>
          </div>
          <div className="row">
            <span>CVV</span>
            <strong className="mono">{secrets.cvv}</strong>
          </div>
          <p className="pending">
            These details disappear in a minute. Xetral will never ask you for them.
          </p>
        </div>
      )}

      <FormError error={error} code={code} />
    </div>
  );
}

/**
 * Groups a card number in fours, without changing a digit.
 *
 * A sixteen-character run is unreadable and mistyped, and mistyping a card
 * number at a checkout is the failure a customer blames the card for.
 */
function group(pan: string): string {
  return pan.replace(/(.{4})/g, '$1 ').trim();
}

function Issue({ onIssued }: { onIssued: () => void }) {
  const client = useXetral();
  const { busy, error, code, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [name, setName] = useState('');
  const [funding, setFunding] = useState('');
  const [pin, setPin] = useState('');

  return (
    <form
      className="card"
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

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

      <p className="hint">
        You need a verified identity before a card can be issued.
      </p>
    </form>
  );
}
