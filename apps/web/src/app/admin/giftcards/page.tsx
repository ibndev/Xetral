'use client';

import { useState } from 'react';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';

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

  // `gift_cards_disabled` is the expected answer on most deployments — the
  // feature ships off and needs both the deployment flag and the stored
  // setting. Saying so beats an empty table that looks like a bug.
  const disabled = queue.error !== undefined && queue.error.includes('not available');

  return (
    <>
      <div className="panel">
        <h1>Gift cards</h1>
        <h2>{disabled ? 'Not enabled' : `${queue.data?.length ?? 0} waiting`}</h2>

        {disabled ? (
          <div className="notice warn">
            <p>Gift card trading is switched off on this deployment.</p>
            <p className="hint">
              It needs both the deployment&apos;s own flag and the stored setting
              under Settings → Features.
            </p>
          </div>
        ) : (
          <p className="lead">
            Approving pays into a hold, not a spendable balance. A payout can be
            clawed back only while held.
          </p>
        )}

        {!disabled && queue.error !== undefined && <p className="error">{queue.error}</p>}
        {queue.loading && <p className="spinner">Loading…</p>}
        {!disabled && queue.data !== undefined && queue.data.length === 0 && (
          <p className="empty">Nothing waiting.</p>
        )}
      </div>

      {queue.data?.map((submission, index) => (
        <Submission
          key={String((submission as Record<string, unknown>)['id'] ?? index)}
          submission={submission as Record<string, string>}
          onReviewed={queue.reload}
        />
      ))}
    </>
  );
}

function Submission({
  submission,
  onReviewed,
}: {
  submission: Record<string, string>;
  onReviewed: () => void;
}) {
  const admin = useAdmin();
  const id = submission['id'] ?? '';
  const [revealed, setRevealed] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        await action();
        setPin('');
        setReason('');
        onReviewed();
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="panel">
      <div className="grid two">
        <div>
          <h3 style={{ marginTop: 0 }}>
            {submission['brand']} · {submission['card_type']}
          </h3>
          <div className="row">
            <span className="muted">Face value</span>
            <span className="amount">
              {submission['face_value']} {submission['face_currency']}
            </span>
          </div>
          <div className="row">
            <span className="muted">Payout</span>
            <span className="amount">
              {submission['payout']} {submission['payout_currency']}
            </span>
          </div>
          <div className="row">
            <span className="muted">Customer</span>
            <span>{submission['email']}</span>
          </div>
          <div className="row">
            <span className="muted">Submitted</span>
            <span>{new Date(submission['created_at'] ?? '').toLocaleString()}</span>
          </div>

          <div className="actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="ghost small"
              disabled={busy || revealed !== undefined}
              onClick={() =>
                void (async () => {
                  try {
                    const result = await admin.revealGiftCard(id);
                    setRevealed(String((result as Record<string, unknown>)['code'] ?? ''));
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
            <div className="notice warn" style={{ marginTop: 12 }}>
              <p className="mono">{revealed}</p>
              <p className="hint">
                This is a bearer instrument. Do not screenshot it and do not
                paste it anywhere.
              </p>
            </div>
          )}
        </div>

        <div>
          <label>
            Reason (required to reject or claw back)
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
              disabled={busy || pin === ''}
              onClick={() => act(() => admin.reviewGiftCard(id, 'approve', pin))}
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || pin === '' || reason === ''}
              onClick={() => act(() => admin.reviewGiftCard(id, 'reject', pin, reason))}
            >
              Reject
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || pin === '' || reason === ''}
              onClick={() => act(() => admin.clawbackGiftCard(id, reason, pin))}
            >
              Claw back
            </button>
          </div>

          {error !== undefined && <p className="error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
