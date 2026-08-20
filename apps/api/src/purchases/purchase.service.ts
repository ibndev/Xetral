import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import type { AccountRef, LedgerIntent } from '@xetral/ledger';
import { ProviderTimeoutError, supportsVerification } from '@xetral/providers';
import type {
  CatalogueItem,
  FulfilmentPort,
  PurchaseResult,
  ServiceKind,
  VerifiedTarget,
} from '@xetral/providers';
import { open, seal } from '@xetral/identity';
import type { Keyring } from '@xetral/identity';
import { fromMajor, subtract, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, FULFILMENT_PORTS, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { PurchaseRequestBody } from './dto.js';

/**
 * A catalogue item as it goes over the wire.
 *
 * `priceMinor` is a bigint, and `JSON.stringify` throws on one rather than
 * guessing — which is the right behaviour and is why this mapping exists at
 * all. The alternative every codebase reaches for is a global BigInt
 * serialiser, and that is how a price becomes a JSON number somewhere else in
 * the app six months later.
 */
export interface CatalogueItemView {
  readonly code: string;
  readonly name: string;
  /** Major units as a string, or null when the customer names the amount. */
  readonly price: string | null;
  readonly currency: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PurchaseView {
  readonly id: string;
  readonly service: string;
  readonly status: string;
  readonly amount: string;
  readonly currency: string;
  readonly target: string;
  readonly delivery: Readonly<Record<string, string>> | null;
  readonly failure_reason: string | null;
}

/** Which entry kind a service's money movement is recorded under. */
const ENTRY_KIND = {
  airtime: 'bill_payment',
  data: 'bill_payment',
  utility: 'bill_payment',
  esim: 'esim_purchase',
  number: 'number_purchase',
} as const satisfies Record<ServiceKind, LedgerIntent['kind']>;

interface PurchaseRow {
  id: string;
  uuid: string;
  user_id: string;
  reference: string;
  service: string;
  target: string;
  amount_minor: string;
  currency: string;
  status: string;
  delivery_sealed: string | null;
  failure_reason: string | null;
}

/**
 * Buying a thing from a provider on a customer's behalf.
 *
 * THE ORDER IS THE DESIGN.
 *
 *   1. Reserve  wallet -> pending   the overdraft guard decides affordability
 *   2. Ask the provider
 *   3. Settle   pending -> float    it really happened
 *      or Reverse pending -> wallet it definitely did not
 *
 * Committing the money first is not a detail: asking a provider to deliver
 * something before knowing the customer can pay for it is buying on credit
 * nobody agreed to extend. And settling only on a definite answer is what
 * keeps a timeout from becoming either a free product or a stolen payment —
 * an unknown outcome stays reserved, which is money correctly held rather than
 * money quietly kept.
 */
@Injectable()
export class PurchaseService {
  readonly #logger = new Logger(PurchaseService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(FULFILMENT_PORTS) private readonly ports: ReadonlyMap<ServiceKind, FulfilmentPort>,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async catalogue(
    service: ServiceKind,
    group: string | undefined,
  ): Promise<readonly CatalogueItemView[]> {
    const port = this.#port(service);
    const items = await port.catalogue(group === undefined ? {} : { group });
    return items.map(toCatalogueView);
  }

  /** Confirms a meter or smartcard number belongs to who the customer thinks.
   *  Only some providers can; the rest say so rather than guessing. */
  async verifyTarget(service: ServiceKind, itemCode: string, target: string): Promise<VerifiedTarget> {
    const port = this.#port(service);
    if (!supportsVerification(port)) {
      throw new ConflictException({ error: 'verification_not_supported', service });
    }
    return port.verifyTarget(itemCode, target);
  }

  async list(userUuid: string): Promise<readonly PurchaseView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<PurchaseRow>(
      `SELECT id, uuid, user_id, reference, service, target, amount_minor, currency,
              status, delivery_sealed, failure_reason
         FROM purchases WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 100`,
      [userId],
    );
    return rows.rows.map((row) => this.#toView(row));
  }

  async buy(userUuid: string, body: PurchaseRequestBody): Promise<PurchaseView> {
    const userId = await this.#activeUserId(userUuid);
    const port = this.#port(body.service);

    const currency = currencyFor(body.service);
    const amount = this.#parseAmount(body.amount, currency);
    const reference = referenceFor(userUuid, body.service, body.idempotency_key);

    // A retried request finds the first attempt rather than starting a second.
    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return this.#toView(existing);

    const reserve = await this.#reserve(userId, body, reference, amount, currency);

    let result: PurchaseResult;
    try {
      result = await port.purchase({
        reference,
        itemCode: body.item_code,
        target: body.target,
        amountMinor: amount.amount,
        currency,
      });
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        // We do NOT know whether the provider acted, so the money stays
        // reserved and `pending_purchases` picks it up. Reversing here would
        // refund a purchase that may have been delivered; retrying would buy
        // it twice.
        this.#logger.warn(
          `purchase ${reference} timed out at ${port.provider}; left reserved for reconciliation`,
        );
        return this.#toView(await this.#reload(reserve.purchaseId));
      }
      // A definite refusal. The customer's money comes straight back.
      await this.#reverse(userId, reserve, amount, currency, describe(error));
      throw new UnprocessableEntityException({ error: 'purchase_failed', detail: describe(error) });
    }

    if (result.status === 'pending') {
      await this.#recordProviderReference(reserve.purchaseId, result.providerReference);
      return this.#toView(await this.#reload(reserve.purchaseId));
    }

    if (result.status === 'failed') {
      await this.#reverse(userId, reserve, amount, currency, result.failureReason ?? 'provider declined');
      return this.#toView(await this.#reload(reserve.purchaseId));
    }

    await this.#settle(userId, reserve, amount, currency, result);
    return this.#toView(await this.#reload(reserve.purchaseId));
  }

  /* ------------------------------------------------------------------ */

  async #reserve(
    userId: string,
    body: PurchaseRequestBody,
    reference: string,
    amount: Money<Currency>,
    currency: Currency,
  ): Promise<{ purchaseId: string; entryId: string }> {
    let entryId: string;
    try {
      const posted = await this.ledger.post({
        idempotencyKey: `purchase-reserve:${reference}`,
        kind: ENTRY_KIND[body.service],
        occurredAt: new Date(),
        description: `${body.service} purchase reserved`,
        metadata: { reference, service: body.service },
        postings: [
          posting(wallet(userId, currency), negate(amount)),
          posting(pending(userId, currency), amount),
        ],
      });
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                              item_code, target, amount_minor, currency, reserve_entry_id)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        reference,
        body.idempotency_key,
        this.#port(body.service).provider,
        body.service,
        body.item_code,
        body.target,
        amount.amount.toString(),
        currency,
        entryId,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { purchaseId: row.id, entryId };

    // Two identical requests arrived at once. Both posted the reserve — the
    // second got the first one's entry back with `replayed: true`, so no money
    // moved twice — and one of them lost the insert. The loser reads the
    // winner's row rather than failing: from the customer's side these were
    // one request sent twice, and answering an error to the second would
    // describe a purchase that did happen as one that did not.
    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing === undefined) throw new Error('purchase insert returned no row');
    return { purchaseId: existing.id, entryId };
  }

  async #settle(
    userId: string,
    reserve: { purchaseId: string; entryId: string },
    amount: Money<Currency>,
    currency: Currency,
    result: PurchaseResult,
  ): Promise<void> {
    const row = await this.#reload(reserve.purchaseId);

    await this.ledger.post({
      idempotencyKey: `purchase-settle:${row.reference}`,
      kind: ENTRY_KIND[row.service as ServiceKind],
      occurredAt: new Date(),
      description: `${row.service} purchase delivered`,
      metadata: { reference: row.reference, provider_reference: result.providerReference },
      postings: [
        posting(pending(userId, currency), negate(amount)),
        posting({ kind: 'provider_float', currency }, amount),
      ],
    });

    await this.pool.query(
      `UPDATE purchases
          SET status = 'delivered', provider_reference = $2, delivery_sealed = $3
        WHERE id = $1::bigint`,
      [
        reserve.purchaseId,
        result.providerReference,
        // Sealed, not stored in the clear. An electricity token is spendable by
        // whoever holds it before it is used.
        Object.keys(result.delivery).length === 0
          ? null
          : seal(JSON.stringify(result.delivery), this.#keyring()),
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
  async #reverse(
    userId: string,
    reserve: { purchaseId: string; entryId: string },
    amount: Money<Currency>,
    currency: Currency,
    reason: string,
  ): Promise<void> {
    const row = await this.#reload(reserve.purchaseId);

    await this.ledger.post({
      idempotencyKey: `purchase-reverse:${row.reference}`,
      kind: 'reversal',
      reversesEntryId: reserve.entryId,
      occurredAt: new Date(),
      description: `${row.service} purchase reversed`,
      metadata: { reference: row.reference, reason },
      postings: [
        posting(pending(userId, currency), negate(amount)),
        posting(wallet(userId, currency), amount),
      ],
    });

    await this.pool.query(
      `UPDATE purchases SET status = 'reversed', failure_reason = $2 WHERE id = $1::bigint`,
      [reserve.purchaseId, reason],
    );
  }

  async #recordProviderReference(purchaseId: string, providerReference: string): Promise<void> {
    await this.pool.query(
      `UPDATE purchases SET provider_reference = $2 WHERE id = $1::bigint`,
      [purchaseId, providerReference],
    );
  }

  #port(service: ServiceKind): FulfilmentPort {
    const port = this.ports.get(service);
    if (port === undefined) {
      throw new ServiceUnavailableException({ error: 'service_not_configured', service });
    }
    return port;
  }

  #keyring(): Keyring {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      // Refusing beats storing a bearer token in the clear.
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return keyring;
  }

  #parseAmount(raw: string, currency: Currency): Money<Currency> {
    let amount: Money<Currency>;
    try {
      amount = fromMajor(raw, currency);
    } catch (cause) {
      throw new BadRequestException({
        error: 'invalid_amount',
        detail: cause instanceof Error ? cause.message : undefined,
      });
    }
    if (amount.amount <= 0n) {
      throw new BadRequestException({ error: 'invalid_amount', detail: 'must be positive' });
    }
    return amount;
  }

  #toView(row: PurchaseRow): PurchaseView {
    const currency = row.currency as Currency;
    return {
      id: row.uuid,
      service: row.service,
      status: row.status,
      amount: toMajor({ amount: BigInt(row.amount_minor), currency }),
      currency: row.currency,
      target: row.target,
      delivery:
        row.delivery_sealed === null
          ? null
          : (JSON.parse(open(row.delivery_sealed, this.#keyring())) as Record<string, string>),
      failure_reason: row.failure_reason,
    };
  }

  async #reload(purchaseId: string): Promise<PurchaseRow> {
    const result = await this.pool.query<PurchaseRow>(
      `SELECT id, uuid, user_id, reference, service, target, amount_minor, currency,
              status, delivery_sealed, failure_reason
         FROM purchases WHERE id = $1::bigint`,
      [purchaseId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'purchase_not_found' });
    return row;
  }

  async #byKey(userId: string, idempotencyKey: string): Promise<PurchaseRow | undefined> {
    const result = await this.pool.query<PurchaseRow>(
      `SELECT id, uuid, user_id, reference, service, target, amount_minor, currency,
              status, delivery_sealed, failure_reason
         FROM purchases WHERE user_id = $1::bigint AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return result.rows[0];
  }

  async #activeUserId(uuid: string): Promise<string> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    if (row.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: row.status });
    }
    return row.id;
  }
}

/**
 * The provider-facing name for this purchase, and the root of both ledger
 * idempotency keys.
 *
 * DERIVED, not generated. A fresh random reference per attempt looks
 * equivalent and is not: the reserve entry is posted before the purchase row
 * exists, so a crash in that gap leaves a retry with no row to find. A derived
 * reference makes that retry reuse the SAME ledger key, which the ledger
 * answers with `replayed: true` — the customer is charged once. A random one
 * would charge them twice, and only under a crash, which is the hardest kind
 * of double charge to ever reproduce.
 *
 * Hashed rather than concatenated because the parts are a customer's user id
 * and a key they chose. Both would otherwise be handed to a third party in
 * every request, and a customer-controlled string reaching a provider's
 * reference field is somebody else's injection bug to discover.
 */
export function referenceFor(userUuid: string, service: ServiceKind, key: string): string {
  const digest = createHash('sha256').update(`${userUuid}:${service}:${key}`).digest('hex');
  return `xt${digest.slice(0, 24)}`;
}

/** VTpass settles in naira; Airalo and Twilio in dollars. The customer pays in
 *  the currency the provider settles in, so no FX happens inside a purchase. */
function toCatalogueView(item: CatalogueItem): CatalogueItemView {
  return {
    code: item.code,
    name: item.name,
    // An open-ended item — airtime, where the customer names the amount — has
    // no price, which is not the same as a price of zero and must not
    // serialise as one.
    price: item.priceMinor === null ? null : toMajor({ amount: item.priceMinor, currency: item.currency }),
    currency: item.currency,
    metadata: item.metadata,
  };
}

function currencyFor(service: ServiceKind): Currency {
  return service === 'esim' || service === 'number' ? 'USD' : 'NGN';
}

const wallet = (userId: string, currency: Currency): AccountRef => ({
  kind: 'customer_wallet',
  ownerId: userId,
  currency,
});
const pending = (userId: string, currency: Currency): AccountRef => ({
  kind: 'customer_pending',
  ownerId: userId,
  currency,
});

function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return subtract({ amount: 0n, currency: amount.currency }, amount);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'the provider refused the purchase';
}
