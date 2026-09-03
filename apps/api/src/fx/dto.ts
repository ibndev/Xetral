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

const movement = {
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
  idempotency_key: z.string().trim().min(8).max(128),
};

/**
 * CONVERTING TAKES NO PIN, AND REMITTING DOES — which is why these are two
 * schemas on two routes rather than one with an optional recipient.
 *
 * A PIN is the second factor for money LEAVING the account. Converting naira
 * to dollars moves a customer's own money between their own wallets: nothing
 * leaves, nobody else can receive it, and the balance afterwards is the same
 * balance in another denomination. Demanding the secret that authorises
 * payments in order to do that teaches people to type it for things that are
 * not payments, which is the habit an attacker asking for it relies on.
 *
 * Remitting is a different act with the same arithmetic in front of it: the
 * converted money lands in SOMEBODY ELSE'S wallet, and that is a payment.
 *
 * The split is structural rather than a branch inside the service. One route
 * declares `pin: false` and its schema HAS NO RECIPIENT FIELD, so the path
 * that skips the PIN cannot grow the ability to reach a stranger — not by a
 * later edit, and not by a caller sending a field the handler happens to
 * forward. `route-coverage.test.ts` audits the policy; this makes the policy
 * and the payload agree.
 */
/*
 * STRICT, and that is not tidiness.
 *
 * Zod STRIPS unknown keys by default, so a `recipient` sent to this route
 * would be silently dropped and the customer would convert into their own
 * wallet believing they had paid somebody. Nothing would fail: the money is
 * safe, the response is a 200, and the person who was supposed to receive it
 * never hears. Refusing the field is the difference between "we ignored what
 * you asked for" and "that is not what this endpoint does".
 */
export const convertSchema = z.object(movement).strict();

export const remitSchema = z.object({
  ...movement,
  /** Whose wallet the converted money lands in. A handle, an email address, a
   *  phone number or a payment link — the same resolver a transfer uses. */
  recipient: z.string().trim().min(3).max(320),
  transaction_pin: z.string().min(1).max(32),
});

export type FxQuoteBody = z.infer<typeof fxQuoteSchema>;
export type ConvertBody = z.infer<typeof convertSchema>;
export type RemitBody = z.infer<typeof remitSchema>;
