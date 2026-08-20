import { z } from 'zod';

/**
 * Bitnob's webhook event names and payload shapes.
 *
 * Two details that are easy to get wrong and expensive to discover late:
 *
 *  - The suffix is `.completed`, NOT `.complete`. A handler keyed on the wrong
 *    spelling silently receives nothing, which looks exactly like a provider
 *    that is not sending events.
 *  - JSON keys are snake_case. Camel-casing them produces `undefined` amounts,
 *    and `undefined` in a money path is how a posting of zero gets written.
 *
 * Both are asserted in webhooks.test.ts rather than trusted to this comment.
 */

export const BITNOB_EVENTS = {
  cardAuthorization: 'card.authorization.completed',
  cardSettlement: 'card.settlement.completed',
  cardAuthorizationExpired: 'card.authorization.expired',
  cardRefund: 'card.refund.completed',
  cardDeclined: 'card.transaction.declined',
} as const;

export type BitnobEventName = (typeof BITNOB_EVENTS)[keyof typeof BITNOB_EVENTS];

/**
 * The amount is left as `unknown` here and narrowed by `parseMicro` in
 * amounts.ts, deliberately.
 *
 * Zod's `z.number()` would accept 12345678901234567 — a value JSON.parse has
 * already rounded — and hand it over looking valid. Routing every amount
 * through the one conversion boundary means the "this arrived as an unsafe
 * float" check cannot be bypassed by a schema that seemed reasonable.
 */
const amountField = z.unknown();

/**
 * `display_amount` is a float and appears in Bitnob's payloads. It is NOT in
 * this schema and NOT carried into the domain event: there is deliberately no
 * path by which it can reach a posting. The webhook tests prove it by sending a
 * deliberately wrong one and asserting the ledger amount ignores it.
 */
export const cardTransactionPayload = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  /** Bitnob's customer reference. Mapped to our user id by the caller. */
  customer_id: z.string().min(1),
  amount: amountField,
  currency: z.string().min(1),
  merchant: z.string().optional(),
  /** Present on settlement, naming the authorization it settles. */
  authorization_id: z.string().optional(),
  reason: z.string().optional(),
});

export const bitnobWebhookEnvelope = z.object({
  /** The natural source for `idempotency_key`. Formatted as
   *  `bitnob:<event_id>` so two providers issuing the same opaque id cannot
   *  collide in the ledger's UNIQUE constraint. */
  event_id: z.string().min(1),
  event: z.string().min(1),
  created_at: z.string().min(1),
  data: cardTransactionPayload,
});

export type BitnobWebhookEnvelope = z.infer<typeof bitnobWebhookEnvelope>;
