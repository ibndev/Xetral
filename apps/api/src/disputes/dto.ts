import { z } from 'zod';

/**
 * Raising a dispute.
 *
 * The entry is named by its UUID, never by its numeric id. Sequential ids are
 * guessable, and a complaints form that accepts one is a way to probe which
 * entries exist — the database refuses a claim against an entry the customer
 * has no leg in, but the shape of the refusal should not be the only thing
 * standing between a stranger and that answer.
 */
export const raiseDisputeSchema = z.object({
  entry_id: z.string().uuid(),
  reason: z.enum(['not_authorised', 'not_received', 'wrong_amount', 'duplicate']),
  /** The customer's own account, in their words. Bounded to match the CHECK,
   *  so an over-long one is refused with a field name rather than a 500. */
  detail: z.string().trim().min(1).max(2000),
});

export const withdrawDisputeSchema = z.object({
  /** Why they are withdrawing it. Required, because a claim that vanished
   *  with no explanation is indistinguishable from one somebody deleted. */
  resolution: z.string().trim().min(1).max(2000),
});

/**
 * Resolving one, which is a STAFF action.
 *
 * `refund_amount` is a major-unit STRING, like every other amount that crosses
 * this boundary. By the time a decimal is a JSON number the precision is gone,
 * and this is the one field on this endpoint that moves money.
 *
 * It is present only for an acceptance. An amount on a rejection would be a
 * refund the decision did not authorise, sitting in a payload one careless
 * `if` away from being posted.
 */
export const resolveDisputeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('accepted'),
    resolution: z.string().trim().min(1).max(2000),
    refund_amount: z.string().trim().min(1).max(32),
    /** The attempt's key, so a reviewer whose click timed out and clicked
     *  again refunds once. Belongs to the attempt, not to the handler. */
    idempotency_key: z.string().trim().min(8).max(128),
    transaction_pin: z.string().min(1).max(32),
  }),
  z.object({
    outcome: z.literal('rejected'),
    resolution: z.string().trim().min(1).max(2000),
    transaction_pin: z.string().min(1).max(32),
  }),
]);
