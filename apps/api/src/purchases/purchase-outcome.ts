import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { AccountRef, LedgerIntent } from '@xetral/ledger';
import type { PurchaseResult, ServiceKind } from '@xetral/providers';
import { seal } from '@xetral/identity';
import type { Keyring } from '@xetral/identity';
import { subtract, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * How a reserved purchase becomes a settled or reversed one.
 *
 * Extracted because TWO callers need it and they must not each have their own
 * idea of what settling means: the request handler resolves the outcome it
 * learned synchronously, and the reconciliation worker resolves the ones where
 * nobody was left listening. A second copy of these postings would be a second
 * set of assumptions about the ledger, and the copy that drifts is the one that
 * only runs at 4am against money nobody is watching.
 */

/** Which entry kind a service's money movement is recorded under. */
export const ENTRY_KIND = {
  airtime: 'bill_payment',
  data: 'bill_payment',
  utility: 'bill_payment',
  esim: 'esim_purchase',
  number: 'number_purchase',
} as const satisfies Record<ServiceKind, LedgerIntent['kind']>;

/** The fields settling or reversing needs. Deliberately not the whole row —
 *  neither operation has any business reading a sealed delivery payload. */
export interface ReservedPurchase {
  readonly id: string;
  readonly user_id: string;
  readonly reference: string;
  readonly service: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly reserve_entry_id: string | null;
}

@Injectable()
export class PurchaseOutcome {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** The hold becomes a real spend. */
  async settle(row: ReservedPurchase, result: PurchaseResult): Promise<void> {
    const { amount, currency } = amountOf(row);
    const sealed =
      Object.keys(result.delivery).length === 0
        ? null
        : seal(JSON.stringify(result.delivery), this.keyring());

    /*
     * DECIDED UNDER A LOCK ON THE PURCHASE ROW, WITH THE ROW MOVED ON THE
     * ENTRY'S OWN TRANSACTION.
     *
     * The request handler, the reconciliation sweep, the recovery list and
     * its refund button all resolve purchases, from snapshots, concurrently.
     * Settling and reversing are two different ledger keys, so nothing at the
     * ledger stopped one of each: both drew on `customer_pending`, and the
     * overdraft guard let the second through whenever anything else was held
     * there — the product delivered AND the customer refunded, every entry
     * balanced. The status UPDATE ran afterwards as a separate statement, so
     * 004's "an outcome is final" trigger refused it only after both postings
     * had committed. Now the row is locked and re-read before posting, a
     * purchase that is no longer `reserved` is left alone, and the posting and
     * the status commit together.
     */
    let posted;
    try {
      posted = await this.ledger.post({
      idempotencyKey: `purchase-settle:${row.reference}`,
      kind: ENTRY_KIND[row.service as ServiceKind],
      occurredAt: new Date(),
      description: `${row.service} purchase delivered`,
      metadata: { reference: row.reference, provider_reference: result.providerReference },
      postings: [
        posting(pending(row.user_id, currency), negate(amount)),
        posting({ kind: 'provider_float', currency }, amount),
      ],
    }, {
      precondition: async (client) => {
        if (!(await stillReserved(client, row))) throw new PurchaseDecided();
      },
      onEntry: async (client) => {
        await markDelivered(client, row.id, result.providerReference, sealed);
      },
    });
    } catch (error) {
      if (error instanceof PurchaseDecided) return;
      throw error;
    }

    // A replay skips `onEntry`: the settlement was posted by an attempt that
    // died before its row moved. Guarded on `reserved`.
    if (posted.replayed) await markDelivered(this.pool, row.id, result.providerReference, sealed);
  }

  /**
   * Gives the money back by APPENDING a reversal that names the reserve entry.
   *
   * Not by deleting the reserve, and not by a fresh unrelated credit: the
   * ledger is append-only, and a reversal that points at what it undoes is the
   * thing an auditor can follow.
   */
  async reverse(row: ReservedPurchase, reason: string): Promise<void> {
    const { amount, currency } = amountOf(row);

    if (row.reserve_entry_id === null) {
      // Unreachable through either caller — the column is written in the same
      // statement that creates the row. Throwing beats posting a reversal that
      // names nothing, which the database would refuse anyway and which would
      // arrive as a constraint violation with no explanation attached.
      throw new Error(`purchase ${row.id} has no reserve entry to reverse`);
    }

    let posted;
    try {
      posted = await this.ledger.post({
      idempotencyKey: `purchase-reverse:${row.reference}`,
      kind: 'reversal',
      reversesEntryId: row.reserve_entry_id,
      occurredAt: new Date(),
      description: `${row.service} purchase reversed`,
      metadata: { reference: row.reference, reason },
      postings: [
        posting(pending(row.user_id, currency), negate(amount)),
        posting(wallet(row.user_id, currency), amount),
      ],
    },
    {
      precondition: async (client) => {
        if (!(await stillReserved(client, row))) throw new PurchaseDecided();
      },
      /*
       * AND TELL THE CUSTOMER, on the reversal's OWN transaction.
       *
       * The posting has always been right — the money leaves
       * `customer_pending` and lands back in the wallet, spendable — and
       * nothing said so. What a customer saw was a debit and then an
       * unexplained credit, which reads as money having gone somewhere and
       * come back by accident. "It was deducted and never returned" is what
       * that looks like from outside even when the ledger is correct.
       *
       * On the entry's own connection, never taking one of its own: this
       * runs inside a transaction already holding one, and a second would
       * deadlock the pool at `pool.max`.
       */
      onEntry: async (client, entry) => {
        await markReversed(client, row.id, reason);
        const found = await client.query<{ email: string | null }>(
          `SELECT email FROM users WHERE id = $1::bigint`,
          [row.user_id],
        );
        const email = found.rows[0]?.email;
        if (email === null || email === undefined) return;
        await this.notifications.enqueueBestEffort(client, {
          userId: row.user_id,
          recipient: email,
          // The ledger key, reused: a second identity for one event is how
          // the two drift under exactly the conditions that make idempotency
          // matter, and this path is retried by the sweep by design.
          idempotencyKey: `receipt:purchase-reverse:${row.reference}`,
          request: {
            kind: 'transfer_reversed',
            amount: toMajor(amount),
            currency,
            reason,
            reference: entry.entryUuid,
          },
        });
      },
    });

    } catch (error) {
      if (error instanceof PurchaseDecided) return;
      throw error;
    }

    if (posted.replayed) await markReversed(this.pool, row.id, reason);
  }

  /** Records what the provider calls this, without deciding anything. */
  async recordProviderReference(purchaseId: string, providerReference: string): Promise<void> {
    await this.pool.query(`UPDATE purchases SET provider_reference = $2 WHERE id = $1::bigint`, [
      purchaseId,
      providerReference,
    ]);
  }

  keyring(): Keyring {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      // Refusing beats storing a bearer token in the clear.
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return keyring;
  }
}

function amountOf(row: ReservedPurchase): { amount: Money<Currency>; currency: Currency } {
  const currency = row.currency as Currency;
  return { amount: { amount: BigInt(row.amount_minor), currency }, currency };
}

export const wallet = (userId: string, currency: Currency): AccountRef => ({
  kind: 'customer_wallet',
  ownerId: userId,
  currency,
});

export const pending = (userId: string, currency: Currency): AccountRef => ({
  kind: 'customer_pending',
  ownerId: userId,
  currency,
});

export function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return subtract({ amount: 0n, currency: amount.currency }, amount);
}

