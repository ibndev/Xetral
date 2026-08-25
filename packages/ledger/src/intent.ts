import type { Currency, Money } from '@xetral/shared';
import { InvalidEntryError } from './errors.js';

/**
 * What an adapter produces instead of writing to the ledger.
 *
 * Rule 1 of this codebase is that only the Ledger writes postings. An adapter
 * that called INSERT directly would be the shortest path from a provider
 * webhook to money moving, and that is exactly why it must not exist: the
 * ledger's invariants are enforced in one place, and a second writer is a
 * second set of assumptions about them.
 *
 * So an adapter translates a provider event into a *request* for a journal
 * entry, and hands it over. It names accounts by ROLE rather than by id,
 * because an adapter has no business knowing which row is which — resolving a
 * role to an account is the ledger's job, and it is where the "one account per
 * (kind, currency)" rule lives.
 */

/**
 * Mirrors the `entry_kind` enum in 001_ledger.sql. Kept as a literal union
 * rather than imported from anywhere, because the SQL enum is the source of
 * truth and a drifted value must fail at the type level here rather than as a
 * constraint violation at 3am.
 */
export type EntryKind =
  | 'wallet_funding'
  | 'wallet_transfer'
  | 'wallet_withdrawal'
  | 'card_creation'
  | 'card_funding'
  | 'card_authorization'
  | 'card_settlement'
  | 'card_auth_expiry'
  | 'card_refund'
  | 'card_termination'
  | 'fx_trade'
  | 'bill_payment'
  | 'esim_purchase'
  | 'number_purchase'
  | 'giftcard_purchase'
  | 'giftcard_hold_release'
  | 'crypto_deposit'
  | 'crypto_withdrawal'
  | 'fee'
  | 'reversal'
  /* A dispute upheld. An APPENDED refund, never an edit of the entry disputed
     — that entry stays a true statement about what happened whatever we later
     decide about who should bear it. */
  | 'dispute_refund'
  | 'adjustment';

/** Mirrors `account_kind`. Customer roles carry an owner; platform roles do not. */
export type AccountRef =
  | { readonly kind: 'customer_wallet'; readonly ownerId: string; readonly currency: Currency }
  | { readonly kind: 'customer_card'; readonly ownerId: string; readonly currency: Currency }
  | { readonly kind: 'customer_pending'; readonly ownerId: string; readonly currency: Currency }
  | { readonly kind: 'revenue_fees'; readonly currency: Currency }
  | { readonly kind: 'revenue_fx_spread'; readonly currency: Currency }
  | { readonly kind: 'expense_provider_cost'; readonly currency: Currency }
  /* What upholding disputes has cost us. Its own expense account rather than
     netted against revenue, so it is a number somebody has to look at — a
     fraud rate nobody can see is a fraud rate nobody manages. */
  | { readonly kind: 'expense_dispute_loss'; readonly currency: Currency }
  | { readonly kind: 'provider_float'; readonly currency: Currency }
  | { readonly kind: 'asset_giftcard_inventory'; readonly currency: Currency }
  | { readonly kind: 'liability_customer_funds'; readonly currency: Currency }
  | { readonly kind: 'suspense'; readonly currency: Currency };

/**
 * A single leg.
 *
 * NOT typed as `Money`, and the reason is the variance rule in
 * @xetral/shared: `Money` is invariant in its currency parameter, so a bare
 * `Money` means `Money<Currency>` — the union of every currency at once — and
 * `Money<'USD'>` is deliberately NOT assignable to it. A field typed that way
 * would reject every real caller.
 *
 * An entry also spans currencies by design (an FX trade has an NGN leg and a
 * USD leg), so no single type parameter fits the list. Minor units plus a
 * currency code is the shape the database stores anyway, and `posting()` below
 * is the only sanctioned way to build one — it takes a properly typed `Money`
 * and cannot mix the amount up with the wrong code.
 */
