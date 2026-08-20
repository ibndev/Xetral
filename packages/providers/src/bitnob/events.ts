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

/**
 * Deposit events on a dedicated Nigerian account.
 *
 * CONFIRM BEFORE GO-LIVE alongside the card names above, and settled the same
 * way — by the first real event. An unrecognised event THROWS and is retried
 * rather than acknowledged, so a wrong name here is a loud, repeating failure
 * and never a deposit silently dropped. That property is what makes shipping
 * with unconfirmed names safe rather than reckless.
 */
export const BITNOB_FUNDING_EVENTS = {
  depositReceived: 'virtualaccount.deposit.completed',
  depositReversed: 'virtualaccount.deposit.reversed',
} as const;

export type BitnobFundingEventName =
  (typeof BITNOB_FUNDING_EVENTS)[keyof typeof BITNOB_FUNDING_EVENTS];

/**
 * A credit landing on a customer's dedicated account.
 *
 * `amount` is `unknown` for the same reason card amounts are: it is narrowed
 * by the one audited conversion in ngn-amounts.ts, and a schema that accepted
 * `z.number()` would hand over a value JSON.parse had already rounded.
 *
 * The sender fields are PERSONAL DATA from the sending bank. They are recorded
 * for AML and never logged.
 */
export const depositPayload = z.object({
  id: z.string().min(1),
  /** Bitnob's id for the account the money landed on. */
  virtual_account_id: z.string().min(1).optional(),
  /** The NUBAN, when the payload identifies the account that way instead. */
  account_number: z.string().min(1).optional(),
  amount: z.unknown(),
  currency: z.string().min(1),
  sender_name: z.string().optional(),
  sender_bank: z.string().optional(),
  sender_account_number: z.string().optional(),
});

export const bitnobDepositEnvelope = z.object({
  event_id: z.string().min(1),
  event: z.string().min(1),
  created_at: z.string().min(1),
  data: depositPayload,
});

export type BitnobDepositEnvelope = z.infer<typeof bitnobDepositEnvelope>;

/**
 * On-chain events.
 *
 * CONFIRM BEFORE GO-LIVE with the rest. Unrecognised events throw and are
 * retried, so a wrong name is loud and repeating rather than a deposit that
 * silently never happened.
 *
 * Note that a crypto deposit is TWO events, not one, for the same reason a
 * card spend is: the moment a transaction is seen and the moment it is
 * irreversible are different moments, and a system that cannot express the gap
 * has to lie about one of them.
 */
export const BITNOB_CRYPTO_EVENTS = {
  depositSeen: 'crypto.deposit.pending',
  depositConfirmed: 'crypto.deposit.confirmed',
  withdrawalConfirmed: 'crypto.withdrawal.confirmed',
  withdrawalFailed: 'crypto.withdrawal.failed',
} as const;

export const cryptoDepositPayload = z.object({
  id: z.string().min(1),
  address: z.string().min(1),
  chain: z.string().min(1),
  currency: z.string().min(1),
  /** Narrowed by the one conversion boundary, never by the schema. */
  amount: z.unknown(),
  tx_hash: z.string().min(1),
  output_index: z.number().int().nonnegative().nullish(),
  confirmations: z.number().int().nonnegative(),
});

export const bitnobCryptoEnvelope = z.object({
  event_id: z.string().min(1),
  event: z.string().min(1),
  created_at: z.string().min(1),
  data: cryptoDepositPayload,
});

export type BitnobCryptoEnvelope = z.infer<typeof bitnobCryptoEnvelope>;

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
