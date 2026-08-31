'use client';

import { formatAmount } from '@xetral/client';
import type { Deposit, KycLimits, VirtualAccount } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useLoad, useXetral } from '@/lib/hooks';

/**
 * Adding money, and WHAT IS AND IS NOT GATED ON VERIFICATION.
 *
 * This screen used to be a wall. Unverified, the account lookup answered
 * `kyc_required`, `FormError` rendered "Verify your identity to use this", and
 * that was the entire page — on the screen somebody opens in order to put
 * money in. It read as "you may not deposit until you verify", which is not
 * true and is the worst thing it could have said.
 *
 * WHAT IS ACTUALLY TRUE: an unverified account may hold and move ₦50,000 a
 * day. That is tier 0 in `029_kyc_tiers.seed.sql`, it has been the policy
 * since that migration landed, and NOTHING SHOWED IT TO ANYBODY. So the
 * allowance is now the first thing on the page, read from `/v1/kyc/limits` —
 * the customer's real ceiling rather than a number written into a screen.
 *
 * WHAT GENUINELY IS GATED, and why it is not ours to ungate: a dedicated
 * Nigerian account number is a BANK ACCOUNT ISSUED IN A PERSON'S NAME.
 * Bitnob will not create one without a registered customer, and Nigerian
 * regulation does not permit an unidentified one — this is `provider_
 * customers`, the same mapping that gates cards. That is a fact about the
 * rail, not a policy choice this screen can make, so the honest thing is to
 * say which one thing needs verification and why, rather than refusing the
 * whole page.
 *
 * The deposit history is shown either way. A customer whose transfer is
 * missing needs to see what arrived far more than a verified one does.
 */
export default function AddMoney() {
  const client = useXetral();

  /*
   * Idempotent by construction on the server: one live account per customer
   * per currency, so calling this on every visit returns the same number
   * rather than issuing another.
   */
  const account = useLoad<VirtualAccount>(() => client.fundingAccount(), [client]);
  const limits = useLoad<KycLimits>(() => client.kycLimits(), [client]);
  const deposits = useLoad<readonly Deposit[]>(() => client.deposits(), [client]);

  const ngn = limits.data?.limits.find((l) => l.currency === 'NGN');
  // `kyc_required` is the ONE code this screen answers itself. Anything else
  // is a real failure and goes to `FormError` with its own next step.
  const needsVerifying = account.code === 'kyc_required';

  return (
    <Shell>
      <div className="card">
        <h1>Add money</h1>
        <h2>Transfer from any Nigerian bank</h2>

        {ngn !== undefined && (
          <p className="notice">
            <Icon name="info" size={16} />
            <span>
              Your account can receive and move up to{' '}
              <strong>{formatAmount(ngn.daily_limit, 'NGN')}</strong> a day
              {limits.data?.tier === 0 ? ' without verifying your identity' : ''}.
            </span>
          </p>
        )}

        {account.loading && <p className="hint">Getting your account number…</p>}

        {account.data !== undefined && (
          <>
            <div className="balance">
              <div>
                <div className="amount mono">{account.data.account_number}</div>
                <div className="pending">{account.data.bank_name}</div>
              </div>
              <div className="pending">{account.data.currency}</div>
            </div>
            <p className="hint">
              Send to <strong>{account.data.account_name}</strong>. This account is yours
              permanently — save it as a beneficiary and money you send lands in your
              wallet automatically.
            </p>
            {account.data.status !== 'active' && (
              <p className="hint">
                Your account is still being activated. It will start accepting transfers
                shortly.
              </p>
            )}
          </>
        )}

        {needsVerifying && (
          <div className="notice">
            <p>
              <strong>Your own account number needs your identity.</strong>
            </p>
            <p>
              A dedicated Nigerian account number is a bank account opened in your name,
              so the bank has to know whose it is. That is the one part of adding money
              that needs verifying — not the deposit itself.
            </p>
            <p>
              <a className="btn" href="/kyc">
                Verify my identity
              </a>
            </p>
          </div>
        )}

        {/* Anything that is NOT the verification gate. A provider outage or a
            signed-out session is a different problem and needs its own words. */}
        {!needsVerifying && <FormError error={account.error} code={account.code} />}
      </div>

      <div className="card">
        <div className="section-head">
          <h2>Money received</h2>
        </div>

        {deposits.loading && <p className="spinner">Loading…</p>}

        {!deposits.loading && (deposits.data?.length ?? 0) === 0 && (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="download" size={24} />
            </span>
            <span>Nothing received yet</span>
          </div>
        )}

        <div className="list">
          {(deposits.data ?? []).map((d) => (
            <div className="row" key={d.id}>
              <div>
                <div className="row-title">{d.sender_name ?? 'Bank transfer'}</div>
                <div className="row-sub">{new Date(d.created_at).toLocaleString()}</div>
              </div>
              <div className="amount mono">{formatAmount(d.amount, d.currency)}</div>
            </div>
          ))}
        </div>

        <FormError error={deposits.error} code={deposits.code} />
      </div>
    </Shell>
  );
}
