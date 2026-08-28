/**
 * Telling a customer something happened.
 *
 * WHY THIS IS A PORT AND NOT A FUNCTION THAT CALLS AN API. Rule 3, the same as
 * every other provider — but the reason is sharper here than it looks. An email
 * provider is the component most likely to be swapped under pressure: a
 * deliverability problem with security mail is discovered at the worst possible
 * moment, when customers cannot get back into their accounts, and the remedy is
 * to move providers that day. Behind a port that is an adapter and a
 * configuration change.
 *
 * THE RETRY RULE HERE IS THE OPPOSITE OF THE MONEY RULE, DELIBERATELY.
 *
 * Everywhere else in this codebase a timeout means do nothing and reconcile:
 * `ProviderTimeoutError` is not retryable because we do not know whether the
 * provider acted, and the naive retry is how one card funding becomes two.
 *
 * A notification inverts both halves of that. Sending twice costs a customer a
 * duplicate email; NOT sending costs them the password reset they are waiting
 * on, or the alert that somebody else just signed into their account. The
 * asymmetry runs the other way, so a notification IS retried — and the
 * provider's own idempotency key keeps a retry from actually duplicating.
 *
 * This is worth stating explicitly because the instinct trained by the rest of
 * the codebase is exactly wrong for this one port.
 */

/**
 * What a message is FOR, which is what decides how hard we try to deliver it.
 *
 * Not a formatting concern. `security` mail is the mail a customer needs in
 * order to keep control of their account, and it is retried longer and alerted
 * on when it fails. A receipt that never arrives is a support ticket; a
 * password reset that never arrives is a customer locked out of their money.
 */
export type NotificationClass = 'security' | 'transactional';

export interface NotificationMessage {
  /** A single address. Batching is deliberately not modelled: every message
   *  this platform sends is addressed to one person about their own account. */
  readonly to: string;
  readonly subject: string;
  /** Both parts are required. A security email that renders as a blank message
   *  in a text-only client is a customer who cannot reset their password. */
  readonly text: string;
  readonly html: string;
  /**
   * OURS, not the provider's.
   *
   * The outbox row id is the natural source: a worker that crashes between
   * sending and recording the send retries the same row, and the provider
   * recognises the repeat rather than mailing the customer twice.
   */
  readonly idempotencyKey: string;
}

export interface NotificationReceipt {
  /** The provider's own id, kept so a deliverability question can be traced
   *  back to one specific message rather than to "some email that day". */
  readonly providerMessageId: string;
}

export interface NotificationPort {
  readonly provider: string;
  /**
   * Throws a `ProviderError` on failure, classified by whether a retry could
   * help — the worker reads `retryable` and nothing else.
   */
  send(message: NotificationMessage): Promise<NotificationReceipt>;
}
