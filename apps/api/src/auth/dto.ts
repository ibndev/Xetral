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
 * An email, a password, a name, a phone and where the customer is. It used to
 * be the first two, and the comment here argued that a name and a phone
 * "belong to KYC" — which conflated two different things and cost the product
 * both of them.
 *
 * A BVN and a document scan do belong to KYC: holding those for somebody who
 * never finishes signing up is a liability, and that argument still stands.
 * A NAME AND A PHONE NUMBER ARE NOT THAT. They are how a customer is greeted
 * and how they are reached, every service asks for them, and without a country
 * the home screen cannot know whether to lead with naira or cedis.
 *
 * `full_name` here is NOT the verified name and no money decision may read it.
 * The verified one is `kyc_submissions.full_name`, written by a reviewed step;
 * this one is what somebody typed about themselves. Keeping them apart is what
 * lets the greeting be personal on day one without implying a check that has
 * not happened.
 */
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(512),
  full_name: z.string().trim().min(2).max(120),
  /**
   * ISO 3166-1 alpha-2. Validated against `countries` at registration, so a
   * customer cannot be recorded somewhere the platform is not open — and the
   * refusal is the same for "no such country" and "not open there", because a
   * signup form that distinguished them would publish the roadmap.
   */
  country: z.string().trim().toUpperCase().length(2).regex(/^[A-Z]{2}$/),
  /**
   * NATIONAL digits only — no plus, no country code. The dialling code comes
   * from the country the customer chose, and joining them server-side is what
   * stops `+234` and `234` and `0803...` being three different customers in a
   * column with a UNIQUE index on it.
   */
  phone: z.string().trim().regex(/^[0-9]{4,15}$/),
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

/** Confirming an enrolment, and every acting staff request. */
export const totpCodeSchema = z.object({
  totp_code: z.string().trim().regex(/^[0-9]{6}$/),
});

export type TotpCodeRequest = z.infer<typeof totpCodeSchema>;

/**
 * Choosing a payment handle.
 *
 * Deliberately LOOSE on shape: the service normalises a pasted `@` and a
 * phone keyboard's capital before testing the real pattern, and 039's CHECK
 * is what finally decides. A strict regex here would refuse `@Olawale` — a
 * handle copied from a message, which is the commonest way one is typed —
 * with a field error rather than accepting what the customer plainly meant.
 *
 * `transaction_pin` is read by `AuthGuard`, not by this handler; it is named
 * here so `.strict()` does not refuse the body carrying it.
 */
export const chooseHandleSchema = z
  .object({
    handle: z.string().trim().min(1).max(32),
    transaction_pin: z.string().optional(),
  })
  .strict();

export type ChooseHandleRequest = z.infer<typeof chooseHandleSchema>;
