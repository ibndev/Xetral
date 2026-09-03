import Link from 'next/link';
import { Icon } from './icon';

/**
 * What a customer sees when they reach a product that needs a verified
 * identity.
 *
 * ONE LINE AND ONE BUTTON. This used to carry three paragraphs — what the
 * partner does, what the Central Bank requires, how long it takes, and which
 * other features still work — and every one of them was true and none of them
 * was what the customer needed. A person who has just tapped "Create card"
 * wants to know what to do next, and reading four sentences to find a button
 * is slower than the verification itself.
 */
export function VerifyPrompt({
  what,
  /**
   * The line, when the reason is REGULATORY rather than about a partner.
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
        <Link href="/kyc" className="btn">
          {cta ?? 'Verify my identity'}
        </Link>
      </div>
    </section>
  );
}
