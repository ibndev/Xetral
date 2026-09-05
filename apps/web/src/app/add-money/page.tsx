'use client';

import { useEffect, useState } from 'react';
import { displayPhone, formatAmount, paymentLinkFor } from '@xetral/client';
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

  /*
   * WHAT SOMEBODY HERE CAN ACTUALLY FUND WITH — data, not a `switch`.
   *
   * This screen offered one thing: Activate account, which issues a Nigerian
   * NUBAN. That is how a Nigerian funds a wallet and it was the only answer
   * the screen had — so a customer in Accra opened the page they go to in
   * order to put money in and was offered a bank account they cannot pay
   * into. 051 puts the answer on the country row, which is where 040 says a
   * fact about a country belongs, and it is an ARRAY because a country can
   * have both: the day Paystack issues dedicated accounts in Ghana, an
   * operator adds one entry and this screen offers it on the next load.
   *
   * Falls back to nothing rather than to a NUBAN while the list loads and on
   * an API predating 051. Offering nothing for a moment is a blank space;
   * offering the wrong rail is a customer sending money into the void.
   */
  const session = useLoad(() => client.currentSession(), [client]);
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);
  const funding = here?.funding_methods ?? [];
  const canIssueAccount = funding.includes('virtual_account');
  const usesMobileMoney = funding.includes('mobile_money');

  const has = account.data != null;

  /*
   * REQUEST PAYMENT LIVES HERE, on the screen whose whole subject is money
   * arriving. It was on the settings page — filed under the account, next to
   * the transaction PIN — which is where somebody goes to CHANGE something,
   * not where they go when they need to be paid.
   */
  const profile = useLoad(() => client.profile(), [client]);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  /*
   * THE ORIGIN THIS PAGE IS ALREADY BEING SERVED FROM, as the fallback for a
   * link the API could not build.
   *
   * With `APP_BASE_URL` unset the server returns no link and this panel used
   * to print "No link yet — this deployment has no public address set." to a
   * customer, on the screen they opened in order to ASK TO BE PAID. That is
   * an operator's problem rendered where a customer is standing, and the
   * information needed to fix it was in the browser's address bar the whole
   * time.
   *
   * Read in an effect rather than during render, because `window` does not
   * exist on the server and a value that differs between the two is a
   * hydration mismatch. Configuration still WINS when it is set — an operator
   * who has named a canonical origin has said which one a shared link should
   * carry.
   */
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const phone = profile.data?.phone ?? null;
  const link =
    profile.data?.link ?? (phone !== null && origin !== '' ? paymentLinkFor(origin, phone) : null);

  function copy(text: string, mark: (v: boolean) => void): void {
    if (text === '') return;
    void navigator.clipboard
      ?.writeText(text)
      // A clipboard the browser refused is not worth a banner — the value is
      // on screen and can be selected.
      .then(() => mark(true))
      .catch(() => undefined);
  }

  return (
    <Shell>
      <div className="card">
        <h1>Add Money</h1>

        {account.loading && <p className="hint">Checking your account…</p>}

        {account.data != null && (
          <>
            {/*
              THE NAME ON TOP, INSIDE THE SAME BOX AS THE NUMBER.
              
              It was a line of prose UNDER the box — "Send to <name>. Yours
              permanently." — which separates the three things a customer
              copies into their banking app across two containers, and puts
              the one they are asked for FIRST last. A beneficiary is a name,
              a bank and a number, and they are read together.
            */}
            <div className="balance">
              <div style={{ minWidth: 0 }}>
                <div className="pending">{account.data.account_name}</div>
                <div className="amount mono">{account.data.account_number}</div>
                <div className="pending">{account.data.bank_name}</div>
              </div>
              <div className="pending">{account.data.currency}</div>
            </div>
            <p className="hint">Transfer money to fund your wallet</p>
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
        {!account.loading && !has && canIssueAccount && (
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

            <FormError error={issueError} code={issueCode} />
          </div>
        )}

        {/*
          MOBILE MONEY, AND WHAT IS HONEST TO SAY ABOUT IT TODAY.

          In Ghana and Kenya money moves through a mobile money wallet, and
          this screen has to say something true to a customer there rather
          than offering them a Nigerian account number.

          IT DOES NOT OFFER A BUTTON THAT DOES NOTHING. Linking a momo wallet
          as a standing funding instrument is a provider integration that does
          not exist here yet — Paystack's mobile money is a charge channel
          rather than an account we can issue and watch — and a Link button
          that opened nothing would be the exact failure a filled box on an
          operations screen is: it reads as something that is running.

          So it names the routes that DO reach a wallet here today. Every one
          of them is built and settles into the same balance: another Xetral
          customer paying this number, a payment link, and crypto.
        */}
        {!account.loading && usesMobileMoney && !canIssueAccount && (
          <div className="activate">
            <p className="activate-lead">
              In {here?.name ?? 'your country'}, money reaches your wallet
              these ways today.
            </p>
            <div className="list">
              <div className="list-row">
                <span className="row-icon"><Icon name="send" size={19} /></span>
                <span className="row-main">
                  <span className="row-title">Another Xetral customer</span>
                  <span className="row-sub">
                    They send to your phone number. It arrives in {here?.currency ?? 'your currency'}.
                  </span>
                </span>
              </div>
              <div className="list-row">
                <span className="row-icon"><Icon name="globe" size={19} /></span>
                <span className="row-main">
                  <span className="row-title">Your payment link</span>
                  <span className="row-sub">
                    For anyone not on Xetral. It is on your settings page.
                  </span>
                </span>
              </div>
              <div className="list-row">
                <span className="row-icon"><Icon name="bitcoin" size={19} /></span>
                <span className="row-main">
                  <span className="row-title">Crypto</span>
                  <span className="row-sub">Bitcoin, USDT and USDC, on the Crypto screen.</span>
                </span>
              </div>
            </div>
            <p className="hint">
              A local mobile money top-up is not open here yet. We will say so
              on this screen the moment it is, rather than showing a button
              that does nothing.
            </p>
          </div>
        )}

        {/*
          NEITHER RAIL, WHICH IS A REAL STATE AND A TEMPORARY ONE. An operator
          can open a country before its funding rail is arranged —
          `countries_without_a_way_in` reports exactly this — and a customer
          there should be told rather than shown an empty page.
        */}
        {!account.loading && !canIssueAccount && !usesMobileMoney && !countries.loading && (
          <p className="hint">
            Adding money is not open in {here?.name ?? 'your country'} yet. You
            can still be paid by another Xetral customer, through your payment
            link, or in crypto.
          </p>
        )}

        {/* Anything that is NOT the verification gate. A provider outage or a
            signed-out session is a different problem and needs its own words. */}
        <FormError error={account.error} code={account.code} />
      </div>

      {/*
        REQUEST PAYMENT — ITS OWN SECTION, not a row inside the account box.

        Two ways to be paid, for two different people. A Xetral customer
        paying another types a phone number, which is the one thing everybody
        already knows about everybody they pay. The link is the answer to the
        other question — being paid by somebody NOT on Xetral, in another
        country, out of a message thread.

        BOTH VALUES ARE ON SCREEN, ABOVE THEIR BUTTONS. A Copy button beside
        an em dash is a button that copies nothing and says nothing about why;
        what is shown is what is copied, so a customer can read it back over a
        phone call when the clipboard is not the answer.
      */}
      <div className="card">
        <div className="section-head">
          <h2>Request payment</h2>
        </div>

        <div className="copy-row">
          <span className="copy-label">My Xetral number</span>
          {/*
            THE WHOLE NUMBER, country code and all, because this one is for
            SHARING. `nationalPhone` is right where somebody reads their own
            number back to themselves; here it would hand a sender abroad a
            string with no country in it.
          */}
          <div className="copy-value mono">{displayPhone(phone) || 'Not set'}</div>
          <button
            type="button"
            className="ghost small"
            disabled={phone === null}
            onClick={() => copy(phone ?? '', setCopiedPhone)}
          >
            <Icon name="copy" size={15} /> {copiedPhone ? 'Copied' : 'Copy my number'}
          </button>
        </div>

        <div className="copy-row">
          <span className="copy-label">Share your link to accept payment globally.</span>
          <div className="copy-value mono link">{link ?? 'Not set'}</div>
          <button
            type="button"
            className="ghost small"
            disabled={link === null}
            onClick={() => copy(link ?? '', setCopiedLink)}
          >
            <Icon name="copy" size={15} /> {copiedLink ? 'Copied' : 'Copy payment link'}
          </button>
        </div>

        <FormError error={profile.error} code={profile.code} />
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
