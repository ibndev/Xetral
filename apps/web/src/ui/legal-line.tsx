import Link from 'next/link';
import { LEGAL_ENTITY } from '@/lib/company';

/**
 * The contracting party and its three documents, in one line.
 *
 * ON EVERY PAGE A STRANGER CAN REACH WITHOUT AN ACCOUNT — sign in, sign up,
 * a payment link — because that is where a payment partner's reviewer, and a
 * payer deciding whether to trust a link, look for who they are dealing with.
 * The name and registration number come from `company.ts` and nowhere else, so
 * the website cannot state them two ways.
 */
export function LegalLine({ className = '' }: { className?: string }) {
  return (
    <p className={`legal-line ${className}`.trim()}>
      <span>{LEGAL_ENTITY}</span>
      <span className="legal-line-links">
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/refunds">Refunds</Link>
      </span>
    </p>
  );
}