/** Somebody else settled or reversed this purchase first. Their outcome stands. */
class PurchaseDecided extends Error {
  constructor() {
    super('the purchase was already decided');
  }
}

/**
 * Locks the purchase row on the entry's own connection and says whether it is
 * still undecided: `reserved`, and with neither outcome already in the ledger
 * (an outcome posted by an attempt that died before its row moved counts).
 */
async function stillReserved(client: PoolClient, row: ReservedPurchase): Promise<boolean> {
  const found = await client.query<{ open: boolean }>(
    `SELECT p.status = 'reserved'
            AND NOT EXISTS (
              SELECT 1 FROM journal_entries e
               WHERE e.idempotency_key IN ('purchase-settle:' || p.reference,
                                           'purchase-reverse:' || p.reference)
            ) AS open
       FROM purchases p
      WHERE p.id = $1::bigint
        FOR UPDATE OF p`,
    [row.id],
  );
  return found.rows[0]?.open === true;
}

async function markDelivered(
  db: Pool | PoolClient,
  purchaseId: string,
  providerReference: string,
  sealed: string | null,
): Promise<void> {
  await db.query(
    `UPDATE purchases
        SET status = 'delivered', provider_reference = $2, delivery_sealed = $3
      WHERE id = $1::bigint AND status = 'reserved'`,
    [purchaseId, providerReference, sealed],
  );
}

async function markReversed(db: Pool | PoolClient, purchaseId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE purchases SET status = 'reversed', failure_reason = $2
      WHERE id = $1::bigint AND status = 'reserved'`,
    [purchaseId, reason],
  );
}
