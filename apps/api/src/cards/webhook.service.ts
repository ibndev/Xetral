import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { InsufficientFundsError, LedgerService } from '@xetral/ledger';
import {
  BITNOB_EVENTS,
  WebhookVerificationError,
  microToUsdExact,
  parseMicro,
  parseWebhook,
  toLedgerIntent,
  verifyWebhookSignature,
} from '@xetral/providers';
import type { BitnobWebhookEnvelope } from '@xetral/providers';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { CardProtectionService, classifyDecline } from './card-protection.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface WebhookOutcome {
  readonly received: true;
  /** Present when the event produced a journal entry. Absent for events that
   *  move no money, such as a decline. */
  readonly entry_id?: string;
  readonly replayed?: boolean;
}

@Injectable()
export class CardWebhookService {
  readonly #logger = new Logger(CardWebhookService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CardProtectionService) private readonly protection: CardProtectionService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * The whole inbound path: verify, parse, resolve the customer, post.
   *
   * `rawBody` is the exact bytes Bitnob sent. Verifying a re-serialised body
   * fails in a way that looks precisely like a wrong secret, so the raw buffer
   * is threaded all the way here rather than reconstructed.
   */
  async handle(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<WebhookOutcome> {
    const secret = this.config.bitnobWebhookSecret;
    if (secret === undefined) {
      // Refusing is the only safe answer. Accepting unverified webhooks would
      // let anyone who finds the URL move money in our ledger.
      this.#logger.error('BITNOB_WEBHOOK_SECRET is not configured; refusing the webhook');
      throw new UnauthorizedException({ error: 'invalid_signature' });
    }

    try {
      // BEFORE parsing. No attacker-controlled bytes reach the JSON parser
      // until they are proven to come from Bitnob.
      verifyWebhookSignature(rawBody, headers, { secret });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        // Logged and dropped, never retried into the ledger.
        this.#logger.warn(`rejected an unverified webhook: ${error.message}`);
        throw new UnauthorizedException({ error: 'invalid_signature' });
      }
      throw error;
    }

    const envelope = parseWebhook(rawBody);

    const card = await this.#cardOf(envelope.data.card_id);
    const ownerId = card?.user_id;
    if (ownerId === undefined || card === undefined) {
      // A card we have never issued. Answering 200 stops the retries: there is
      // nothing we can do with it, and a permanent failure that keeps being
      // redelivered buries the events that matter.
      this.#logger.warn(
        `webhook for unknown card ${envelope.data.card_id}; acknowledged and ignored`,
      );
      return { received: true };
    }

    // A DECLINE moves no money, so it produces no intent and the ledger never
    // hears about it. It is still the most useful fraud signal a card gives
    // us: a subscription cascade is one decline repeating on a schedule, and
    // card testing is a burst of them. Handled before the intent, because
    // `toLedgerIntent` correctly returns undefined for it and everything
    // below assumes an entry.
    if (envelope.event === BITNOB_EVENTS.cardDeclined) {
      return this.#handleDecline(envelope, card.id);
    }

    // A refund names the authorization it answers, when Bitnob tells us which
    // one. Resolved here rather than in the adapter, because it is a database
    // lookup and the adapter is a pure translation of a payload.
    const refundsEntryId =
      envelope.event === BITNOB_EVENTS.cardRefund
        ? await this.#authorizationEntry(card.id, envelope.data.authorization_id)
        : undefined;

    // What the hold actually held, when this settlement resolves one.
    //
    // A settlement may exceed its authorization — a tip, a currency conversion
    // — and only the hold is in `customer_pending`. Without this the entry
    // tries to take the whole settled amount out of pending, the overdraft
    // guard refuses, and Bitnob retries for ever while the spend never reaches
    // our books.
    const authorizedMinor =
      envelope.event === BITNOB_EVENTS.cardSettlement
        ? await this.#authorizedAmount(card.id, envelope.data.authorization_id)
        : undefined;

    const intent = toLedgerIntent(envelope, {
      ownerId,
      ...(refundsEntryId === undefined ? {} : { refundsEntryId }),
      ...(authorizedMinor === undefined ? {} : { authorizedMinor }),
    });
    if (intent === undefined) return { received: true };

    // Only an AUTHORIZATION is a spend the customer is exposed to. A
    // settlement is an authorization already counted becoming final, and
    // counting it again would double every card's daily total; a refund moves
    // money the other way.
    const guardThis = envelope.event === BITNOB_EVENTS.cardAuthorization;

