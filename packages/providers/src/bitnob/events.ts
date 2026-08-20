import { z } from 'zod';

/**
 * Bitnob's webhook event names and payload shapes.
 *
 * CONFIRM BEFORE GO-LIVE — THE ONE OPEN ITEM IN THE CODEBASE, and it is
 * blocked rather than merely unfinished. Everything else Bitnob-shaped in this package was
 * checked against their official Node SDK (endpoint paths, request casing,
 * the HMAC-SHA512 webhook signature). The SDK does not define events, and
 * their documentation site is not reachable from this environment.
 *
 * It also cannot be settled by reading alone: card issuing requires Bitnob's
 * approval before any card exists, so the first real authorization webhook is
 * only observable once that approval lands. Confirming these names is
 * therefore part of enabling issuing, not a prerequisite for it — the same
 * dependency PHASES.md records against Phase 5.
 *
 * STATUS: Bitnob registration is UNDER REVIEW. Nothing here can be closed
 * until it clears, so this marker stays. When it does clear, the first live
 * authorization settles the two names below and this comment goes with it.
 *
 * What is known: Bitnob's virtual-card webhooks use a `virtualcard.transaction.*`
 * family, including `.debit`, `.reversed` and `.declined`. What is NOT known is
 * how AUTHORIZATION and SETTLEMENT are named — the two-phase distinction this
 * whole module is built around — so the names below remain the working
 * assumption they always were.
 *
 * WHY THAT IS SAFE TO SHIP. An unrecognised event does not fall through: the
 * `default` arm in webhooks.ts throws, the controller does not acknowledge,
 * and Bitnob retries. A wrong name here therefore produces loud, retried
 * failures and never a silently dropped spend — which is the failure mode
 * worth designing for when the contract is uncertain.
 *
 * One detail that IS settled and easy to get wrong: JSON keys are snake_case.
 * Camel-casing them produces `undefined` amounts, and `undefined` in a money
 * path is how a posting of zero gets written. Asserted in webhooks.test.ts
 * rather than trusted to this comment.
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