export interface PostingIntent {
  readonly account: AccountRef;
  /** Signed minor units. Positive means value flows INTO the account. */
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export interface LedgerIntent {
  /**
   * The entry this one reverses. Required when `kind` is 'reversal' and
   * forbidden otherwise — `journal_entries` has a CHECK saying exactly that,
   * and a self-referencing FK so a reversal can never point at an entry that
   * does not exist.
   *
   * A mistake is corrected by appending one of these, never by editing
   * history. That is what makes the ledger auditable rather than merely
   * accurate.
   */
  readonly reversesEntryId?: string;
  /** `<provider>:<external id>`. The ledger's UNIQUE constraint on this is the
   *  replay guard, so it must be derived from the provider's own event id and
   *  never generated locally. */
  readonly idempotencyKey: string;
  readonly kind: EntryKind;
  /** When it happened in the world — the provider's timestamp, not ours. A
   *  webhook delayed six hours has a six-hour gap between the two, and
   *  reporting needs this one. */
  readonly occurredAt: Date;
  readonly description: string;
  readonly postings: readonly PostingIntent[];
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The only sanctioned way to build a leg. Generic over the currency so the
 * amount and the code cannot disagree — hand-writing the object literal would
 * let `{ amountMinor: usdCents, currency: 'NGN' }` past the compiler.
 */
export function posting<C extends Currency>(account: AccountRef, amount: Money<C>): PostingIntent {
  if (account.currency !== amount.currency) {
    throw new UnbalancedIntentError(
      `posting to a ${account.currency} account with a ${amount.currency} amount`,
    );
  }
  return { account, amountMinor: amount.amount, currency: amount.currency };
}

/**
 * Extends InvalidEntryError so a caller can catch one type for "this entry is
 * structurally wrong" regardless of who noticed. We check before writing and
 * Postgres checks at COMMIT; which of the two fired is our business, not the
 * caller's.
 */
export class UnbalancedIntentError extends InvalidEntryError {}

/**
 * Rejects an intent the ledger would refuse, before it reaches the ledger.
 *
 * This duplicates the database's constraint on purpose. The database is the
 * authority and stays so — but a deferred constraint fails at COMMIT, by which
 * point the failure is a transaction abort several layers from the adapter that
 * built the bad entry. Checking here names the adapter and the event while that
 * information is still in hand.
 *
 * PER CURRENCY, not per entry, for the same reason as section 5 of
 * 001_ledger.sql: summing kobo and cents as raw integers lets two independent
 * errors in different currencies cancel out and pass.
 */
export function assertBalanced(intent: LedgerIntent): void {
  // Mirrors the `reversal_has_target` CHECK. Caught here so the error names the
  // code that built the entry, rather than surfacing as a constraint violation
  // from inside a transaction several layers away.
  const isReversal = intent.kind === 'reversal';
  if (isReversal !== (intent.reversesEntryId !== undefined)) {
    throw new UnbalancedIntentError(
      isReversal
        ? `entry '${intent.idempotencyKey}' is a reversal but names no entry to reverse`
        : `entry '${intent.idempotencyKey}' names an entry to reverse but is kind '${intent.kind}'`,
    );
  }

  if (intent.postings.length < 2) {
    throw new UnbalancedIntentError(
      `entry '${intent.idempotencyKey}' has ${intent.postings.length} posting(s); at least 2 are required`,
    );
  }

  const totals = new Map<Currency, bigint>();
  for (const p of intent.postings) {
    if (p.amountMinor === 0n) {
      throw new UnbalancedIntentError(
        `entry '${intent.idempotencyKey}' has a zero-amount posting, which the ledger rejects`,
      );
    }
    totals.set(p.currency, (totals.get(p.currency) ?? 0n) + p.amountMinor);
  }

  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new UnbalancedIntentError(
        `entry '${intent.idempotencyKey}' is unbalanced: ${currency} postings sum to ${total}, must be 0`,
      );
    }
  }
}
