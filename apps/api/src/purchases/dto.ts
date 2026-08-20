import { z } from 'zod';

export const purchaseSchema = z.object({
  service: z.enum(['airtime', 'data', 'utility', 'esim', 'number']),
  /** The provider's product code. For VTpass this is `serviceID:variation`. */
  item_code: z.string().trim().min(1).max(128),
  /** Phone number, meter number, or country code. */
  target: z.string().trim().min(1).max(64),
  /** Major units as a STRING — a JSON number has already lost the argument. */
  amount: z.string().trim().min(1).max(32),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

export const catalogueQuerySchema = z.object({
  service: z.enum(['airtime', 'data', 'utility', 'esim', 'number']),
  group: z.string().trim().min(1).max(64).optional(),
});

export const verifyTargetSchema = z.object({
  service: z.enum(['airtime', 'data', 'utility', 'esim', 'number']),
  item_code: z.string().trim().min(1).max(128),
  target: z.string().trim().min(1).max(64),
});

export type PurchaseRequestBody = z.infer<typeof purchaseSchema>;
