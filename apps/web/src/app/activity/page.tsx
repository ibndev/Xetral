'use client';

import { useState } from 'react';
import { activityFiltersFor, formatAmount, receiptText, statusWords } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';
import { FormError } from '@/ui/form-error';

/**
 * The rail, one line, five filters.
 *
 * It was `['NGN', 'USD']` — two of the platform's five, so a customer holding
 * USDT could see the balance on the home screen and had no tab to read a
 * single transaction behind it. (The API refused those currencies too, which
 * is why nothing caught it: the client and the schema were wrong together.)
 *
 * FOUR ARE CURRENCIES AND ONE IS NOT. Gift cards settle in NAIRA, so "Gift" is
 * the naira history narrowed to the two entry kinds a gift card produces, not
 * a sixth currency. `ACTIVITY_FILTERS` carries that distinction so both apps
 * express it the same way, and the build checks each one against what the API
 * accepts.
 */
// The rail is per customer now — see `activityFiltersFor`. A Ghanaian was
// shown NGN, USD, USDT, USDC and Gift, and no cedi tab at all, which is the
// currency their balance is in.

/**
 * Everything that has happened to this customer's money.
 *
 * Paged on a CURSOR, not an offset — the API pages on the posting id, because
 * an `OFFSET` shifts under an active account and shows a row twice while
 * hiding another. "Load more" appends; it never re-reads what is already on
 * screen.
 */
export default function Activity() {
  const client = useXetral();

  /*
   * THE RAIL IS THE CUSTOMER'S OWN, not a five-entry constant.
   *
   * It was `ACTIVITY_FILTERS` rendered literally, so somebody in Accra got
   * NGN, USD, USDT, USDC and Gift — four currencies they may hold nothing in
   * and not the one their salary is paid in. `activityFiltersFor` leads with
   * their country's currency and keeps anything they actually hold a balance
   * in, because money can arrive in a currency they cannot send from and it
   * must still be readable.
   */
  const session = useLoad(() => client.currentSession(), [client]);
  const balances = useLoad(() => client.balances(), [client]);
  const held = (balances.data ?? []).map((b) => b.currency);
  const home = session.data?.home_currency ?? 'NGN';
  const FILTERS = activityFiltersFor(home, held);

  const [filterId, setFilterId] = useState<string | undefined>();
  // Their own currency until they pick something, and it follows the session
  // arriving rather than being frozen at the first render.
  const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];
  const currency = filter.currency;
  // `readonly string[] | undefined`, spread into the call rather than passed
  // as undefined — a filter with no kinds means every kind.
  const kinds = 'kinds' in filter ? filter.kinds : undefined;
  const [extra, setExtra] = useState<readonly Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Which row is open, by id rather than by index: the list grows as pages
  // load, so an index would point at a different transaction after a Load more.
  const [open, setOpen] = useState<string | undefined>(undefined);

  const first = useLoad(async () => {
    const page = await client.transactions(currency, undefined, kinds);
    setExtra([]);
    setCursor(page.nextCursor);
    return page;
  }, [client, currency, kinds]);

  const rows = [...(first.data?.entries ?? []), ...extra];

  async function more() {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await client.transactions(currency, cursor, kinds);
      setExtra((e) => [...e, ...page.entries]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Shell>
      <h1 className="animate-in">Activity</h1>
      <p className="lead animate-in d1">Every movement, newest first.</p>

      {/* `.rail` scrolls INSIDE itself rather than wrapping or pushing the
          page sideways — five tabs do not fit across a 320px handset. */}
      <div className="segmented rail animate-in d1" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={f.id === filterId}
            className={f.id === filterId ? 'active' : undefined}
            onClick={() => setFilterId(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="card animate-in d2">
        {first.loading && <p className="spinner">Loading…</p>}
        {first.error !== undefined && (
          <p className="error"><Icon name="alert" size={16} /> {first.error}</p>
        )}

        {!first.loading && rows.length === 0 && (
          <div className="empty">
            <span className="empty-icon"><Icon name="file" size={24} /></span>
            <span>Nothing in {filter.label} yet</span>
          </div>
        )}

        <div className="list">
          {rows.map((t) => {
            const outgoing = t.amount.trim().startsWith('-');
            return (
              /*
                A ROW IS A BUTTON. Everything a 320px row cannot hold — the
                fee, the reference, the destination in full, what has happened
                since — is one deliberate tap away rather than crammed in or
                left out.
              */
              <button
                type="button"
                className="list-row tappable"
                key={t.id}
                onClick={() => setOpen(t.id)}
              >
                <span className="row-icon">
                  <Icon name={outgoing ? 'arrowUpRight' : 'download'} size={19} />
                </span>
                <span className="row-main">
                  <span className="row-title">{t.destination ?? t.description}</span>
                  <span className="row-sub">
                    {new Date(t.occurred_at).toLocaleString(undefined, {
                      day: 'numeric', month: 'short', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                    {/*
                      THE PAYOUT'S LIVE STATE, because the description cannot
                      carry it. A payout posts two entries and the customer has
                      a wallet leg only in the first, so what they read was
                      written at RESERVE time — "bank payout reserved", for
                      ever, on money that reached the bank days ago. Entries are
                      append-only and rewriting one would be wrong anyway: it
                      was true when it was written.
                    */}
                    {t.payout_state !== undefined && t.payout_state !== 'sent' && (
                      <>
                        {' · '}
                        <span
                          className={t.payout_state === 'returned' ? 'danger' : undefined}
                        >
                          {t.payout_state === 'returned' ? 'returned' : 'on its way'}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                {/*
                  MONEY LEAVING IS RED AND MONEY ARRIVING IS GREEN. It was red
                  for neither: an outgoing figure took the default text colour,
                  so the only thing separating "you were paid" from "you paid"
                  at a glance was a minus sign and a small arrow.
                */}
                <span
                  className="row-value amount"
                  style={{ color: outgoing ? 'var(--danger)' : 'var(--ok)' }}
                >
                  {formatAmount(t.amount, t.currency)}
                </span>
              </button>
            );
          })}
        </div>

        {cursor !== null && (
          <div className="actions" style={{ marginTop: 16, justifyContent: 'center' }}>
            <button type="button" className="ghost small" onClick={more} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </section>
      {open !== undefined && (
        <TransactionSheet id={open} onClose={() => setOpen(undefined)} />
      )}
    </Shell>
  );
}

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
function TransactionSheet({ id, onClose }: { id: string; onClose: () => void }) {
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

  return (
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
    </div>
  );
}
