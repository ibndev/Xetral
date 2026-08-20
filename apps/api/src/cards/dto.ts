import { z } from 'zod';

/** Amounts are major-unit STRINGS for the same reason as transfers: a JSON
 *  number has already settled the precision question, badly. */
export const issueCardSchema = z.object({
  name_on_card: z.string().trim().min(2).max(64),
  initial_funding: z.string().trim().min(1).max(32),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

export const fundCardSchema = z.object({
  amount: z.string().trim().min(1).max(32),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

/** Freeze carries no PIN: it is the protective action, and asking a customer
 *  whose card is being used fraudulently to remember a PIN first is hostile.
 *  Unfreeze and terminate DO require one — see routes.ts. */
export const pinOnlySchema = z.object({
  transaction_pin: z.string().min(1).max(32),
});
