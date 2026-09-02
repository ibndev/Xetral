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
  /*
   * THE LIST AND THE PRICE COME BACK TOGETHER.
   *
   * `card_issuance_fee_cents` is a `platform_settings` row an operator can
   * change, so a figure typed into this file would show the old price from the
   * moment one did — a price on a screen disagreeing with the price in the
   * ledger. One request, one source.
   */
  const { data, loading, error, code, reload } = useLoad(() => client.cardList(), [client]);
  const cards = data?.cards;

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
  const none = cards !== undefined && cards.length === 0;
  const [adding, setAdding] = useState(false);
  const issuing = none || adding;

  return (
    <Shell>
      <div className="section-head row-between">
        <div>
          <h1>Your cards</h1>
          <p className="lead">Manage your virtual dollar cards</p>
        </div>
        {cards !== undefined && cards.length > 0 && !adding && (
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

      {cards?.map((card, index) => (
        <CardRow
          key={card.id}
          card={card}
          holder={holder}
          onChange={reload}
          position={{ index, of: cards.length }}
        />
      ))}

      {issuing && (
        <Issue
          price={data?.issuance_fee}
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
  const funding = useIdempotencyKey();
  const [amount, setAmount] = useState('');
  /*
   * WHICH ACTION THE PIN IS FOR — and the reason this is one state rather than
   * a bare `open` flag.
   *
   * THE PIN BOX WAS RENDERED ONLY WHEN THE TOP-UP FORM WAS OPEN OR THE CARD WAS
   * FROZEN, and three actions read it. So on an ACTIVE card "Show details" was
   * permanently disabled on `pin === ''` with no box on screen to fill: the
   * only way to read your own card number was to open Add money, type a PIN
   * into a form that says it is for adding money, and press a different button.
   * That is Phase 13's "every card issued was unusable" finding, back in the
   * UI — the reveal exists and cannot be reached.
   *
   * The other direction was wrong too: a frozen card showed a PIN box the
   * moment it rendered, before the customer had said whether they wanted to
   * unfreeze it or read it. A secret asked for with no stated purpose is the
   * habit that makes somebody type it when a stranger asks.
   *
   * So: pick the action, THEN the PIN for that action, named. The same order
   * the Send screen and the card purchase now follow.
   */
  const [pending, setPending] = useState<'fund' | 'unfreeze' | 'reveal' | undefined>(undefined);

  /** Leaves the PIN nowhere. A cancelled action must not leave the secret in
   *  state for the next one to reuse. */
  function cancel(): void {
    setPin('');
    setPending(undefined);
  }
  /*
   * NAMING THE CARD, which is the step that comes AFTER buying one.
   *
   * A second card is otherwise indistinguishable from the first: every face
   * reads four digits and the same verified name. `label` is the customer's
   * own note — not `name_on_card`, which is their legal name and is not theirs
   * to set — so it takes no PIN and no confirmation.
   */
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState(card.label ?? '');
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
        <span className="muted">Name</span>
        {naming ? (
          <span className="mono">{card.label ?? `Card ending ${card.last4 ?? '••••'}`}</span>
        ) : (
          <button
            type="button"
            className="btn link"
            onClick={() => {
              setLabel(card.label ?? '');
              setNaming(true);
            }}
          >
            {card.label ?? `Card ending ${card.last4 ?? '••••'}`}
          </button>
        )}
      </div>

      {naming && (
        <div>
          <label>
            What do you call this card?
            <input
              value={label}
              maxLength={40}
              placeholder="Subscriptions"
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  // An empty box CLEARS the name rather than storing a blank
                  // one — the database refuses whitespace, and "" arriving as a
                  // label would be a 400 on the obvious way to undo this.
                  await client.nameCard(card.id, label.trim() === '' ? null : label.trim());
                  setNaming(false);
                  onChange();
                  return 'Card renamed.';
                })
              }
            >
              Save
            </button>
            <button type="button" className="quiet small" onClick={() => setNaming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="row">
        <span className="muted">Balance</span>
        <span className="mono">{formatAmount(card.balance, card.currency)}</span>
      </div>

      {card.status !== 'terminated' && pending === undefined && (
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
            <button type="button" className="ghost small" onClick={() => setPending('unfreeze')}>
              Unfreeze
            </button>
          )}

          <button type="button" className="ghost small" onClick={() => setPending('fund')}>
            Add money
          </button>

          {/*
            Reading the number asks for the PIN, because the server does. A
            number, a CVV and an expiry together are everything needed to spend
            online, and unlike a transfer there is no ledger entry afterwards
            for anyone to notice.
          */}
          <button type="button" className="ghost small" onClick={() => setPending('reveal')}>
            Show details
          </button>
        </div>
      )}

      {/*
        ONE PANEL, NAMING WHAT IT IS ABOUT TO DO. The PIN never appears without
        a sentence saying which action it authorises — and it is the same box
        for all three, so there is no way for one of them to be reachable and
        another not.
      */}
      {pending !== undefined && (
        <div style={{ marginTop: 12 }}>
          <div className="section-head row-between">
            <h2>
              {pending === 'fund'
                ? 'Add money to this card'
                : pending === 'unfreeze'
                  ? 'Unfreeze this card'
                  : 'Show card details'}
            </h2>
            <button type="button" className="btn link" onClick={cancel}>
              Cancel
            </button>
          </div>

          {pending === 'fund' && (
            <label>
              Amount (USD)
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="25.00"
                autoFocus
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
              maxLength={6}
              onChange={(e) => setPin(e.target.value)}
              // Focused here for the two actions that have nothing above it, so
              // the one field on screen is the one the cursor is in.
              autoFocus={pending !== 'fund'}
            />
          </label>

          <button
            type="button"
            disabled={busy || pin === '' || (pending === 'fund' && amount === '')}
            onClick={() =>
              void run(async () => {
                if (pending === 'fund') {
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
                  cancel();
                  onChange();
                  return 'Card funded.';
                }
                if (pending === 'unfreeze') {
                  await client.unfreezeCard(card.id, pin);
                  cancel();
                  onChange();
                  return 'Card unfrozen.';
                }
                // The one action that returns something. `secrets` is separate
                // state with a sixty-second life; the PIN is dropped either way.
                setSecrets(await client.revealCard(card.id, pin));
                cancel();
                return 'Showing your card details for one minute.';
              })
            }
          >
            {busy
              ? 'Working…'
              : pending === 'fund'
                ? 'Add money to card'
                : pending === 'unfreeze'
                  ? 'Unfreeze card'
                  : 'Show details'}
          </button>
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
 * IT ASKS FOR NOTHING BUT THE DECISION. It used to open with "Name on the
 * card", "Transaction PIN" and "Starting balance" — three questions in front of
 * a product the customer had not yet agreed to buy, and the first two were
 * wrong on their own terms:
 *
 *  - THE NAME IS NOT THEIRS TO TYPE. A card is issued in a person's legal name,
 *    which this system holds in `kyc_submissions.full_name` — read off a
 *    document by a reviewer. A free-text box let the name embossed on the card
 *    disagree with the identity it was issued against.
 *  - THE STARTING BALANCE IS A SECOND DECISION. Somebody who wants a card had
 *    to name an amount before they had a card to put it on. Loading one is
 *    `Add money` on the card itself, the moment the card exists.
 *  - THE PIN IS NOT A FORM FIELD. It authorises the purchase, so it is asked
 *    on the confirm step — after the customer can see what they are approving.
 *    The same order the Send screen now follows.
 *
 * AND THE PRICE IS REAL. It comes from `card_issuance_fee_cents`, is charged as
 * a `card_creation` entry against the customer's USD wallet and is split for
 * VAT. This slot used to hold the starting balance dressed as a price, because
 * nothing in this system charged for issuance; 041 is what made the figure
 * mean what the screen says it means.
 */
function Issue({
  price,
  onIssued,
  onCancel,
}: {
  /** From the server, never from this file. Undefined while the list loads. */
  price: string | undefined;
  onIssued: () => void;
  onCancel?: () => void;
}) {
  const client = useXetral();
  const { busy, error, code, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [pin, setPin] = useState('');
  const [stage, setStage] = useState<'offer' | 'confirm'>('offer');

  const free = price === '0.00';

  function buy(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => {
      await client.issueCard({ pin, idempotencyKey: attempt.key });
      attempt.next();
      // Cleared the moment the request returns. A PIN authorises one
      // instruction; it is not a password to hold on to.
      setPin('');
      setStage('offer');
      onIssued();
      return 'Your card is on its way.';
    });
  }

  if (stage === 'confirm') {
    return (
      <form className="card" onSubmit={buy}>
        <div className="section-head">
          <h1>Confirm</h1>
          <button
            type="button"
            className="btn link"
            onClick={() => {
              setPin('');
              setStage('offer');
            }}
          >
            Back
          </button>
        </div>
        <h2>Check this before you approve it</h2>

        <div className="row">
          <span className="muted">A virtual USD card</span>
          <span className="mono">{price === undefined ? '—' : `$${price}`}</span>
        </div>
        <div className="row">
          <span className="muted">From</span>
          <span className="mono">Your USD wallet</span>
        </div>

        <label>
          Transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            maxLength={6}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            required
          />
        </label>

        <button type="submit" disabled={busy || pin === ''}>
          {busy ? 'Creating…' : 'Create my card'}
        </button>

        <FormError error={error} code={code} />
        {done !== undefined && <p className="ok">{done}</p>}
      </form>
    );
  }

  return (
    <div className="card">
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

      {/* THE PRICE AND THE BUTTON ON ONE ROW. `.price-row` is a flex row that
          wraps, so on a handset the button drops under the figure rather than
          squeezing it — beside it wherever there is room, which is the
          reference design's arrangement and the reason the button is not
          `block`. */}
      <div className="price-row">
        <div className="price-main">
          <p className="price-label">{free ? 'Your card' : 'Card price'}</p>
          <p className="price">{price === undefined ? '—' : free ? 'Free' : `$${price}`}</p>
          <p className="price-sub">
            {free
              ? 'No charge to open one. Add money to it once it is yours.'
              : 'One-time, from your USD wallet. Add money to the card afterwards.'}
          </p>
        </div>

        <button type="button" onClick={() => setStage('confirm')} disabled={price === undefined}>
          Create card <Icon name="arrowRight" size={18} />
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
    </div>
  );
}
