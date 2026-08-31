'use client';

import { useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';

const CURRENCIES = ['NGN', 'USD'] as const;

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
  const [currency, setCurrency] = useState<string>('NGN');
  const [extra, setExtra] = useState<readonly Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const first = useLoad(async () => {
    const page = await client.transactions(currency);
    setExtra([]);
    setCursor(page.nextCursor);
    return page;
  }, [client, currency]);

  const rows = [...(first.data?.entries ?? []), ...extra];

  async function more() {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await client.transactions(currency, cursor);
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

      <div className="segmented animate-in d1">
        {CURRENCIES.map((c) => (
          <button
            key={c}
            type="button"
            className={c === currency ? 'active' : undefined}
            onClick={() => setCurrency(c)}
          >
            {c}
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
            <span>Nothing in {currency} yet</span>
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
