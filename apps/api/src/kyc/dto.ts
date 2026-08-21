import { z } from 'zod';

/**
 * Identity verification.
 *
 * The BVN is the most sensitive identifier a Nigerian fintech holds. It
 * travels in the body, is sealed before it reaches a row, and is never
 * returned — only its last four digits, which is enough for support to
 * confirm a customer is talking about the right one.
 */
export const kycSchema = z.object({
  full_name: z.string().trim().min(3).max(160),
  /** ISO date. Age is checked in the service, where the rule can be stated. */
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'expected a phone number'),
  bvn: z.string().trim().regex(/^[0-9]{11}$/, 'a BVN is 11 digits'),
  address: z.string().trim().min(10).max(500),
});

export const kycReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(3).max(500).optional(),
});

export type KycBody = z.infer<typeof kycSchema>;
export type KycReviewBody = z.infer<typeof kycReviewSchema>;
