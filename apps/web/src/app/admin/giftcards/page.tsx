'use client';

import { Fragment, useState } from 'react';
import { formatMinor } from '@xetral/client';
import type { AdminGiftCardQueue } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminTitle } from '@/app/admin/nav';
import { AdminError } from '../access';
import { ago, ageSince } from '../age';
import { Kpis } from '../queue';

type Pending = AdminGiftCardQueue['queue'][number];
type Held = AdminGiftCardQueue['held'][number];

/**
 * The gift card review queue.
 *
 * EVERY PAYOUT ON THIS PAGE IS APPROVED BY A PERSON. There is no auto-approval
 * path and no threshold below which one exists, because "small" is what a
 * fraudster sends first to find where the threshold is.
 *
 * The queue carries no card codes. Revealing one is a separate, deliberate
 * request against a single submission — a backlog listing that returned every
 * code would put a page of bearer instruments into a browser tab, a log and a
 * screenshot every time somebody glanced at it.
 *
 * Approving does not make the money spendable. It moves it to a hold that
 * matures on the DATABASE's clock, which is the only control still standing
 * once a card has been approved.
 */
export default function GiftCards() {
  const admin = useAdmin();
  const queue = useLoad(() => admin.giftCardQueue(), [admin]);
  const [open, setOpen] = useState<{ id: string; mode: 'approve' | 'reject' | 'clawback' }>();

  /*
   * OFF IS A STATE, NOT AN ERROR. Read from the CODE — this screen matched
   * the words "not available" in the sentence, which is a claim about how an
   * error message happens to be phrased today.
   */
  const disabled = queue.code === 'gift_cards_disabled';
  const pending = queue.data?.queue ?? [];
  const held = queue.data?.held ?? [];
  const summary = queue.data?.summary;

  const reload = (): void => {
    setOpen(undefined);
    queue.reload();
  };
  const toggle = (id: string, mode: 'approve' | 'reject' | 'clawback'): void =>
    setOpen(open?.id === id && open.mode === mode ? undefined : { id, mode });

  return (
    <>
      <AdminTitle>Gift cards</AdminTitle>
      <Kpis
        items={[
          { label: 'Awaiting review', count: summary?.awaiting, tone: 'warn' },
          { label: 'Holds due', count: summary?.holds_due, tone: 'warn' },
          { label: 'Approved · 24h', count: summary?.approved_24h, tone: 'ok' },
        ]}
      />

      <div className="panel tbl-panel">
        {disabled ? (
          <span className="tbl-note">
            Gift card trading is switched off on this deployment. It needs both the
            deployment&apos;s own flag and the stored setting under Settings → Features.
          </span>
        ) : (
          <AdminError error={queue.error} code={queue.code} role="giftcard_reviewer" />
        )}
        {queue.loading && <p className="spinner">Loading…</p>}
        {queue.data !== undefined && pending.length === 0 && (
          <p className="empty">Nothing waiting.</p>
        )}

        {pending.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Card</th>
                  <th>Face</th>
                  <th>Submitted by</th>
                  <th>Waiting</th>
                  <th className="r">Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((card) => (
                  <Fragment key={card.submission_uuid}>
                    <tr>
                      <td>
                        {card.brand} {card.country} · {TYPES[card.card_type] ?? card.card_type}
                      </td>
                      <td className="amount soft">{whole(formatMinor(card.face_amount_minor, card.face_currency))}</td>
                      <td className="quiet">{card.name ?? card.email ?? '—'}</td>
                      <td className="quiet">{ageSince(card.created_at)}</td>
                      <td className="r">
                        <span className="acts">
                          <button
                            type="button"
                            className="ghost"
                            aria-expanded={open?.id === card.submission_uuid && open.mode === 'reject'}
                            onClick={() => toggle(card.submission_uuid, 'reject')}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            aria-expanded={open?.id === card.submission_uuid && open.mode === 'approve'}
                            onClick={() => toggle(card.submission_uuid, 'approve')}
                          >
                            Approve
                          </button>
                        </span>
                      </td>
                    </tr>
                    {open?.id === card.submission_uuid && open.mode !== 'clawback' && (
                      <tr className="detail">
                        <td colSpan={5}>
                          <Decide card={card} mode={open.mode} onDone={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {held.length > 0 && (
        <div className="panel tbl-panel">
          <span className="tbl-note">
            Paid into a hold and not yet spendable. A payout can be clawed back
            only while it is held — after release it may already be spent.
          </span>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Card</th>
                  <th className="r">Paid</th>
                  <th>Customer</th>
                  <th>Hold ends</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {held.map((card) => (
                  <Fragment key={card.submission_uuid}>
                    <tr>
                      <td>
                        {card.brand} · {TYPES[card.card_type] ?? card.card_type}
                      </td>
                      <td className="r amount soft">
                        {formatMinor(card.payout_amount_minor, card.payout_currency)}
                      </td>
                      <td className="quiet">{card.name ?? card.email ?? '—'}</td>
                      <td className="quiet">{ageSince(card.hold_until)}</td>
                      <td className="r">
                        <button
                          type="button"
                          className="ghost"
                          aria-expanded={open?.id === card.submission_uuid}
                          onClick={() => toggle(card.submission_uuid, 'clawback')}
                        >
                          Claw back
                        </button>
                      </td>
                    </tr>
                    {open?.id === card.submission_uuid && open.mode === 'clawback' && (
                      <tr className="detail">
                        <td colSpan={5}>
                          <ClawBack card={card} onDone={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

const TYPES: Readonly<Record<string, string>> = { ecode: 'e-code', physical: 'physical' };

/** "$100.00" as the comp writes a face value, "$100". Only whole zeros go —
 *  no digit of an amount is ever changed. */
function whole(formatted: string): string {
  return formatted.replace(/\.0+$/, '');
}

/**
 * One decision on one card.
 *
 * The code is revealed HERE, one card at a time, on a deliberate press — the
 * queue carries none. The API names it `card_code`; this screen read `code`,
 * so a reviewer who pressed Reveal was shown an empty box.
 */
function Decide({
  card,
  mode,
  onDone,
}: {
  readonly card: Pending;
  readonly mode: 'approve' | 'reject';
  readonly onDone: () => void;
}) {
  const admin = useAdmin();
  const [revealed, setRevealed] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        await action();
        onDone();
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(false);
        setPin('');
      }
    })();
  };

  const payout = formatMinor(card.payout_amount_minor, card.payout_currency);

  return (
    <div className="review-grid">
      <div>
        <p>
          <strong>
            {card.brand} {card.country} · {whole(formatMinor(card.face_amount_minor, card.face_currency))}
          </strong>{' '}
          <span className="hint">
            {card.email ?? '—'} · submitted {ago(card.created_at)}
          </span>
        </p>
        <div className="row">
          <span className="muted">Pays the customer</span>
          <span className="amount">{payout}</span>
        </div>
        <div className="actions">
          <button
            type="button"
            className="ghost"
            disabled={busy || revealed !== undefined}
            onClick={() =>
              void (async () => {
                try {
                  setRevealed((await admin.revealGiftCard(card.submission_uuid)).card_code);
                } catch (cause) {
                  setError(messageFor(cause));
                }
              })()
            }
          >
            Reveal the code
          </button>
        </div>
        {revealed !== undefined && (
          <div className="notice warn">
            <p className="mono">{revealed}</p>
            <p className="hint">
              A bearer instrument. Do not screenshot it and do not paste it anywhere.
            </p>
          </div>
        )}
      </div>

      <div>
        {mode === 'reject' && (
          <label>
            Why you are rejecting it
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {mode === 'approve' && (
          <p className="hint">
            Approving pays {payout} into a hold, not a spendable balance. It
            matures on the database&rsquo;s clock.
          </p>
        )}
        <label>
          Your transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <div className="actions">
          {mode === 'approve' ? (
            <button
              type="button"
              disabled={busy || pin === ''}
              onClick={() => run(() => admin.reviewGiftCard(card.submission_uuid, 'approve', pin))}
            >
              {busy ? 'Approving…' : `Approve and pay ${payout}`}
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              disabled={busy || pin === '' || reason.trim() === ''}
              onClick={() =>
                run(() => admin.reviewGiftCard(card.submission_uuid, 'reject', pin, reason))
              }
            >
              {busy ? 'Rejecting…' : 'Reject'}
            </button>
          )}
        </div>
        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function ClawBack({ card, onDone }: { readonly card: Held; readonly onDone: () => void }) {
  const admin = useAdmin();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const paid = formatMinor(card.payout_amount_minor, card.payout_currency);

  return (
    <div className="review-grid">
      <div>
        <p>
          <strong>{paid}</strong>{' '}
          <span className="hint">
            {card.email ?? '—'} · hold ends {ageSince(card.hold_until)}
          </span>
        </p>
        <p className="hint">
          Clawing back reverses the payout out of the hold. It is final, and it
          is refused once the hold has released.
        </p>
      </div>
      <div>
        <label>
          Why the card was bad
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label>
          Your transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="danger"
            disabled={busy || pin === '' || reason.trim() === ''}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void (async () => {
                try {
                  await admin.clawbackGiftCard(card.submission_uuid, reason, pin);
                  onDone();
                } catch (cause) {
                  setError(messageFor(cause));
                } finally {
                  setBusy(false);
                  setPin('');
                }
              })();
            }}
          >
            {busy ? 'Clawing back…' : `Claw back ${paid}`}
          </button>
        </div>
        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
