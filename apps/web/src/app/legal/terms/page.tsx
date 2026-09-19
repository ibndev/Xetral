import type { Metadata } from 'next';
import { LegalPage } from '@/ui/legal-page';
import { COMPANY, OPEN_COUNTRIES, REGISTERED_ADDRESS } from '@/lib/company';

export const metadata: Metadata = {
  title: 'Terms — Xetral',
  description: 'The terms on which Xetral holds and moves your money.',
};

/**
 * The terms of service.
 *
 * DESCRIBING WHAT THE SYSTEM DOES, rather than everything a lawyer could think
 * of. The sections that matter to a customer — what happens when something
 * goes wrong, what cannot be undone, and how to complain — are written from
 * the flows that actually exist, including their deadlines. A terms page
 * promising a resolution the code has no mechanism for is a promise broken by
 * construction.
 *
 * IT SAID "resident in Nigeria", AND THAT STOPPED BEING TRUE. Ghana and Kenya
 * have been open since 040's seed, so a customer in Accra was accepting terms
 * that described them as ineligible for the account they were opening.
 * `OPEN_COUNTRIES` is the one list, beside the company details.
 *
 * NOTHING HERE IS LEGAL ADVICE, and the go-live checklist still requires a
 * Nigerian lawyer to read it. Being accurate about the product is a different
 * thing from being complete as a contract.
 */
