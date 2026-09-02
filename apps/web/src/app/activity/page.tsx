'use client';

import { useState } from 'react';
import { activityFiltersFor, formatAmount } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';

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
              <div className="list-row" key={t.id}>
                <span className="row-icon">
                  <Icon name={outgoing ? 'arrowUpRight' : 'download'} size={19} />
                </span>
                <span className="row-main">
                  <span className="row-title">{t.description}</span>
                  <span className="row-sub">
                    {new Date(t.occurred_at).toLocaleString(undefined, {
                      day: 'numeric', month: 'short', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </span>
                <span
                  className="row-value amount"
                  style={outgoing ? undefined : { color: 'var(--ok)' }}
                >
                  {formatAmount(t.amount, t.currency)}
                </span>
              </div>
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
    </Shell>
  );
}
