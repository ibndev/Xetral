import type { Metadata } from 'next';
import { LegalPage } from '@/ui/legal-page';
import { RETENTION_ROWS } from '@/lib/retention-table';
import { COMPANY, OPEN_COUNTRIES, REGISTERED_ADDRESS } from '@/lib/company';
import { NON_PROCESSORS, PROCESSORS } from '@/lib/processors';

export const metadata: Metadata = {
  title: 'Privacy — Xetral',
  description:
    'What Xetral collects, why, who receives it, how long it is kept, and how to get a copy or have it erased.',
};

/**
 * The privacy notice.
 *
 * WRITTEN FROM THE SYSTEM, NOT FROM A TEMPLATE, and every part of this page
 * that could drift is bound to something that cannot. The retention table is
 * rendered from `RETENTION_ROWS`, and a test fails the build if any period
 * disagrees with the setting the deletion job reads. The processor tables are
 * rendered from `PROCESSORS`, and a test fails the build if a name there has
 * no adapter. The company details come from `COMPANY`, so the six bracketed
 * placeholders this page used to publish cannot be reintroduced one at a time.
 *
 * IT IS ALSO A PLAY STORE ARTEFACT. Google requires the notice to be at a
 * public, stable, non-editable URL that is not behind a sign-in, to name the
 * developer, to describe collection, use, sharing, retention and security, and
 * to tell a customer how to delete their account and data. `LegalPage` is a
 * server component with no session precisely so this page renders when the API
 * does not — the document a reviewer asks for cannot be taken down by an
 * outage.
 */
