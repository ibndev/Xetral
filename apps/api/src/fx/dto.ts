import { z } from 'zod';

/** The currencies a customer can hold. Crypto converts through the crypto
 *  routes; this is fiat-to-fiat and fiat-to-stablecoin. */
const CONVERTIBLE = ['NGN', 'USD', 'GBP', 'EUR', 'USDT'] as const;

export const fxQuoteSchema = z.object({
  from: z.enum(CONVERTIBLE),
  to: z.enum(CONVERTIBLE),
  /** Major units as a STRING. */
  amount: z.string().trim().min(1).max(32),
});

export const convertSchema = z.object({
  from: z.enum(CONVERTIBLE),
  to: z.enum(CONVERTIBLE),
  amount: z.string().trim().min(1).max(32),
  /**
   * The least the customer will accept, in major units of `to`.
   *
   * Rates move between the quote and the request. Without a floor a customer
   * can accept one number and receive a materially worse one — the mirror of
   * the crypto withdrawal's fee ceiling, and the same reasoning.
   */
  min_received: z.string().trim().min(1).max(32).optional(),
  /** Present makes this a REMITTANCE: the converted money lands in somebody
   *  else's wallet. */
  recipient: z.string().trim().min(3).max(320).optional(),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

export type FxQuoteBody = z.infer<typeof fxQuoteSchema>;
export type ConvertBody = z.infer<typeof convertSchema>;
