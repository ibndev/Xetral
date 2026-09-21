'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatAmount, receiptText, statusWords } from '@xetral/client';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';
import { FormError } from '@/ui/form-error';

/**
 * ONE TRANSACTION, IN FULL, AND A WAY TO SEND IT ON.
 *
 * THE SHARE IS THE POINT of this screen rather than a decoration. The question
 * a customer is answering when they open a transaction is almost always
 * somebody else's — "did you send it?" — and before this the only answer
 * available was a screenshot of a list row, which carries no reference and no
 * destination.
 *
 * `navigator.share` where the browser has it, the clipboard where it does not.
 * Not a download: a receipt that arrives as a file is one more step for
 * everybody, and the artifact sandbox aside, a phone's share sheet is where
 * this is going anyway.
 */
export function TransactionSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useXetral();
  const detail = useLoad(() => client.transaction(id), [client, id]);
  const [shared, setShared] = useState<string | undefined>(undefined);

  const t = detail.data;

  async function share(): Promise<void> {
    if (t === undefined) return;
    const text = receiptText(t);
    try {
      // The share sheet where there is one. `navigator.share` rejects when the
      // customer dismisses it, which is not an error worth reporting — hence
      // the catch below rather than a message.
      /*
       * THE SHARE SHEET WHERE THERE IS ONE, the clipboard where there is not.
       * Narrowed through a local rather than tested inline: `'share' in
       * navigator` does not narrow the type, and a cast would assert something
       * about a browser API rather than check it.
       */
      const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
      if (nav === undefined) return;
      if (typeof nav.share === 'function') {
        await nav.share({ title: 'Xetral receipt', text });
        return;
      }
      await nav.clipboard.writeText(text);
      setShared('Receipt copied.');
    } catch {
      // A dismissed share sheet and a refused clipboard look the same from
      // here and neither is worth interrupting somebody for.
    }
  }

  /*
   * PORTALLED TO THE BODY, and this is not tidiness.
   *
   * `.sheet-backdrop` is `z-index: 60` and the tab bar is 40, which is the
   * right order and was not the order on screen: the sheet renders inside
   * `main.shell`, which carries the `screen-in` entrance — and an animated
   * `transform` creates a STACKING CONTEXT. Every z-index inside it is then
   * scoped to that context's own level, so the tab bar drew on top of a modal
   * over a scrim, cutting off the bottom of a receipt somebody had opened in
   * order to answer "did you pay me?". A portal takes the sheet out of the
   * context rather than trying to out-number it, which is what the Send
   * flow's own confirmation dialog did before it became a screen.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="sheet-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2>Transaction</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {detail.loading && <p className="spinner">Loading…</p>}
        <FormError error={detail.error} code={detail.code} />

        {t !== undefined && (
          <>
            <p className="sheet-amount amount">
              {formatAmount(t.amount, t.currency)}
            </p>
            <p className="lead">{statusWords(t)}</p>

            <div className="row">
              <span className="muted">What</span>
              <span>{t.description}</span>
            </div>
            {t.beneficiary !== undefined && (
              <div className="row">
                <span className="muted">To</span>
                <span>{t.beneficiary}</span>
              </div>
            )}
            {t.bank_name !== undefined && (
              <div className="row">
                <span className="muted">Bank</span>
                <span>
                  {t.bank_name}
                  {t.account_number !== undefined && ` ••${t.account_number.slice(-4)}`}
                </span>
              </div>
            )}
            {/*
              THE FEE AS ITS OWN LINE. A transfer that charges one is two
              postings against the same wallet, and a customer who can see only
              the total cannot reconcile it against their balance.
            */}
            {t.fee !== undefined && !/^0([.,]0+)?$/.test(t.fee) && (
              <div className="row">
                <span className="muted">Fee</span>
                <span>{formatAmount(t.fee, t.currency)}</span>
              </div>
            )}
            <div className="row">
              <span className="muted">Date</span>
              <span>{new Date(t.occurred_at).toLocaleString()}</span>
            </div>
            <div className="row">
              <span className="muted">Reference</span>
              <span className="mono">{t.reference}</span>
            </div>
            {t.narration !== undefined && t.narration !== null && t.narration !== '' && (
              <div className="row">
                <span className="muted">Note</span>
                <span>{t.narration}</span>
              </div>
            )}

            <button type="button" onClick={() => void share()}>
              <Icon name="copy" size={16} /> Share receipt
            </button>
            {shared !== undefined && <p className="ok">{shared}</p>}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
