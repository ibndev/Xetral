import Link from 'next/link';
import { Icon } from './icon';
import type { ApiErrorCode } from '@xetral/client';

/**
 * A refusal, with the way out of it where there is one.
 *
 * "Set a transaction PIN before moving money" was rendered as a line of red
 * text under a button, and that is where the customer stopped. It is a true
 * sentence and a dead end: they have been told the name of a thing they do not
 * have, on a screen that cannot give it to them, with no indication that it
 * lives under Account → Transaction PIN. The same shape as `kyc_required`
 * before `VerifyPrompt` existed.
 *
 * So a code that HAS a next step gets a control that goes there. Everything
 * else renders exactly as before — this is not an invitation to attach a
 * button to every error, and most refusals genuinely have nowhere to send
 * somebody.
 *
 * `pin_locked` deliberately has no action: the only thing that resolves it is
 * fifteen minutes, and a button leading somewhere would imply otherwise. Nor
 * does `transaction_pin_required` — the customer has a PIN and left the box
 * empty, so the field in front of them already is the next step.
 */
const NEXT_STEP: Partial<Record<ApiErrorCode, { href: string; label: string }>> = {
  pin_not_set: { href: '/settings#transaction-pin', label: 'Set a transaction PIN' },
  kyc_required: { href: '/kyc', label: 'Verify my identity' },
  // The operations dashboard refuses every screen with this until an
  // authenticator is confirmed, and there was nowhere to go and do it.
  totp_not_enrolled: { href: '/admin/security', label: 'Set up my authenticator' },
};

export function FormError({
  error,
  code,
}: {
  readonly error: string | undefined;
  readonly code: ApiErrorCode | undefined;
}) {
  if (error === undefined) return null;
  const next = code === undefined ? undefined : NEXT_STEP[code];

  return (
    <div className="form-error">
      <p className="error">
        <Icon name="alert" size={16} /> {error}
      </p>
      {next !== undefined && (
        <Link href={next.href} className="btn small">
          {next.label}
        </Link>
      )}
    </div>
  );
}
