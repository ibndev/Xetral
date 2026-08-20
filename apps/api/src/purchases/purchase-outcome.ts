import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { AccountRef, LedgerIntent } from '@xetral/ledger';
import type { PurchaseResult, ServiceKind } from '@xetral/providers';
import { seal } from '@xetral/identity';
import type { Keyring } from '@xetral/identity';
import { subtract } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

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
  ) {}

  /** The hold becomes a real spend. */
  async settle(row: ReservedPurchase, result: PurchaseResult): Promise<void> {
    const { amount, currency } = amountOf(row);

    await this.ledger.post({
      idempotencyKey: `purchase-settle:${row.reference}`,
      kind: ENTRY_KIND[row.service as ServiceKind],
      occurredAt: new Date(),
      description: `${row.service} purchase delivered`,
      metadata: { reference: row.reference, provider_reference: result.providerReference },
      postings: [
        posting(pending(row.user_id, currency), negate(amount)),
        posting({ kind: 'provider_float', currency }, amount),
      ],
    });

    await this.pool.query(
      `UPDATE purchases
          SET status = 'delivered', provider_reference = $2, delivery_sealed = $3
        WHERE id = $1::bigint`,
      [
        row.id,
        result.providerReference,
        // Sealed, not stored in the clear. An electricity token is spendable by
        // whoever holds it before it is used.
        Object.keys(result.delivery).length === 0
          ? null
          : seal(JSON.stringify(result.delivery), this.keyring()),
      ],
    );
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

    await this.ledger.post({
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
    });

    await this.pool.query(
      `UPDATE purchases SET status = 'reversed', failure_reason = $2 WHERE id = $1::bigint`,
      [row.id, reason],
    );
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