    let verdict: { readonly flagged: readonly string[] } = { flagged: [] };
    let posted;
    try {
      posted = await this.ledger.post(
        intent,
        guardThis
          ? {
              // Inside the entry's transaction, so the row that the duplicate
              // check counts exists if and only if the posting does.
              onEntry: async (client, written) => {
                verdict = await this.protection.recordAuthorization(client, {
                  cardId: card.id,
                  providerTxnId: envelope.data.id,
                  merchantLabel: envelope.data.merchant,
                  // Through the ONE audited conversion boundary. A second
                  // micro-to-cents division written inline here is how a
                  // settlement ends up off by a factor of ten thousand, and
                  // the guard would then be comparing cents to micro-units.
                  amountMinor: microToUsdExact(parseMicro(envelope.data.amount)).amount,
                  currency: 'USD',
                  entryId: written.entryId,
                  occurredAt: new Date(envelope.created_at),
                });
              },
            }
          : {},
      );
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Bitnob authorised a spend our ledger says the card cannot cover.
        // Either we missed a funding event or they let it through, and both
        // need a human.
        //
        // Rethrown rather than acknowledged, so the provider retries. Webhooks
        // arrive out of order, and a funding event landing a moment later makes
        // the retry succeed on its own. Acknowledging would drop a real spend
        // from our books permanently to save some log noise.
        this.#logger.error(
          `card ${envelope.data.card_id} authorised ${envelope.data.id} beyond its ledger ` +
            `balance. Reconcile against Bitnob before assuming the ledger is wrong.`,
        );
      }
      throw error;
    }

    // AFTER the money is recorded, never instead of it. The charge is already
    // approved by the network by the time this webhook exists, so the only
    // thing still preventable is the next one — see CardProtectionService.
    if (verdict.flagged.length > 0) {
      await this.#actOnVerdict(card.id, envelope.data.id, verdict.flagged);
    }

    // CLOSES THE HOLD, if this event resolved one.
    //
    // Without this the two halves of a card spend were never connected: the
    // authorization recorded its entry, the settlement posted its own, and
    // nothing anywhere could answer "which holds are still open?". A lost
    // settlement webhook then leaves money in `customer_pending` for ever —
    // the customer cannot spend it, the ledger balances perfectly, and no
    // check reports a thing.
    //
    // After the posting, deliberately. A settlement recorded against a hold
    // whose entry failed to post would claim money moved that did not.
    await this.#closeHold(card.id, envelope, posted.entryId);

    if (posted.replayed) {
      // Bitnob retries. The ledger's UNIQUE constraint made the second
      // delivery a no-op, which is exactly what should happen.
      this.#logger.log(`webhook ${envelope.event_id} was a replay of entry ${posted.entryUuid}`);
    }

    return { received: true, entry_id: posted.entryUuid, replayed: posted.replayed };
  }

  /**
   * A decline: no money, no entry, and the earliest warning a card gives.
   *
   * Answers 200 whatever happens. The event is a statement about something
   * that did NOT happen, so there is nothing for Bitnob to retry into and a
   * non-2xx would just have them redeliver a decline we have already counted.
   */
  async #handleDecline(
    envelope: ReturnType<typeof parseWebhook>,
    cardId: string,
  ): Promise<WebhookOutcome> {
    // Amount and currency are best-effort: a decline payload may carry them
    // and may not, and a missing amount must not stop the decline being
    // counted. The count is the signal; the amount is context.
    let amountMinor: bigint | undefined;
    try {
      amountMinor = microToUsdExact(parseMicro(envelope.data.amount)).amount;
    } catch {
      amountMinor = undefined;
    }

    const verdict = await this.protection.recordDecline({
      cardId,
      providerTxnId: envelope.data.id,
      merchantLabel: envelope.data.merchant,
      amountMinor,
      currency: envelope.data.currency.toUpperCase(),
      // Our classification, not the provider's words — see classifyDecline.
      reason: classifyDecline(envelope.data.reason),
      providerReason: envelope.data.reason,
      occurredAt: new Date(envelope.created_at),
    });

    if (verdict.flagged.length > 0) {
      await this.#actOnVerdict(cardId, envelope.data.id, verdict.flagged);
    }

    return { received: true };
  }

  /**
   * Turns a verdict into a freeze.
   *
   * One freeze per verdict however many reasons fired, because a card can only
   * be frozen once and three notifications for one event would read to a
   * customer as three separate incidents.
   */
  async #actOnVerdict(
    cardId: string,
    providerTxnId: string,
    flagged: readonly string[],
  ): Promise<void> {
    const wantsFreeze =
      flagged.includes('duplicate_charge')
        ? await this.settings.boolean('card_freeze_on_duplicate', true)
        : true;

    if (!wantsFreeze) {
      this.#logger.warn(
        `card ${cardId} transaction ${providerTxnId} flagged ${flagged.join(', ')}; ` +
          `not freezing because card_freeze_on_duplicate is off`,
      );
      return;
    }

    await this.protection.freeze(
      cardId,
      flagged[0] ?? 'flagged',
      `transaction ${providerTxnId} flagged: ${flagged.join(', ')}`,
    );
  }

  async #cardOf(
    providerCardId: string,
  ): Promise<{ id: string; user_id: string } | undefined> {
    const result = await this.pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM cards WHERE provider = 'bitnob' AND provider_card_id = $1`,
      [providerCardId],
    );
    return result.rows[0];
  }

  /**
   * What the authorization held, in minor units.
   *
   * Scoped to the card for the same reason every other lookup here is:
   * `provider_txn_id` is unique per card and not globally, so an unscoped
   * match could size one customer's settlement by another customer's hold.
   *
   * Undefined when the settlement names no authorization we hold. The whole
   * amount then comes from pending and the guard decides, which is the right
   * answer: we have no basis for claiming any of it was held.
   */
  async #authorizedAmount(
    cardId: string,
    authorizationId: string | undefined,
  ): Promise<bigint | undefined> {
    if (authorizationId === undefined) return undefined;
    const result = await this.pool.query<{ amount_minor: string }>(
      `SELECT amount_minor FROM card_authorizations
        WHERE card_id = $1::bigint AND provider_txn_id = $2`,
      [cardId, authorizationId],
    );
    const found = result.rows[0]?.amount_minor;
    return found === undefined ? undefined : BigInt(found);
  }

  /**
   * Records how a hold resolved, against the authorization it resolved.
   *
   * Matched on Bitnob's `authorization_id`, SCOPED TO THE CARD, for the same
   * reason the refund lookup is: `provider_txn_id` is unique per card and not
   * globally, so an unscoped match could close one customer's hold with
   * another customer's settlement.
   *
   * Swallows a duplicate. A redelivered settlement is a replay at the ledger
   * and must be a replay here too — the UNIQUE constraint is what enforces
   * that, and tripping it is the expected outcome rather than a failure.
   *
   * A settlement we cannot match is LOGGED AND LEFT. It has already posted, so
   * the money is right; what is missing is the link, and inventing one by
   * guessing which hold it belonged to would be worse than the gap. It shows
   * up as a hold that never resolved, which is a person's problem and is
   * exactly where this belongs.
   */
  async #closeHold(
    cardId: string,
    envelope: BitnobWebhookEnvelope,
    entryId: string,
  ): Promise<void> {
    const outcome =
      envelope.event === BITNOB_EVENTS.cardSettlement
        ? 'settled'
        : envelope.event === BITNOB_EVENTS.cardAuthorizationExpired
          ? 'expired'
          : undefined;
    if (outcome === undefined) return;

    const authorizationId = envelope.data.authorization_id;
    if (authorizationId === undefined) {
      this.#logger.warn(
        `${envelope.event} ${envelope.data.id} named no authorization; the hold it ` +
          `resolved cannot be closed and will be reported as stuck`,
      );
      return;
    }

    try {
      const written = await this.pool.query(
        `INSERT INTO card_settlements
           (authorization_id, outcome, entry_id, amount_minor, currency, occurred_at)
         SELECT a.id, $3::card_hold_outcome, $4::bigint, $5::bigint, 'USD', $6
           FROM card_authorizations a
          WHERE a.card_id = $1::bigint AND a.provider_txn_id = $2
         ON CONFLICT (authorization_id) DO NOTHING`,
        [
          cardId,
          authorizationId,
          outcome,
          entryId,
          // Through the ONE audited conversion boundary, the same as the
          // authorization above. A second micro-to-cents division written
          // inline is how a settlement ends up off by a factor of ten
          // thousand.
          microToUsdExact(parseMicro(envelope.data.amount)).amount.toString(),
          new Date(envelope.created_at),
        ],
      );

      if (written.rowCount === 0) {
        this.#logger.warn(
          `${envelope.event} named authorization ${authorizationId}, which this card has ` +
            `no record of. The money posted; the hold it closes is unknown.`,
        );
      }
    } catch (error) {
      // Never fails the webhook. The money is already recorded correctly, and
      // refusing here would make Bitnob retry a settlement that has already
      // posted — turning a bookkeeping gap into repeated delivery of an event
      // the ledger will keep answering as a replay.
      this.#logger.error(
        `could not record the outcome of authorization ${authorizationId}: ` +
          `${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /**
   * The journal entry for the authorization a refund answers.
   *
   * Looked up on `card_authorizations`, which has recorded `provider_txn_id`
   * against `entry_id` since Phase 13's card protections — so this needs no
   * new bookkeeping, only the join nobody had reason to write before.
   *
   * SCOPED TO THE CARD. `provider_txn_id` is UNIQUE per card rather than
   * globally, so matching on it alone could attach one customer's refund to
   * another customer's charge — which would then read, in both their
   * histories, as a refund of something that was never theirs.
   *
   * Returns undefined for anything it cannot resolve, and that is not an
   * error: the refund still posts. A refund the customer is owed must not be
   * refused because the provider did not say what it was for.
   */
  async #authorizationEntry(
    cardId: string,
    authorizationId: string | undefined,
  ): Promise<string | undefined> {
    if (authorizationId === undefined) return undefined;
    const result = await this.pool.query<{ entry_id: string }>(
      `SELECT entry_id FROM card_authorizations
        WHERE card_id = $1 AND provider_txn_id = $2`,
      [cardId, authorizationId],
    );
    return result.rows[0]?.entry_id;
  }

  async #ownerOfCard(providerCardId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM cards WHERE provider = 'bitnob' AND provider_card_id = $1`,
      [providerCardId],
    );
    return result.rows[0]?.user_id;
  }
}
