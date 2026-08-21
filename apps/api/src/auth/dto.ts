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
