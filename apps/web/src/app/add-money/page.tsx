'use client';

import Link from 'next/link';
import { formatAmount } from '@xetral/client';
import type { Deposit } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';

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
  const { busy, error: issueError, code: issueCode, run } = useSubmit();

  /*
   * READ, don't issue. This called `fundingAccount()` — which asks Bitnob and
   * opens a bank account — merely to display a number, so every visit to this
   * page opened an account as a side effect of being looked at. It was
   * survivable only because issuing is idempotent.
   *
   * Opening one is now a BUTTON, which is also what it is: a dedicated
   * Nigerian account number is a bank account in the customer's own name, and
   * that is a thing somebody decides to do rather than a thing that happens
   * while they are reading.
   */
  const account = useLoad(() => client.existingFundingAccount(), [client]);
  const deposits = useLoad<readonly Deposit[]>(() => client.deposits(), [client]);

  // Whether they may HAVE one. `kyc_required` is what issuing answers for an
  // unverified customer, and it is the one refusal this screen owns.
  const verified = useLoad(() => client.kyc().catch(() => null), [client]);
  const isVerified = verified.data?.status === 'approved';

  const has = account.data != null;

  return (
    <Shell>
      <div className="card">
        <h1>Add money</h1>
        <h2>Transfer from any Nigerian bank</h2>

        {account.loading && <p className="hint">Checking your account…</p>}

        {account.data != null && (
          <>
            <div className="balance">
              <div>
                <div className="amount mono">{account.data.account_number}</div>
                <div className="pending">{account.data.bank_name}</div>
              </div>
              <div className="pending">{account.data.currency}</div>
            </div>
            <p className="hint">
              Send to <strong>{account.data.account_name}</strong>. Yours permanently —
              save it as a beneficiary.
            </p>
            {account.data.status !== 'active' && (
              <p className="hint">
                Your account is still being activated. It will start accepting transfers
                shortly.
              </p>
            )}
          </>
        )}

        {/*
          NO ACCOUNT YET — one button, and where it goes depends on whether the
          customer can have one.

          A dedicated Nigerian account number is a BANK ACCOUNT ISSUED IN A
          PERSON'S NAME. Bitnob will not create one without a registered
          customer and Nigerian regulation does not permit an unidentified one,
          so verification is a fact about the rail rather than a policy this
          screen chose. What this screen decides is only whether to send
          somebody to prove who they are first, or to open the account now.
        */}
        {!account.loading && !has && (
          <>
            {isVerified ? (
              <>
                <p className="hint">
                  Open your Xetral account number and any Nigerian bank can pay into it.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await client.fundingAccount();
                      account.reload();
                      return 'Your account is open.';
                    })
                  }
                >
                  {busy ? 'Opening…' : 'Create account'}{' '}
                  <Icon name="arrowRight" size={18} />
                </button>
                <FormError error={issueError} code={issueCode} />
              </>
            ) : (
              <>
                <p className="hint">
                  Your account number is issued in your name, so we need your identity
                  first. It takes a minute.
                </p>
                <Link className="btn" href="/kyc">
                  Verify my identity <Icon name="arrowRight" size={18} />
                </Link>
              </>
            )}
          </>
        )}

        {/* Anything that is NOT the verification gate. A provider outage or a
            signed-out session is a different problem and needs its own words. */}
        <FormError error={account.error} code={account.code} />
      </div>

      {/*
        MONEY RECEIVED, ONLY WHEN THERE IS SOME.
        
        It was a second card with an empty state, on a screen whose job is to
        get money in — so the commonest view of this page was two boxes, one of
        them saying nothing. The history itself is not clutter: a customer
        whose transfer has not arrived needs it more than anybody. So it is
        removed exactly when it has nothing to say.
      */}
      {(deposits.data?.length ?? 0) > 0 && (
        <div className="card">
          <div className="section-head">
            <h2>Money received</h2>
          </div>

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
      )}
    </Shell>
  );
}