export default function Terms() {
  return (
    <LegalPage title="Terms of service" updated="19 September 2026">
      <p className="legal-lede">
        These are the terms on which <strong>{COMPANY.legalName}</strong> of{' '}
        {REGISTERED_ADDRESS} (&ldquo;{COMPANY.tradingName}&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;) holds and moves your money. Opening
        an account means accepting them. Please read the part about what cannot
        be undone.
      </p>

      <h2>Who can open an account</h2>
      <p>
        You must be 18 or over, resident in a country we serve —{' '}
        {OPEN_COUNTRIES.join(', ')} — and able to complete identity
        verification. An account is personal to you. You may not let anybody
        else use it, you may not open one on behalf of somebody else, and you
        may not hold more than one.
      </p>

      <h2>Your money</h2>
      <p>
        Money in your {COMPANY.tradingName} wallet is money we owe you. We hold
        it with our banking and payment partners; it is not a deposit with{' '}
        {COMPANY.tradingName}, it is not insured as a bank deposit is, and it
        does not earn interest. Your balance is what our ledger says it is, and
        that ledger is append-only — a mistake is corrected by a new entry that
        reverses the old one, never by editing history.
      </p>

      <h2>Keeping your account safe</h2>
      <p>
        Your transaction PIN authorises money leaving your account. Keep it to
        yourself: unlocking it with your face or fingerprint is a convenience on
        your own device and does not replace it. We will never ask you for your
        PIN, your password or a verification code — by email, by phone or by
        message. Anybody who does is not us.
      </p>
      <p>
        Tell us immediately if you think somebody else has access. You do not
        have to wait for us: you can sign out every other device yourself, from{' '}
        <strong>Security</strong> in the app.
      </p>

      <h2>What you may not do with the account</h2>
      <p>
        You may not use {COMPANY.tradingName} for anything illegal, to launder
        money, to fund terrorism, or to evade sanctions. You may not use it on
        somebody else&rsquo;s behalf without telling us, give us false
        information, or attempt to interfere with the service or gain access to
        an account that is not yours. We may refuse or reverse a transaction,
        and close an account, where any of this applies.
      </p>

      <h2>Limits</h2>
      <p>
        There are limits on how much you can send in a day, how many transfers
        you can make in an hour, and how many people you can pay for the first
        time in a day. Your daily limit depends on how far your identity has
        been verified, and you can see your own limits in the app rather than
        discovering them at the moment of a transfer.
      </p>
      <p>
        They exist to cap what somebody else could take if they got into your
        account. If a transfer is refused for one of these reasons we tell you,
        because a refusal you did not cause is the first sign that something is
        wrong.
      </p>

      <h2>Fees and rates</h2>
      <p>
        Fees are shown before you confirm anything and are charged at that
        moment. Currency conversion is quoted before you accept it and includes
        our margin; if the rate moves before you confirm, the transaction is
        refused rather than completed at a rate you did not see. We may change
        our fees, and we will tell you in the app before a change takes effect.
      </p>

      <h2>When something goes wrong</h2>
      <p>
        If a transaction on your account is wrong — you did not make it, you did
        not receive what you paid for, the amount is wrong, or you were charged
        twice — raise a dispute in the app. You do not need your PIN to do it,
        deliberately: the person most likely to raise one has just found
        somebody else in their account.
      </p>
      <p>
        We acknowledge it immediately and answer within <strong>72 hours</strong>.
        If we uphold your dispute we refund you; if we do not, we tell you why.
        Raising a dispute does not itself move money, and it does not stop you
        using your account.
      </p>
      <p>
        If you are not satisfied with our answer, write to{' '}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>, and you may
        escalate to the Central Bank of Nigeria&rsquo;s Consumer Protection
        Department.
      </p>

      <h2>Things we cannot undo</h2>
      <p>Some things are final once they happen, and it is worth knowing which:</p>
      <ul>
        <li>
          <strong>A crypto withdrawal.</strong> Once it is on the chain it
          cannot be recalled, by us or by anybody. Check the address.
        </li>
        <li>
          <strong>A transfer to the wrong {COMPANY.tradingName} account.</strong>{' '}
          We cannot take money back out of somebody else&rsquo;s wallet on our
          own authority. We will help you contact them.
        </li>
        <li>
          <strong>A mobile money or bank transfer that has been sent.</strong>{' '}
          Once the receiving institution has it, getting it back depends on
          them and on the person who received it.
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
        money moving; it does not take your money, and your balance remains owed
        to you. We tell you when we do it unless the law prevents us — and where
        it does, the law also prevents us from telling you why.
      </p>

      <h2>Closing your account</h2>
      <p>
        You may close your account at any time once your balance is zero, from{' '}
        <strong>Settings &rarr; Your data</strong> in the app or by writing to{' '}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>. We may close an
        account by giving you notice, and immediately where we are required to.
        We keep the records the law requires us to keep — see the{' '}
        <a href="/legal/privacy">privacy notice</a> for exactly what, for how
        long and why.
      </p>

      <h2>Availability</h2>
      <p>
        We do not promise the service will always be available. Providers have
        outages and so do we. Where a transaction is interrupted, our practice
        is to hold the money rather than guess: we would rather leave a payment
        pending and reconcile it than refund something that was delivered or
        deliver something twice.
      </p>

      <h2>What we are responsible for</h2>
      <p>
        We are responsible for holding your money accurately and for moving it
        as you instructed. We are not responsible for losses caused by you
        giving us the wrong details, by somebody you gave your PIN to, or by an
        outage at a bank, a mobile money network or a blockchain. Nothing in
        these terms limits our liability for fraud, or for anything the law does
        not allow us to limit.
      </p>

      <h2>The app itself</h2>
      <p>
        The {COMPANY.tradingName} app and everything in it belongs to us. You
        may use it to operate your own account and for nothing else — not to
        copy it, take it apart, or build something from it.
      </p>

      <h2>Changing these terms</h2>
      <p>
        We will tell you in the app before a change takes effect. If you do not
        accept a change you may close your account, and we will not charge you
        for doing so.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the Federal Republic of Nigeria,
        and the courts of Nigeria have jurisdiction over any dispute.
      </p>

      <p className="legal-contact">
        <strong>{COMPANY.legalName}</strong>
        <br />
        {COMPANY.addressLine}
        <br />
        {COMPANY.city}, {COMPANY.country}
        <br />
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
      </p>
    </LegalPage>
  );
}
