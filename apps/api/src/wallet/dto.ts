import { z } from 'zod';

/**
 * WHAT A CUSTOMER MAY SEND TO ANOTHER CUSTOMER.
 *
 * Four, and BTC is deliberately not among them: an internal transfer is a
 * ledger movement between two wallets, and these four are the ones the
 * platform actually holds customer balances in. Adding one is adding
 * it to `TRANSFER_CURRENCIES` in `@xetral/client` too — `wallet-currencies.
 * test.ts` fails the build if the two disagree, because a currency a client
 * offers and this refuses is a form that 400s on a field the customer filled
 * in correctly.
 */
const TRANSFER_CURRENCIES = ['NGN', 'USD', 'USDT', 'USDC'] as const;

/**
 * WHAT A CUSTOMER MAY READ THE HISTORY OF.
 *
 * It was `['NGN', 'USD']`, which meant `GET /v1/wallets/transactions` answered
 * `400 invalid_request` for every crypto balance the platform has ever held —
 * a customer with USDT could see the number on the home screen and could not
 * see a single transaction behind it. Nothing caught it because the only
 * client offered exactly the two currencies the schema accepted, so the two
 * halves were wrong together. The same shape as the `TRON` casing bug.
 *
 * Wider than the transfer list, and that is right: money can ARRIVE in a
 * currency a customer cannot send from, and it must still be readable.
 */
const HISTORY_CURRENCIES = ['NGN', 'USD', 'USDT', 'USDC', 'BTC'] as const;

/**
 * The entry kinds a customer can narrow their activity to.
 *
 * A closed enum rather than free text, so the query cannot ask for a kind
 * that does not exist and read as an empty history rather than a mistake.
 * Gift cards settle in NAIRA, so "Gift" is a filter on what happened and not
 * on which currency it happened in — which is why this exists at all rather
 * than the client passing `currency=GIFT` to a schema that has no such thing.
 */
const HISTORY_KINDS = ['giftcard_purchase', 'giftcard_hold_release'] as const;

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
  currency: z.enum(TRANSFER_CURRENCIES),
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
  currency: z.enum(HISTORY_CURRENCIES).default('NGN'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().regex(/^\d+$/).optional(),
  /**
   * Comma-separated, because it arrives in a query string and repeating a key
   * is ambiguous across HTTP clients. Every element is checked against the
   * enum, so an unknown kind is a 400 rather than a silently empty page.
   */
  kinds: z
    .string()
    .optional()
    .transform((raw) => (raw === undefined ? undefined : raw.split(',').filter((k) => k !== '')))
    .pipe(z.array(z.enum(HISTORY_KINDS)).min(1).optional()),
});

export type TransferRequest = z.infer<typeof transferSchema>;
