import { z } from 'zod';

/**
 * Request shapes, validated at the boundary.
 *
 * Everything past this point is typed, and these schemas are the only reason
 * that is true: a JSON body arrives as `any` no matter how strict the compiler
 * is configured. Parsing here rather than trusting the declared type is what
 * makes the rest of the module's types statements about reality.
 */

/** Generous upper bounds so a huge body is rejected before it reaches scrypt. */
export const loginSchema = z.object({
  /** Email or phone. Which one it is gets decided by the lookup, not here. */
  identifier: z.string().trim().min(3).max(255),
  password: z.string().min(1).max(512),
  device: z.object({
    /** Opaque client-generated value. Hashed before it is stored. */
    fingerprint: z.string().min(8).max(512),
    platform: z.enum(['ios', 'android', 'web']),
    displayName: z.string().max(120).optional(),
  }),
});

/**
 * Opening an account.
 *
 * Deliberately minimal: an email, a password, and the device. Name, phone and
 * BVN belong to KYC, which is a separate, reviewed step — collecting identity
 * documents on a signup form means holding them for people who never finish
 * signing up.
 */
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(512),
  device: z.object({
    fingerprint: z.string().min(8).max(512),
    platform: z.enum(['ios', 'android', 'web']),
    displayName: z.string().max(120).optional(),
  }),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1).max(512),
});

export type LoginRequest = z.infer<typeof loginSchema>;
export type RegisterRequest = z.infer<typeof registerSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;

/**
 * Changing a password.
 *
 * The current one is required even though the caller is already
 * authenticated: this endpoint is reachable with a stolen access token, and
 * without it a thief could lock the real owner out using the session they
 * took. `max(512)` rather than the policy's maximum because the policy is
 * enforced in one place — @xetral/identity — and a second, looser copy here
 * is how the two drift.
 */
export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(512),
  new_password: z.string().min(1).max(512),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

/**
 * Asking for a reset link.
 *
 * `identifier` rather than `email` so the field matches login's, which is what
 * lets one rate-limit helper read both — and so a customer who signs in with a
 * phone number is not presented with a form asking for something else.
 */
export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3).max(255),
});

/**
 * Finishing one.
 *
 * `max(512)` on the password rather than the policy's real maximum, for the
 * same reason `changePasswordSchema` does it: the policy lives in one place,
 * @xetral/identity, and a second looser copy here is how the two drift.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  new_password: z.string().min(1).max(512),
});

export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
