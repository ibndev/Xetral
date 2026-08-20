import { z } from 'zod';

/**
 * The amount is a STRING in major units, and that is load-bearing.
 *
 * `{"amount": 5000.10}` is a JSON number, and by the time it has been through
 * JSON.parse the precision question is already settled — badly. Taking it as
 * text and handing it to `fromMajor` means the decimal is parsed exactly once,
 * by the module that knows how many places the currency has.
 */
export const transferSchema = z.object({
  /** Email or phone. Which one is decided by the lookup, not here. */
  recipient: z.string().trim().min(3).max(255),
  amount: z.string().trim().min(1).max(32),
  currency: z.enum(['NGN', 'USD']),
  /** Verified by AuthGuard before the handler runs; declared so the schema
   *  does not strip it and so its absence is a clear 400. */
  transaction_pin: z.string().min(1).max(32),
  /**
   * Client-generated and stable across retries. Required, not optional: this
   * moves money, and a retry without one is how one transfer becomes two.
   */
  idempotency_key: z.string().trim().min(8).max(128),
});

export const setPinSchema = z.object({
  pin: z.string().min(1).max(32),
  /** Required when a PIN already exists. Enforced in the service, because only
   *  it knows whether one does. */
  current_pin: z.string().min(1).max(32).optional(),
});

export const historyQuerySchema = z.object({
  currency: z.enum(['NGN', 'USD']).default('NGN'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().regex(/^\d+$/).optional(),
});

export type TransferRequest = z.infer<typeof transferSchema>;
