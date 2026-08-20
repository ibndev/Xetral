import { z } from 'zod';

/**
 * A gift card code is a bearer instrument, so it travels in the BODY like a
 * transaction PIN — never a query string, which lands in access logs, proxy
 * logs and browser history. `redactPayload` matches on key names, so the field
 * is called `card_code` rather than anything that would slip past it.
 */
export const submitGiftCardSchema = z.object({
  brand: z.string().trim().min(1).max(64),
  /** ISO-3166 alpha-2 of the card's REGION, not the customer's. An Amazon US
   *  code sells at a different rate to an Amazon UK one. */
  country: z.string().trim().length(2).toUpperCase(),
  card_type: z.enum(['ecode', 'physical']),
  /** Major units as a STRING. A JSON number has already lost the argument. */
  face_amount: z.string().trim().min(1).max(32),
  face_currency: z.string().trim().length(3).toUpperCase(),
  card_code: z.string().trim().min(4).max(512),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

export const quoteSchema = z.object({
  brand: z.string().trim().min(1).max(64),
  country: z.string().trim().length(2).toUpperCase(),
  card_type: z.enum(['ecode', 'physical']),
  face_amount: z.string().trim().min(1).max(32),
  face_currency: z.string().trim().length(3).toUpperCase(),
});

export const reviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  /** Required on a rejection; the constraint in SQL says so too, and the
   *  customer is always told why. */
  reason: z.string().trim().min(1).max(512).optional(),
});

export const clawbackSchema = z.object({
  reason: z.string().trim().min(1).max(512),
});

export type SubmitGiftCardBody = z.infer<typeof submitGiftCardSchema>;
export type QuoteBody = z.infer<typeof quoteSchema>;
export type ReviewBody = z.infer<typeof reviewSchema>;
