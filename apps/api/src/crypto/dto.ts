import { z } from 'zod';

const NETWORKS = ['bitcoin', 'ethereum', 'tron', 'bsc'] as const;
const ASSETS = ['BTC', 'USDT', 'USDC'] as const;

export const addressSchema = z.object({
  asset: z.enum(ASSETS),
  network: z.enum(NETWORKS),
});

export const quoteSchema = z.object({
  asset: z.enum(ASSETS),
  network: z.enum(NETWORKS),
  /** Major units as a STRING. */
  amount: z.string().trim().min(1).max(32),
});

export const withdrawSchema = z.object({
  asset: z.enum(ASSETS),
  network: z.enum(NETWORKS),
  /** Where it is going. Validated against the chain's checksum before
   *  anything is committed — a wrong one cannot be undone. */
  destination: z.string().trim().min(20).max(128),
  /** Required by some chains; sending without it loses the money there. */
  memo: z.string().trim().min(1).max(64).optional(),
  amount: z.string().trim().min(1).max(32),
  /**
   * The largest fee the customer agreed to, in major units.
   *
   * Optional but strongly advised: network fees move between the quote and
   * the request, and without a ceiling a customer can be charged materially
   * more than the number they approved.
   */
  max_fee: z.string().trim().min(1).max(32).optional(),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

export type AddressBody = z.infer<typeof addressSchema>;
export type CryptoQuoteBody = z.infer<typeof quoteSchema>;
export type WithdrawBody = z.infer<typeof withdrawSchema>;
