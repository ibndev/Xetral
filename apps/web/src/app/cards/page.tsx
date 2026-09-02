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

  /*
   * GETTING A FIRST CARD IS AN ONBOARDING STEP, not a form at the bottom of a
   * list. A customer with no card was shown an empty list and then asked for a
   * name, an amount and a PIN — three fields answering a question they had not
   * been given a reason to answer. The panel below says what the card is and
   * what it costs before it asks for anything.
   *
   * Somebody who already HAS a card is not being onboarded, so they get the
   * list and an "Add a card" button instead.
   */
  const none = data !== undefined && data.length === 0;
  const [adding, setAdding] = useState(false);
  const issuing = none || adding;

  return (
    <Shell>
      <div className="section-head row-between">
        <div>
          <h1>Your cards</h1>
          <p className="lead">Manage your virtual dollar cards</p>
        </div>
        {data !== undefined && data.length > 0 && !adding && (
          <button type="button" className="ghost" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add a card
          </button>
        )}
      </div>

      {loading && <p className="spinner">Loading…</p>}
      {error !== undefined &&
        (code === 'kyc_required' ? (
          <VerifyPrompt what="a USD card" detail={error} />
        ) : (
          <p className="error">{error}</p>
        ))}

      {/*
        THE SPECIMEN IS THE SAME ELEMENT AS A REAL CARD, deliberately. A
        preview built from its own markup is one that stops matching the
        product the first time either changes — and this is the picture a
        customer decides on. It carries the masked number every card face
        carries, because there is nothing else it could honestly show.
      */}
      {none && <CardFace holder={holder} />}

      {data?.map((card, index) => (
        <CardRow
          key={card.id}
          card={card}
          holder={holder}
          onChange={reload}
          position={{ index, of: data.length }}
        />
      ))}

      {issuing && (
        <Issue
          onIssued={() => {
            setAdding(false);
            reload();
          }}
          {...(adding ? { onCancel: () => setAdding(false) } : {})}
        />
      )}
    </Shell>
  );
}

/**
 * THE CARD FACE, and the specimen, as one component.
 *
 * With no `card` it draws the specimen a customer sees before they have one:
 * the same element, the same masked number, no status and no balance. Two
 * pieces of markup would drift, and the one that drifts is the preview — the
 * picture somebody decided to get a card from.
 *
 * NO PAN IS EVER HERE. The number is the masked `last4` the list has always
 * carried, and the specimen has no digits at all; a full number arrives only
 * from a reveal, into separate state with a sixty-second life. The reference
 * design prints a plausible sixteen-digit number on the preview, which would
 * be a fake card number on the screen where a customer is deciding whether
 * this product is real.
 */
function CardFace({
  card,
  holder,
  badge,
  expiry,
}: {
  card?: Card;
  holder: string | undefined;
  badge?: string;
  expiry?: string;
}) {
  return (
    <article
      className={`virtual-card ${card === undefined ? 'is-specimen' : `is-${card.status}`}`}
      aria-label={
        card === undefined
          ? 'What a Xetral card looks like'
          : `Card ending ${card.last4 ?? 'unknown'}`
      }
    >
      <div className="vc-head">
        <Logo size={20} tone="metal" />
        {card === undefined ? (
          <span className="badge">Virtual</span>
        ) : (
          <span className={`badge ${badge ?? ''}`}>{card.status}</span>
        )}
      </div>

      {/* Three arcs, drawn. At this size on a dark face a font glyph would
          substitute visibly on a platform that lacks it. */}
      <svg className="vc-wave" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8.5 8.5a5 5 0 0 1 0 7M12 6a9 9 0 0 1 0 12M15.5 3.5a13 13 0 0 1 0 17"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>

      <div className="vc-number mono">
        {card?.last4 == null ? '•••• •••• •••• ••••' : `•••• •••• •••• ${card.last4}`}
      </div>

      <div className="vc-foot">
        <div className="vc-stack">
          <div className="vc-field">
            <span className="vc-label">Valid thru</span>
            <span className="vc-value mono">{expiry ?? '••/••'}</span>
          </div>
          <div className="vc-field">
            <span className="vc-label">Card holder</span>
            <span className="vc-value">{holder ?? '—'}</span>
          </div>
        </div>
        <div className="vc-field vc-right">
          {/* The scheme every Bitnob virtual card is issued on. */}
          <span className="vc-scheme">VISA</span>
          <span className="vc-currency">{card?.currency ?? 'USD'}</span>
        </div>
      </div>
    </article>
  );
}

