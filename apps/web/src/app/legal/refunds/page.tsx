import type { Metadata } from 'next';
import { LegalPage } from '@/ui/legal-page';
import { COMPANY, LEGAL_ENTITY, REGISTERED_ADDRESS } from '@/lib/company';

export const metadata: Metadata = {
  title: 'Refunds — Xetral',
  description: 'When and how Xetral Ltd refunds a payment or cancels a service.',
};

/**
 * The refund and service cancellation policy.
 *
 * PUBLISHED BECAUSE THE ACQUIRER ASKED FOR IT, and written to what the system
 * does. The payment half describes flows that exist — a failed transfer is
 * returned automatically, a dispute is answered within 72 hours, a payment
 * the provider cannot place is held rather than guessed at — because a
 * refund policy promising something the code has no mechanism for is a
 * promise broken by construction, the argument the terms page makes.
 *
 * THE SERVICES HALF covers the software development and IT consulting work
 * the business is registered with its acquirer for: milestone-billed projects
 * and monthly retainers. It is contract terms rather than product behaviour,
 * so a signed statement of work overrides it where the two differ — and says
 * so, because a policy that silently lost to a contract would be a promise
 * nobody could rely on.
 *
 * NOT A CONSENT DOCUMENT. The terms incorporate it by reference, and it has
 * no version in `consent_documents`: nothing here asks a customer to agree
 * again. NOTHING HERE IS LEGAL ADVICE; a lawyer reads it before it is relied on.
 */
