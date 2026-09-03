import Link from 'next/link';
import { Icon } from './icon';

/**
 * What a customer sees when they reach a product that needs a verified
 * identity.
 *
 * This exists because "kyc_required" as an error message is a dead end. The
 * customer is told to do something, not told why, not told what it unlocks,
 * and given no way to start. Rendered as a NOTICE rather than an error,
 * because nothing has gone wrong: they have simply arrived at the one part of
 * the product that needs more than an email address.
 *
 * It also names what still works. A customer who reads "verify your identity"
 * on a card screen reasonably concludes the whole app is locked, when in fact
 * their wallet, transfers, airtime, data and bills are all available right
 * now — which is most of what they came for.
 */
export function VerifyPrompt({
  what,
  detail,
  /**
   * The heading, when the reason is REGULATORY rather than about a partner.
   *
   * A card is refused because the CBN requires an identified customer, not
   * because an issuer chose to — and telling somebody the rule that binds us
   * is the difference between "they want more forms" and "this is the law".
   */
  title,
  cta,
}: {
  /** The product they were reaching for, in the customer's words. */
  readonly what: string;
  readonly detail?: string | undefined;
  readonly title?: string | undefined;
  readonly cta?: string | undefined;
}) {
  return (
    <section className="card verify-prompt animate-in">
      <span className="verify-icon" aria-hidden="true">
        <Icon name="shield" size={22} />
      </span>

      <div className="verify-body">
        <h2>{title ?? `Verify your identity for ${what}`}</h2>
        <p>
          {detail ??
            `${what} is issued through a licensed partner, who can only issue it to a
             verified person.`}
        </p>
        <p className="hint">
          Your naira wallet, transfers, airtime, data and bills all work without this.
        </p>
        <Link href="/kyc" className="btn">
          {cta ?? 'Verify my identity'}
        </Link>
      </div>
    </section>
  );
}
