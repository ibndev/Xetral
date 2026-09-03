import { z } from 'zod';

/**
 * What a customer may ask for.
 *
 * `.strict()` throughout. Zod strips unknown keys by default, so without it a
 * field a client believes it is sending — a beneficiary name, an amount in the
 * wrong unit — is silently ignored rather than refused, and the request
 * succeeds while meaning something else.
 */

/**
 * A Nigerian account number is ten digits, and other corridors differ. The
 * range is deliberately wider than NUBAN and the real check is the LOOKUP: a
 * number that passes any format test can still belong to a stranger, and only
 * the bank can say whose it is.
 */
const accountNumber = z.string().trim().regex(/^[0-9]{6,20}$/);

export const lookupQuerySchema = z
  .object({
    country: z.string().trim().length(2).toUpperCase(),
    bank_code: z.string().trim().min(1).max(32),
    account_number: accountNumber,
  })
  .strict();

export type LookupQuery = z.infer<typeof lookupQuerySchema>;

export const banksQuerySchema = z
  .object({ country: z.string().trim().length(2).toUpperCase() })
  .strict();

export const payoutSchema = z
  .object({
    country: z.string().trim().length(2).toUpperCase(),
    bank_code: z.string().trim().min(1).max(32),
    account_number: accountNumber,
    /**
     * DELIBERATELY ABSENT: the beneficiary's name.
     *
     * The service re-fetches it from the bank rather than accepting one here.
     * Anything a client can send is something an attacker holding a stolen
     * session can send, so a name supplied by the caller would make the
     * confirmation screen a formality — and the whole value of the lookup is
     * that it produces a claim the sender did not author.
     */
    currency: z.string().trim().length(3).toUpperCase(),
    /** Major units, as a STRING. By the time a decimal is a JS number the
     *  precision is already gone. */
    amount: z.string().trim().min(1).max(32),
    narration: z.string().trim().max(100).optional(),
    /** Belongs to the ATTEMPT: generated when the form mounts and reused
     *  across retries, never generated inside a submit handler. */
    idempotency_key: z.string().trim().min(8).max(128),
    /** Verified by `AuthGuard` before the handler runs, because this route
     *  declares `pin: true`. Present here so the body validates. */
    transaction_pin: z.string().min(4).max(12),
  })
  .strict();

export type PayoutBody = z.infer<typeof payoutSchema>;