export default function Refunds() {
  return (
    <LegalPage title="Refund and Cancellation Policy" updated="28 September 2026">
      <p className="legal-lede">
        This policy explains when <strong>{COMPANY.legalName}</strong>{' '}
        (registration number <strong>{COMPANY.registrationNumber}</strong>) of{' '}
        {REGISTERED_ADDRESS} (&ldquo;{COMPANY.tradingName}&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;) refunds money, how services can be
        cancelled, and how long each takes. It forms part of our{' '}
        <a href="/legal/terms">terms of service</a>.
      </p>

      <h2>1. Payments and wallet services</h2>
      <dl className="legal-defs">
        <dt>A transfer or payout that fails</dt>
        <dd>
          If a transfer to a bank account or mobile money wallet is refused or
          returned by the receiving institution, the full amount — including any
          fee charged for it — goes back to your {COMPANY.tradingName} wallet
          automatically. You do not need to ask.
        </dd>
        <dt>A payment whose outcome is not yet known</dt>
        <dd>
          Where a provider has not yet confirmed whether a payment arrived, we
          hold the money rather than guess. Once the provider confirms it failed,
          it is returned to your wallet; if it confirms it arrived, it is not
          refunded, because it was delivered.
        </dd>
        <dt>A charge you did not make, or a wrong amount</dt>
        <dd>
          Raise a dispute in the app. We answer within <strong>72 hours</strong>;
          if we uphold it, the amount is refunded to your wallet the same day.
        </dd>
        <dt>A duplicate payment</dt>
        <dd>
          If you were charged twice for one payment — funding your wallet, or
          paying somebody&rsquo;s payment link — write to us within{' '}
          <strong>30 days</strong>. Once we confirm the duplicate with our payment
          partner, it is refunded to the card, bank account or wallet it came
          from.
        </dd>
        <dt>Paying somebody&rsquo;s payment link</dt>
        <dd>
          A payment made to another person&rsquo;s link is a payment to them.
          If you paid the wrong amount or no longer want what you paid for, ask
          the person you paid for a refund. We refund it ourselves only where the
          payment failed, was duplicated, or was not authorised by you.
        </dd>
        <dt>Bills, airtime, data and eSIMs</dt>
        <dd>
          A purchase the provider did not deliver is refunded to your wallet. A
          delivered token, top-up or eSIM cannot be refunded, because it has
          been used or can be.
        </dd>
        <dt>Currency conversion</dt>
        <dd>
          A completed conversion cannot be cancelled. You may convert back, at
          the rate quoted at that time.
        </dd>
        <dt>Fees</dt>
        <dd>
          Fees are shown before you confirm and are not refunded for a
          completed transaction. A fee charged in error, or on a transaction
          that failed, is refunded with it.
        </dd>
      </dl>

      <h2>2. Software development projects (milestone billing)</h2>
      <p>
        {COMPANY.legalName} provides software development services to business
        clients under a written statement of work that divides the project into
        milestones, each with a price, a deliverable and acceptance criteria.
      </p>
      <dl className="legal-defs">
        <dt>Cancelling before work on a milestone begins</dt>
        <dd>
          Either party may cancel by written notice. Any amount paid for a
          milestone on which work has not started is refunded in full.
        </dd>
        <dt>Cancelling while a milestone is in progress</dt>
        <dd>
          You pay for work done up to the date of the notice, charged in
          proportion to the milestone completed and shown on a written statement
          of time and deliverables. Any amount paid beyond that is refunded, and
          we hand over the work completed to that date.
        </dd>
        <dt>Accepted milestones</dt>
        <dd>
          A milestone you have accepted, or that is treated as accepted because
          you raised no objection within <strong>10 business days</strong> of
          delivery, is not refundable.
        </dd>
        <dt>A milestone that does not meet its acceptance criteria</dt>
        <dd>
          We correct it at no charge. If we cannot make it meet the criteria
          within <strong>30 days</strong> of your written notice of the defect,
          you may reject it and the amount paid for that milestone is refunded in
          full.
        </dd>
        <dt>Deposits</dt>
        <dd>
          An upfront deposit is applied to the first milestone and is refundable
          on the same terms as that milestone.
        </dd>
      </dl>

      <h2>3. IT consulting retainers</h2>
      <dl className="legal-defs">
        <dt>How a retainer is billed</dt>
        <dd>
          A retainer is billed monthly in advance, for an agreed number of hours
          or an agreed scope of support.
        </dd>
        <dt>Cancelling a retainer</dt>
        <dd>
          You may cancel at any time with <strong>30 days&rsquo;</strong> written
          notice. The retainer continues until the notice period ends, and no
          further months are billed after it.
        </dd>
        <dt>Months paid in advance</dt>
        <dd>
          Any month paid for that begins after your notice period ends is
          refunded in full.
        </dd>
        <dt>Unused hours</dt>
        <dd>
          Hours not used within a month do not carry over and are not refunded,
          unless your agreement says otherwise.
        </dd>
        <dt>If we cancel</dt>
        <dd>
          If we end a retainer for any reason other than your breach, we refund
          the unused part of the current month in proportion to the days
          remaining.
        </dd>
      </dl>
      <p>
        Where a signed statement of work or retainer agreement sets different
        cancellation or refund terms, that agreement applies.
      </p>

      <h2>4. How to ask for a refund or cancel</h2>
      <p>
        Write to <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> from the
        email address on your account or on your agreement, with the reference
        of the payment, invoice or statement of work concerned. For a wallet
        transaction you can also raise a dispute in the app.
      </p>

      <h2>5. How long a refund takes</h2>
      <ul>
        <li>
          <strong>To your {COMPANY.tradingName} wallet:</strong> the same day we
          approve it, and immediately for a failed transfer.
        </li>
        <li>
          <strong>To a card, bank account or mobile money wallet:</strong> we
          start it within <strong>5 business days</strong> of approving it. Your
          bank, card issuer or network may then take up to{' '}
          <strong>10 business days</strong> to show it.
        </li>
        <li>
          <strong>For services:</strong> within <strong>14 business days</strong>{' '}
          of the date the refund is agreed, to the account the payment came from.
        </li>
      </ul>
      <p>
        Refunds are made in the currency and by the method you paid with. We do
        not refund to a different person or to an account that did not make the
        payment.
      </p>

      <h2>6. Chargebacks</h2>
      <p>
        Please contact us before asking your bank for a chargeback — most
        problems are resolved faster that way. If a chargeback is raised on a
        payment we have already refunded, we will provide evidence of the refund
        to the card network.
      </p>

      <p className="legal-contact">
        <strong>{LEGAL_ENTITY}</strong>
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