export default function Privacy() {
  return (
    <LegalPage title="Privacy notice" updated="19 September 2026">
      <p className="legal-lede">
        This notice explains what {COMPANY.tradingName} collects about you, why,
        who else sees it, how long it is kept and what you can ask us to do with
        it. It describes what the system actually does: the retention table is
        generated from the same configuration the deletion job reads, and the
        list of companies that receive your data is checked against the code
        that sends it.
      </p>

      <h2>Who we are</h2>
      <p>
        {COMPANY.tradingName} is operated by <strong>{COMPANY.legalName}</strong>{' '}
        of <strong>{REGISTERED_ADDRESS}</strong>. We are the data controller for
        everything described here, and we are responsible for it under the
        Nigeria Data Protection Act 2023.
      </p>
      <p>
        For anything about your data — a copy, a correction, an erasure, or a
        complaint — write to <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>.
        A person reads it, and we answer within 30 days.
      </p>

      <h2>What we collect, and why</h2>
      <dl className="legal-defs">
        <dt>Who you are</dt>
        <dd>
          Your name, date of birth, address, phone number, email address and
          your Bank Verification Number. Nigerian law requires us to verify
          these before you can hold money, receive an account number or be
          issued a card, and we cannot offer those services without them. You
          type them in: there is no document upload and the app never opens
          your camera.
        </dd>

        <dt>What you do with your money</dt>
        <dd>
          Every transfer, purchase, deposit, card payment and currency
          conversion, with the amount, the currency, the time and who it was
          to or from. This is the record of what we owe you, so it exists for as
          long as your account does.
        </dd>

        <dt>How you sign in</dt>
        <dd>
          The devices you use, when they were used, and the network address and
          country they connected from. This is what makes it possible to tell
          you that somebody else has signed in, and to let you sign them out.
        </dd>

        <dt>Your phone, if you turn on notifications</dt>
        <dd>
          An address your handset generates so we can send you a notification.
          It identifies the installation, not you, and it stops working when you
          uninstall the app.
        </dd>

        <dt>What breaks</dt>
        <dd>
          When something fails we record the fault and the kind of page it
          happened on — never who you are. Error records are grouped by the bug
          rather than by the customer, deliberately, so that fixing a fault does
          not require reading anybody&rsquo;s account.
        </dd>
      </dl>

      <p>
        We do not use your data for advertising. We do not sell it, rent it or
        share it for anybody else&rsquo;s marketing. There is no advertising
        identifier in the app, no analytics service and no tracking of what you
        do in other apps or on other websites. We do not make automated
        decisions that have a legal effect on you; the fraud checks described
        below can refuse a single transaction, and a person reviews anything
        beyond that.
      </p>

      <h2>What we deliberately do not hold</h2>
      <dl className="legal-defs">
        <dt>Your card number</dt>
        <dd>
          There is no column in our database that could hold one. When you tap
          to see your card details we fetch them from the card issuer, show them
          to you and drop them. We record that it happened, never what it
          showed.
        </dd>

        <dt>Your transaction PIN or password</dt>
        <dd>
          Both are stored as one-way hashes. Nobody at {COMPANY.tradingName} can
          read them and we cannot recover one for you — we can only help you set
          a new one.
        </dd>

        <dt>Your fingerprint or face</dt>
        <dd>
          If you unlock the app with biometrics, that happens entirely on your
          phone. Your device tells us only that it agreed to release your PIN.
          The biometric data never leaves your handset and we never see it.
        </dd>
      </dl>

      <h2>What we rely on to use it</h2>
      <dl className="legal-defs">
        <dt>To perform our contract with you</dt>
        <dd>
          Holding your balance, moving your money, and everything you asked us
          to do.
        </dd>
        <dt>To meet a legal obligation</dt>
        <dd>
          Verifying your identity, keeping records, monitoring for money
          laundering and reporting where we are required to.
        </dd>
        <dt>Our legitimate interests</dt>
        <dd>
          Preventing fraud, keeping accounts secure, and keeping the service
          working. We do not rely on this for anything you would not expect.
        </dd>
        <dt>Your consent</dt>
        <dd>
          Only for optional things, such as marketing messages. You can withdraw
          it at any time in <strong>Settings</strong>, in as few taps as it took
          to give, and withdrawing it never affects your account or your money.
        </dd>
      </dl>

      <h2>How long we keep it</h2>
      <p>
        Two rules pull in opposite directions here, and both are law. Nigeria&rsquo;s
        anti-money-laundering rules require records of a customer relationship to
        be kept for five years after it ends. The Nigeria Data Protection Act
        requires that personal data is not kept for longer than it is needed. So
        different things have different answers, and this table is generated
        from the settings the deletion job actually reads:
      </p>

      <div className="legal-rows" role="table" aria-label="How long we keep each kind of data">
        <div className="legal-rows-head" role="row">
          <span role="columnheader">What</span>
          <span role="columnheader">How long</span>
          <span role="columnheader">Why</span>
        </div>
        {RETENTION_ROWS.map((row) => (
          <div className="legal-row" role="row" key={row.what}>
            <span className="legal-row-what" role="rowheader">{row.what}</span>
            <span className="legal-row-period" role="cell">{row.period}</span>
            <span className="legal-row-why" role="cell">{row.why}</span>
          </div>
        ))}
      </div>

      <h2>Who else sees it</h2>
      <p>
        We share the least we can with the companies that actually move your
        money and deliver what you buy. Each receives only what its part of the
        transaction requires, may use it only to do that job for us, and may not
        use it for anything of their own.
      </p>

      <div className="legal-rows" role="table" aria-label="Companies that receive your data">
        <div className="legal-rows-head" role="row">
          <span role="columnheader">Who</span>
          <span role="columnheader">For what</span>
          <span role="columnheader">What reaches them</span>
        </div>
        {PROCESSORS.map((p) => (
          <div className="legal-row" role="row" key={p.name}>
            <span className="legal-row-what" role="rowheader">{p.name}</span>
            <span className="legal-row-period" role="cell">{p.purpose}</span>
            <span className="legal-row-why" role="cell">{p.receives}</span>
          </div>
        ))}
      </div>

      <p>
        <strong>
          Your date of birth, your address and your Bank Verification Number
          are not sent to any of them.
        </strong>{' '}
        Verification happens here, against details encrypted here and reviewed
        by our own staff. No provider is given them.
      </p>

      <p>
        Some companies appear in the app without receiving anything that
        identifies you, and we would rather say so than let a short list imply
        otherwise:
      </p>

      <div className="legal-rows" role="table" aria-label="Companies that receive nothing identifying">
        <div className="legal-rows-head" role="row">
          <span role="columnheader">Who</span>
          <span role="columnheader">For what</span>
          <span role="columnheader">What reaches them</span>
        </div>
        {NON_PROCESSORS.map((p) => (
          <div className="legal-row" role="row" key={p.name}>
            <span className="legal-row-what" role="rowheader">{p.name}</span>
            <span className="legal-row-period" role="cell">{p.purpose}</span>
            <span className="legal-row-why" role="cell">{p.receives}</span>
          </div>
        ))}
      </div>

      <p>
        We also disclose information to the Central Bank of Nigeria, the Nigerian
        Financial Intelligence Unit, the Nigeria Data Protection Commission, a
        court, or law enforcement, where we are legally required to. Where the
        law forbids us from telling you about such a disclosure, we do not.
      </p>

      <h2>Where it is held</h2>
      <p>
        Your data is stored on servers in the European Union, with encrypted
        backups held off those servers and readable only with a key the hosting
        provider does not have. Several of the companies above process data
        outside Nigeria; where they do, the transfer relies on the contractual
        protections the Nigeria Data Protection Act requires, and we only use a
        provider willing to sign them.
      </p>

      <h2>What you can ask for</h2>
      <dl className="legal-defs">
        <dt>A copy</dt>
        <dd>
          Everything we hold about you, in one file. In the app:{' '}
          <strong>Settings &rarr; Your data &rarr; Download a copy</strong>. It
          asks for your transaction PIN, because that one file is every balance,
          every transaction and every place you have signed in from.
        </dd>
        <dt>A correction</dt>
        <dd>
          If something is wrong. You can edit your own name in{' '}
          <strong>Settings</strong>; a verified name or number is corrected by a
          person, because changing it after it was checked would make the check
          meaningless.
        </dd>
        <dt>Erasure</dt>
        <dd>
          Ask in <strong>Settings &rarr; Your data &rarr; Ask us to erase it</strong>,
          or write to{' '}
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>. A person
          decides, and the answer names exactly what was deleted and what we are
          required to keep — with the date it stops being kept. We cannot erase
          an account that still holds money or is under investigation; we will
          tell you that rather than refusing without a reason.
        </dd>
        <dt>To object, or to withdraw consent</dt>
        <dd>
          At any time, for anything we rely on consent for. Some services cannot
          continue without the data they need, and we will say which.
        </dd>
        <dt>To complain</dt>
        <dd>
          To us first, at <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>,
          and to the Nigeria Data Protection Commission if you are not satisfied
          with our answer.
        </dd>
      </dl>

      {/*
        A REAL ANCHOR, because Google asks for a WEB route to account deletion
        that works without installing the app, and the Play listing links
        straight to this section. A heading with no id makes that link land at
        the top of a long page and leaves a reviewer hunting.
      */}
      <h2 id="deleting-your-account">Deleting your account</h2>
      <p>
        You can ask us to close your account and erase your data from{' '}
        <strong>Settings &rarr; Your data</strong> in the app, or by writing to{' '}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> from the address
        on your account. Withdraw or transfer your balance first — we cannot
        erase the record of money we still owe you.
      </p>
      <p>
        What goes: your name, contact details, address, date of birth,
        the Bank Verification Number we hold, your device and sign-in history,
        and your saved recipients. What stays: the
        transaction records anti-money-laundering law requires us to keep for
        five years after the relationship ends, and a record that the account
        existed so that the same email address cannot quietly open a second one.
        We tell you which is which, and when the rest is due to go.
      </p>

      <h2>Children</h2>
      <p>
        {COMPANY.tradingName} is not for anybody under 18 and we do not knowingly
        collect data about children. Identity verification is what enforces this
        rather than a tick box. If you believe a child has an account, write to{' '}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> and we will close
        it.
      </p>

      <h2>Keeping it safe</h2>
      <p>
        Sensitive values are encrypted with keys that can be rotated, and your
        Bank Verification Number is sealed with its own key on top of that. Access to customer
        records requires a second factor, and every privileged action is written
        to a log that cannot be edited or deleted, including by us. Sign-in
        sessions rotate their credentials on every use, and a credential
        presented twice is treated as stolen and revoked everywhere — on every
        device signed in with it.
      </p>
      <p>
        No system is perfect. If personal data is ever exposed in a way that is
        likely to harm you, we will tell you and the Nigeria Data Protection
        Commission within the time the Act requires.
      </p>

      <h2>Changes</h2>
      <p>
        When this notice changes we will tell you in the app before the change
        takes effect, and the date at the top is the last time it was updated.
        Where a change needs your agreement we will ask for it rather than
        assume it.
      </p>

      <p className="legal-contact">
        <strong>{COMPANY.legalName}</strong>
        <br />
        {COMPANY.addressLine}
        <br />
        {COMPANY.city}, {COMPANY.country}
        <br />
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
        <br />
        <span className="hint">
          Currently serving customers in {OPEN_COUNTRIES.join(', ')}.
        </span>
      </p>
    </LegalPage>
  );
}
