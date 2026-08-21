'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { VirtualAccount } from '@xetral/client';
import { xetral } from '@/lib/session';
import { messageFor } from '@/lib/errors';
import { Nav } from '@/lib/nav';

export default function AddMoney() {
  const router = useRouter();
  const [account, setAccount] = useState<VirtualAccount | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const signedOut = useCallback(() => router.push('/signin'), [router]);

  useEffect(() => {
    const { client } = xetral(signedOut);
    void (async () => {
      try {
        // Idempotent by construction on the server: one live account per
        // customer per currency, so calling this on every visit returns the
        // same number rather than issuing another.
        setAccount(await client.fundingAccount());
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
        <h1>Add money</h1>
        <h2>Transfer from any Nigerian bank</h2>

        {loading && <p className="hint">Getting your account number…</p>}

        {account !== undefined && (
          <>
            <div className="balance">
              <div>
                <div className="amount mono">{account.account_number}</div>
                <div className="pending">{account.bank_name}</div>
              </div>
              <div className="pending">{account.currency}</div>
            </div>
            <p className="hint">
              Send to <strong>{account.account_name}</strong>. This account is yours
              permanently — save it as a beneficiary and money you send lands in your
              wallet automatically.
            </p>
            {account.status !== 'active' && (
              <p className="hint">
                Your account is still being activated. It will start accepting transfers
                shortly.
              </p>
            )}
          </>
        )}

        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
