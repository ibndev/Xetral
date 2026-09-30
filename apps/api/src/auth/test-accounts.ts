import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiConfig } from '../config.js';

/**
 * WHICH ACCOUNTS ARE TEST ACCOUNTS — the operator's list, read from the
 * environment and nowhere else (`config.testAccounts`).
 *
 * Two things hang off it and nothing more: an administrator may RESET such an
 * account so its email and phone register again, and a signup on one accepts
 * `TEST_OTP` in place of the emailed code. Every other customer's signup and
 * every other delete path are exactly as they were.
 */

/** An address on the list. Compared lower-cased, as `users_email_unique` is. */
export function isTestEmail(config: ApiConfig, email: string | undefined): boolean {
  if (email === undefined) return false;
  return config.testAccounts.emails.includes(email.trim().toLowerCase());
}

/** A phone on the list, given in E.164 as it is stored. */
export function isTestPhone(config: ApiConfig, phone: string | undefined): boolean {
  if (phone === undefined) return false;
  return config.testAccounts.phones.includes(phone);
}

/**
 * Whether `code` is the fixed test code AND the signup is a test account's.
 *
 * Both halves or neither: with no `TEST_OTP` set nothing is accepted, and the
 * code is worthless on an address the list does not name — so a leaked value
 * opens nothing but a test account. Compared as digests so the lengths always
 * match and the time says nothing.
 */
export function acceptsTestOtp(
  config: ApiConfig,
  code: string | undefined,
  who: { readonly email?: string | undefined; readonly phone?: string | undefined },
): boolean {
  const otp = config.testAccounts.otp;
  if (otp === undefined || code === undefined) return false;
  if (!isTestEmail(config, who.email) && !isTestPhone(config, who.phone)) return false;
  const a = createHash('sha256').update(code, 'utf8').digest();
  const b = createHash('sha256').update(otp, 'utf8').digest();
  return timingSafeEqual(a, b);
}