function CardRow({
  card,
  holder,
  onChange,
  position,
}: {
  card: Card;
  /** The verified name, from KYC. See the card face below. */
  holder: string | undefined;
  onChange: () => void;
  /** Which of how many, for the pager dots. Absent when there is only one. */
  position?: { index: number; of: number };
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
      <CardFace card={card} holder={holder} badge={badge} expiry={expiry} />
      {position !== undefined && position.of > 1 && (
        <div className="vc-dots" aria-hidden="true">
          {Array.from({ length: position.of }, (_, i) => (
            <span key={i} className={`vc-dot${i === position.index ? ' on' : ''}`} />
          ))}
        </div>
      )}
      <div className="row">
        <span className="muted">Balance</span>
        <span className="mono">{formatAmount(card.balance, card.currency)}</span>
      </div>

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

/**
 * GET YOUR XETRAL CARD — the onboarding step.
 *
 * What it says before it asks: what the card is, where it works, and how much
 * money is about to move. The old form opened with "Name on the card", which
 * is the third question, not the first.
 *
 * THERE IS NO CARD CREATION FEE, and the figure here is not one. The reference
 * design puts "$5.00 · one-time payment" in this slot; nothing in this system
 * charges for issuance — `transfer_fee_basis_points` is the only fee that
 * exists — so printing $5.00 would tell a customer they are being charged for
 * something that takes no money from them. The figure in that slot is the
 * STARTING BALANCE instead, which is the amount that really moves at this
 * step: wallet -> card, the customer's own money, still theirs. If an issuance
 * fee is ever wanted it belongs in `platform_settings` with a bound and a
 * ledger leg, the way every other fee here does.
 */
function Issue({ onIssued, onCancel }: { onIssued: () => void; onCancel?: () => void }) {
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
      <h1>Get your Xetral card</h1>
      <h2>A virtual card for global payments</h2>

      <div className="benefits">
        <div className="benefit">
          <span className="benefit-icon"><Icon name="globe" size={20} /></span>
          <div>
            <h3>Spend anywhere</h3>
            <p>Use your card online and in-store where Visa is accepted.</p>
          </div>
        </div>

        <div className="benefit">
          <span className="benefit-icon"><Icon name="zap" size={20} /></span>
          <div>
            <h3>Instant issuance</h3>
            <p>Get your card and start spending.</p>
          </div>
        </div>
      </div>

      <div className="field-row two" style={{ marginTop: 'var(--s-5)' }}>
        <label>
          Name on the card
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
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

      {/*
        The amount is typed into the figure's own slot. It is the number the
        decision turns on, so it is set where the decision is being made rather
        than in a field above the button.
      */}
      <div className="price-row">
        <div className="price-main">
          <label htmlFor="card-funding" className="price-label">Starting balance</label>
          <input
            id="card-funding"
            className="price-input mono"
            inputMode="decimal"
            value={funding}
            onChange={(e) => setFunding(e.target.value)}
            placeholder="$25.00"
            required
          />
          <p className="price-sub">Moved from your USD wallet. Still your money.</p>
        </div>

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create card'} <Icon name="arrowRight" size={18} />
        </button>
      </div>

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

      {onCancel !== undefined && (
        <div className="actions">
          <button type="button" className="quiet small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}
