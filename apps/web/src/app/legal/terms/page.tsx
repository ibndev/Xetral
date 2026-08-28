import type { Metadata } from 'next';
import { LegalPage } from '@/ui/legal-page';

export const metadata: Metadata = {
  title: 'Terms — Xetral',
  description: 'The terms on which Xetral holds and moves your money.',
};

/**
 * The terms of service.
 *
 * DELIBERATELY SHORT, and describing what the system does rather than
 * everything a lawyer could think of. The sections that matter to a customer
 * — what happens when something goes wrong, and how to complain — are written
 * from the dispute flow that actually exists, including its deadline. A terms
 * page promising a resolution the code has no mechanism for is a promise we
 * would break by construction.
 *
 * BEFORE PUBLISHING, an operator must replace the bracketed values and have
 * this reviewed by a Nigerian lawyer. It is written to be accurate about the
 * product, which is a different thing from being complete as a contract.
 */
export default function Terms() {
  return (
    <LegalPage title="Terms of service" updated="25 August 2026">
      <p>
        These are the terms on which <strong>[registered company name]</strong>{' '}
        (&ldquo;Xetral&rdquo;, &ldquo;we&rdquo;) holds and moves your money.
        Opening an account means accepting them.
      </p>

      <h2>Who can open an account</h2>
      <p>
        You must be 18 or over, resident in Nigeria, and able to complete
        identity verification. An account is personal to you. You may not let
        anybody else use it, and you may not open one on behalf of somebody
        else.
      </p>

      <h2>Your money</h2>
      <p>
        Money in your Xetral wallet is money we owe you. We hold it with our
        banking and payment partners; it is not a deposit with Xetral and it
        does not earn interest. Your balance is what our ledger says it is, and
        that ledger is append-only — a mistake is corrected by a new entry that
        reverses the old one, never by editing history.
      </p>

      <h2>Keeping your account safe</h2>
      <p>
        Your transaction PIN authorises money leaving your account. Keep it to
        yourself: unlocking it with your face or fingerprint is a convenience on
        your own device and does not replace it. Tell us immediately if you
        think somebody else has access — you can sign out every other device
        yourself, from Security in the app, without waiting for us.
      </p>

      <h2>Limits</h2>
      <p>
        There are limits on how much you can send in a day, how many transfers
        you can make in an hour, and how many people you can pay for the first
        time in a day. They exist to cap what somebody else could take if they
        got into your account. If a transfer is refused for one of these
        reasons we will email you, because a refusal you did not cause is the
        first sign that something is wrong.
      </p>

      <h2>Fees and rates</h2>
      <p>
        Fees are shown before you confirm anything and are charged at that
        moment. Currency conversion is quoted before you accept it and includes
        our margin; if the rate moves before you confirm, the transaction is
        refused rather than completed at a different rate.
      </p>

      <h2>When something goes wrong</h2>
      <p>
        If a transaction on your account is wrong — you did not make it, you did
        not receive what you paid for, the amount is wrong, or you were charged
        twice — raise a dispute in the app. You do not need your PIN to do it.
      </p>
      <p>
        We acknowledge it immediately and answer within{' '}
        <strong>72 hours</strong>. If we uphold your dispute we refund you; if
        we do not, we tell you why. Raising a dispute does not itself move
        money, and it does not stop you using your account.
      </p>
      <p>
        If you are not satisfied with our answer you may escalate to the
        Central Bank of Nigeria's Consumer Protection Department.
      </p>

      <h2>Things we cannot undo</h2>
      <p>
        Some things are final once they happen, and it is worth knowing which:
      </p>
      <ul>
        <li>
          <strong>A crypto withdrawal.</strong> Once it is on the chain it
          cannot be recalled, by us or by anybody. Check the address.
        </li>
        <li>
          <strong>A transfer to the wrong Xetral account.</strong> We cannot
          take money back out of somebody else's wallet on our own authority.
          We will help you contact them.
        </li>
        <li>
          <strong>A terminated card.</strong> Its number stops working at the
          issuer and cannot be restored.
        </li>
      </ul>

      <h2>When we may suspend an account</h2>
      <p>
        We may freeze an account where we are required to, or where we have
        reasonable grounds to suspect fraud or money laundering. Freezing stops
        money moving; it does not take your money, and your balance remains
        owed to you. We tell you when we do it unless the law prevents us.
      </p>

      <h2>Closing your account</h2>
      <p>
        You may close your account at any time once your balance is zero. We
        keep the records the law requires us to keep — see the{' '}
        <a href="/legal/privacy">privacy notice</a> for how long and why.
      </p>

      <h2>Availability</h2>
      <p>
        We do not promise the service will always be available. Providers have
        outages and so do we. Where a transaction is interrupted, our practice
        is to hold the money rather than guess: we would rather leave a payment
        pending and reconcile it than refund something that was delivered or
        deliver something twice.
      </p>

      <h2>Changing these terms</h2>
      <p>
        We will tell you in the app before a change takes effect. If you do not
        accept a change you may close your account.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the Federal Republic of Nigeria.
      </p>
    </LegalPage>
  );
}
