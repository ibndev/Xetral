'use client';

import { useState } from 'react';
import { activityFiltersFor } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';
import { TxList } from '@/ui/tx-list';
import { TransactionSheet } from '@/ui/transaction-sheet';

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
      <div className="page-head">
        <h1>Activity</h1>
      </div>
      <p className="page-lede">Every movement, newest first.</p>

      {/*
        THE COMP'S CHIP RAIL, not a segmented control.

        A segmented control is one choice out of a FIXED, SHORT set that all
        fit — the two destinations on the Send screen. This set is per
        customer and can be seven long, so it scrolls, and a scrolling
        segmented control is a pill with its own ends drifting past the edge
        of the screen. The comp draws chips here: each one its own shape, the
        active one filled, the rail bleeding off the gutter so a half-visible
        chip says there are more.

        WHAT THE CHIPS SAY IS STILL OURS. The comp's are All / Sent /
        Received / Bills; this product filters by CURRENCY, plus Gift — which
        is the naira history narrowed to two entry kinds rather than a sixth
        currency. `activityFiltersFor` leads with the customer's own currency
        and keeps anything they hold a balance in, because money can arrive in
        a currency they cannot send from and must still be readable.
      */}
      <div className="chip-rail bleed" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={f.id === filter.id}
            className={f.id === filter.id ? 'chip on' : 'chip'}
            onClick={() => setFilterId(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

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

      {/*
        NOT IN A CARD. The comp's activity is rows on the page under day
        headings, and the border round them was what made this screen read as
        a settings list rather than as the home screen's own list continued.
        A ROW IS A BUTTON: everything a 320px row cannot hold — the fee, the
        reference, the destination in full, what has happened since — is one
        deliberate tap away rather than crammed in or left out.
      */}
      <TxList entries={rows} onOpen={setOpen} />

      {cursor !== null && (
        <div className="actions" style={{ marginTop: 16, justifyContent: 'center' }}>
          <button type="button" className="ghost small" onClick={more} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
      {open !== undefined && (
        <TransactionSheet id={open} onClose={() => setOpen(undefined)} />
      )}
    </Shell>
  );
}
