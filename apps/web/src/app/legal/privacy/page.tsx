import type { Metadata } from 'next';
import { LegalPage } from '@/ui/legal-page';
import { RETENTION_ROWS } from '@/lib/retention-table';

export const metadata: Metadata = {
  title: 'Privacy — Xetral',
  description: 'What Xetral collects, why, how long it is kept, and what you can ask for.',
};

/**
 * The privacy notice.
 *
 * WRITTEN FROM THE SCHEMA, NOT FROM A TEMPLATE, and that is the only thing
 * about this page worth reviewing. A notice assembled from a template
 * describes what somebody intended; the gap between that and what the system
 * does opens silently and stays open for years. The retention table below is
 * rendered from `RETENTION_ROWS`, and a test fails the build if any period
 * there disagrees with the setting the deletion job actually reads.
 *
 * BEFORE PUBLISHING, an operator must replace the three bracketed values: the
 * registered company name and address, the data protection officer's contact
 * address, and the NDPC registration reference. They are left visible rather
 * than guessed, because inventing a registration number is worse than an
 * obvious blank.
 */
export default function Privacy() {
  return (
    <LegalPage title="Privacy notice" updated="25 August 2026">
      <p>
        This notice explains what Xetral collects about you, why, how long it is
        kept and what you can ask us to do with it. It is written to match what
        the system actually does — the retention table below is generated from
        the same configuration the deletion job reads.
      </p>

      <h2>Who we are</h2>
      <p>
        Xetral is operated by <strong>[registered company name]</strong>,{' '}
        <strong>[registered address]</strong>. We are the data controller for
        the information described here. Our data protection officer can be
        reached at <strong>[dpo@ address]</strong>, and we are registered with
        the Nigeria Data Protection Commission under{' '}
        <strong>[NDPC registration reference]</strong>.
      </p>

      <h2>What we collect, and why</h2>
      <ul>
        <li>
          <strong>Who you are.</strong> Your name, date of birth, address,
          phone number, email and the identity document you upload. We are
          required to collect and verify these before you can hold money,
          receive an account number or be issued a card. We cannot offer those
          services without them.
        </li>
        <li>
          <strong>What you do with your money.</strong> Every transfer,
          purchase, deposit, card payment and currency conversion. This is the
          record of what we owe you, so it exists for as long as your account
          does.
        </li>
        <li>
          <strong>How you sign in.</strong> The devices you use, when they were
          used and the network address they connected from. This is what makes
          it possible to tell you that somebody else has signed in, and to let
          you sign them out.
        </li>
        <li>
          <strong>What breaks.</strong> When something fails we record the
          error and the page it happened on — not who you are. Error records
          are deliberately grouped by the fault rather than by the customer.
        </li>
      </ul>
      <p>
        We do not use your data for advertising, we do not sell it, and we do
        not profile you for anything other than fraud prevention and the legal
        obligations described below.
      </p>

      <h2>What we deliberately do not hold</h2>
      <ul>
        <li>
          <strong>Your card number.</strong> There is no place in our database
          that can hold one. When you tap to see your card details we fetch
          them from the card issuer, show them to you and drop them. We record
          that it happened, never what it showed.
        </li>
        <li>
          <strong>Your transaction PIN or password.</strong> Both are stored as
          one-way hashes. Nobody at Xetral can read them, and we cannot recover
          one for you — we can only help you set a new one.
        </li>
        <li>
          <strong>Your fingerprint or face.</strong> If you unlock the app with
          biometrics, that happens entirely on your phone. Your device tells us
          only that it agreed to release your PIN; we never see the biometric
          data itself.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        Two rules pull in opposite directions here, and both are law. Nigeria's
        anti-money-laundering rules require records of a customer relationship
        to be kept for five years after it ends. The Nigeria Data Protection
        Act requires that personal data is not kept for longer than it is
        needed. So different things have different answers:
      </p>

      <div className="legal-table-wrap">
        <table className="legal-table">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">How long</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {RETENTION_ROWS.map((row) => (
              <tr key={row.what}>
                <th scope="row">{row.what}</th>
                <td>{row.period}</td>
                <td>{row.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Who else sees it</h2>
      <p>
        We share the minimum necessary with the companies that actually move
        your money and deliver what you buy: Bitnob (account numbers, cards,
        crypto and currency conversion), VTpass (airtime, data and bills),
        Airalo (eSIMs), Twilio (phone numbers) and Resend (email). Each receives
        only what its part of the transaction requires. We also disclose
        information to the Central Bank of Nigeria, the NFIU and law enforcement
        where we are legally required to.
      </p>

      <h2>Where it is held</h2>
      <p>
        Your data is stored on servers in the European Union, with encrypted
        backups held off those servers. Some of the providers listed above
        process data outside Nigeria; where they do, that transfer relies on the
        contractual protections the NDPA requires.
      </p>

      <h2>What you can ask for</h2>
      <ul>
        <li><strong>A copy</strong> of the personal data we hold about you.</li>
        <li><strong>A correction</strong>, if something is wrong.</li>
        <li>
          <strong>Deletion</strong> — though not of the records we are legally
          required to keep. We will tell you plainly which is which rather than
          refusing the whole request.
        </li>
        <li>
          <strong>To object</strong>, or to withdraw consent where we relied on
          it. Some services cannot continue without the data they need.
        </li>
        <li>
          <strong>To complain</strong> to the Nigeria Data Protection
          Commission if you are not satisfied with our answer.
        </li>
      </ul>
      <p>
        Write to <strong>[dpo@ address]</strong>. We answer within 30 days.
      </p>

      <h2>Keeping it safe</h2>
      <p>
        Sensitive values are encrypted with keys that can be rotated. Access to
        customer records requires a second factor, and every privileged action
        is written to a log that cannot be edited or deleted, including by us.
        Sign-in sessions rotate their credentials on every use, and a credential
        presented twice is treated as stolen and revoked everywhere.
      </p>

      <h2>Changes</h2>
      <p>
        When this notice changes we will tell you in the app before the change
        takes effect. The date at the top is the last time it was updated.
      </p>
    </LegalPage>
  );
}
