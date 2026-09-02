'use client';

import Link from 'next/link';
import type { ApiErrorCode } from '@xetral/client';
import { Icon } from '@/ui/icon';

/**
 * A staff screen that refused, and WHY.
 *
 * Every `/v1/admin/` route is gated on a role read fresh from the database,
 * and a screen whose call is refused rendered one line: "You do not have
 * access to that." — under an otherwise complete page with empty tables. That
 * is indistinguishable from a working screen with nothing in it, which is how
 * Prices, Providers and Provider keys were all reported as "empty" when two of
 * the three were in fact refusing.
 *
 * So the refusal names the role, and says who can grant it. The first `admin`
 * grant is necessarily an INSERT — there is no admin to make it — and after
 * that every role is granted on the Staff screen, which is where this points.
 *
 * The role is a prop rather than something parsed out of the response: the API
 * deliberately does not say which role was missing, because that is a fact
 * about our authorisation model and the caller has already been told no.
 */
export function AdminError({
  error,
  code,
  role,
}: {
  readonly error: string | undefined;
  readonly code: ApiErrorCode | undefined;
  /** The role this screen's data needs, from `auth/routes.ts`. */
  readonly role?: string;
}) {
  if (error === undefined) return null;

  /*
   * THE FACTOR COMES BEFORE THE ROLE, and this is the refusal a new operator
   * actually meets. Every /v1/admin/ route answers `totp_not_enrolled` until
   * an authenticator is confirmed, whatever roles the account holds — so
   * without this the dashboard reads as sixteen broken screens.
   */
  if (code === 'totp_not_enrolled') {
    return (
      <div className="notice warn">
        <p>
          <Icon name="lock" size={16} /> This dashboard needs a second factor,
          and your account has not set one up yet.
        </p>
        <p className="hint">
          Set it up on <Link href="/admin/security">Your authenticator</Link>. Every
          screen here asks for it, reads included.
        </p>
      </div>
    );
  }

  if (code === 'forbidden' && role !== undefined) {
    return (
      <div className="notice warn">
        <p>
          <Icon name="lock" size={16} /> This screen needs the{' '}
          <strong className="mono">{role}</strong> role, and your account does not
          have it.
        </p>
        <p className="hint">
          Somebody with <span className="mono">admin</span> can grant it on{' '}
          <Link href="/admin/staff">Staff</Link>. It applies on your next page load.
        </p>
      </div>
    );
  }

  return (
    <p className="error">
      <Icon name="alert" size={16} /> {error}
    </p>
  );
}
