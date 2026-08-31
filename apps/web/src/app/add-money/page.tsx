'use client';

import type { VirtualAccount } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';

export default function AddMoney() {
  const client = useXetral();

  /*
   * On `useLoad` rather than its own effect, for the code as much as the
   * tidiness. This screen refuses without a verified identity, and its
   * hand-rolled state kept only the sentence — so the customer read "verify
   * your identity" on the screen they came to in order to receive money, with
   * nothing to press. Idempotent by construction on the server: one live
   * account per customer per currency, so calling this on every visit returns
   * the same number rather than issuing another.
   */
  const {
    data: account,
    error,
    code,
    loading,
  } = useLoad<VirtualAccount>(() => client.fundingAccount(), [client]);

  return (
    <Shell>

      <div className="card">
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

        <FormError error={error} code={code} />
      </div>
    </Shell>
  );
}
