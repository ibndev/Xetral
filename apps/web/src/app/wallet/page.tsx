'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { xetral } from '@/lib/session';
import { messageFor } from '@/lib/errors';
import { Nav } from '@/lib/nav';

export default function Wallet() {
  const router = useRouter();
  const [balances, setBalances] = useState<readonly Balance[]>([]);
  const [history, setHistory] = useState<readonly Transaction[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const signedOut = useCallback(() => router.push('/signin'), [router]);

  useEffect(() => {
    const { client } = xetral(signedOut);

    void (async () => {
      try {
        // Two requests at once, on mount. This is precisely the shape that
        // makes single-flight refresh necessary: without it both would find
        // the token expired and both would rotate, and the server would
        // correctly read the second as a replay.
        const [loaded, ngn] = await Promise.all([
          client.balances(),
          client.transactions('NGN').catch(() => []),
        ]);
        setBalances(loaded);
        setHistory(ngn);
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, [signedOut]);

  return (
    <main className="shell">
      <Nav />

      <div className="panel">
        <h1>Balances</h1>
        <h2>What you can spend right now</h2>

        {loading && <p className="hint">Loading…</p>}
        {!loading && balances.length === 0 && (
          <p className="hint">
            Nothing here yet. <a href="/add-money">Add money</a> to get started.
          </p>
        )}

        {balances.map((balance) => (
          <div className="balance" key={balance.currency}>
            <div>
              <div className="amount">{formatAmount(balance.spendable, balance.currency)}</div>
              {balance.pending !== '0.00' && balance.pending !== '0.000000' && (
                // Pending is shown separately rather than folded into the
                // total, because the difference is the whole point: a card
                // authorization or an unconfirmed deposit is money the
                // customer has and cannot spend.
                <div className="pending">
                  {formatAmount(balance.pending, balance.currency)} pending
                </div>
              )}
            </div>
            <div className="pending">{balance.currency}</div>
          </div>
        ))}

        {error !== undefined && <p className="error">{error}</p>}
      </div>

      {history.length > 0 && (
        <div className="panel">
          <h2>Recent naira activity</h2>
          {history.map((entry) => (
            <div className="row" key={entry.id}>
              <span>{entry.description}</span>
              <span className="amount">{formatAmount(entry.amount, entry.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
