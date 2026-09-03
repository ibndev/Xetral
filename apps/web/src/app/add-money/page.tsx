'use client';

import { formatAmount } from '@xetral/client';
import type { Deposit } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * Adding money, and WHAT IS AND IS NOT GATED ON VERIFICATION.
 *
 * THIS SCREEN USED TO BE A WALL, and then it was a smaller wall.
 *
 * First, an unverified customer got `kyc_required` as the entire page — on
 * the screen somebody opens in order to put money in, which read as "you may
 * not deposit until you verify". That was fixed by showing the tier 0 ceiling
 * and naming the one thing that needed verifying: the account NUMBER.
 *
 * THE SECOND HALF OF THAT WAS ALSO WRONG. "Regulation does not permit an
 * unidentified account" is a statement about BITNOB, which will not issue one
 * without a verified BVN. CBN's tiered KYC permits a tier 1 account on a name
 * and a phone number, capped — and `029_kyc_tiers.seed.sql` has capped tier 0
 * at ₦50,000 a day since it landed. The platform was enforcing the tier 1
 * ceiling and refusing the account that ceiling is for.
 *
 * So there is no gate here at all now. The requirement moved to the Bitnob
 * adapter, where it is true, and the default rail opens an account from what
 * signup already holds.
 *
 * The deposit history is shown either way. A customer whose transfer has gone
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
              Send to <strong>{account.data.account_name}</strong>. Yours permanently.
            </p>
            {account.data.status !== 'active' && (
              <p className="hint">Still being activated. Transfers will start arriving shortly.</p>
            )}
          </>
        )}

        {/*
          NO ACCOUNT YET — one button, and NO VERIFICATION GATE IN FRONT OF IT.

          This screen used to send an unverified customer to /kyc first, on
          the reasoning that a Nigerian account number is a bank account
          issued in a person's name and regulation does not permit an
          unidentified one. The second half of that was wrong: CBN's tiered
          KYC permits a tier 1 account on a name and a phone number, capped —
          and `029_kyc_tiers.seed.sql` has capped tier 0 at ₦50,000 a day
          since it landed. So the platform enforced the tier 1 ceiling while
          refusing the account that ceiling is for, on the screen somebody
          opens in order to put money in.

          What was true was a fact about BITNOB, which will not issue without
          a verified BVN. That requirement now lives in its adapter, and the
          default rail does not have it.
        */}
        {!account.loading && !has && (
          /*
            EACH PIECE IN ITS OWN ROW, WITH ROOM AROUND IT.

            This was three siblings inside a card whose default gap is tight
            enough for a form: a line, a button and a second line, stacked hard
            against one another so the primary action on the page read as part
            of a paragraph. `.activate` is a small grid — the statement, the
            button, then the ceiling — so the button is a deliberate act with
            space either side rather than the middle of a sentence.
          */
          <div className="activate">
            <p className="activate-lead">Your naira account is ready. Get it below.</p>

            <div>
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
                {busy ? 'Activating…' : 'Activate Account'}{' '}
                <Icon name="arrowRight" size={18} />
              </button>
            </div>

            <p className="hint">
              You can receive up to {'\u20A6'}50,000 a day straight away.
            </p>

            <FormError error={issueError} code={issueCode} />
          </div>
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
