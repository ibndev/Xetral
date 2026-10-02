import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
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

    /*
     * WHICH HOLD THIS CLOSES, and whether it is still open.
     *
     * A settlement and an expiry each resolve ONE authorization, and both
     * move money out of `customer_pending` — which is one account per
     * currency for every hold the customer has. So an event naming no hold we
     * know, or a second outcome for a hold already closed (a settlement after
     * an expiry, an expiry after a settlement, a second settlement under a new
     * event id), used to post anyway and was paid for out of OTHER holds:
     * the overdraft guard only refuses when pending as a whole runs dry.
     *
     * Unknown (named, and not ours): refused, so Bitnob retries — the authorization may simply not
     * have arrived yet, which is the rule CLAUDE.md records. Closed: an expiry
     * or a repeat settlement posts nothing; a settlement after an EXPIRY takes
     * the spend off the card, because the hold's money went back there.
     */
    const resolvesHold =
      envelope.event === BITNOB_EVENTS.cardSettlement ||
      envelope.event === BITNOB_EVENTS.cardAuthorizationExpired;
    /* An event that names NO authorization cannot be matched to a hold at
       all, and refusing it would refuse every one for ever if the issuer never
       names them; it posts as it always did and the guard decides. One that
       names an authorization we do not hold is refused. */
    const named = resolvesHold && envelope.data.authorization_id !== undefined;
    const hold = named ? await this.#holdOf(card.id, envelope.data.authorization_id) : undefined;
    if (named) {
      if (hold === undefined) {
        this.#logger.warn(
          `${envelope.event} ${envelope.data.id} names authorization ` +
            `${envelope.data.authorization_id ?? '(none)'}, which this card has no record of; ` +
            'refused so the provider retries once the authorization has arrived',
        );
        throw new ServiceUnavailableException({ error: 'authorization_unknown' });
      }
      if (hold.closed !== null && !(envelope.event === BITNOB_EVENTS.cardSettlement && hold.closed === 'expired')) {
        this.#logger.log(
          `${envelope.event} ${envelope.data.id}: authorization ${envelope.data.authorization_id} ` +
            `is already ${hold.closed}; nothing more to post`,
        );
        return { received: true };
      }
    }
    const authorizedMinor =
      hold === undefined ? undefined : hold.closed === 'expired' ? 0n : hold.amountMinor;

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
    const closesHold = hold !== undefined && hold.closed === null;

    let verdict: { readonly flagged: readonly string[] } = { flagged: [] };
    let posted;
    try {
      posted = await this.ledger.post(
        intent,
        guardThis
          ? {
              onEntry: async (client, written) => {
                verdict = await this.protection.recordAuthorization(client, {
                  cardId: card.id,
                  providerTxnId: envelope.data.id,
                  merchantLabel: envelope.data.merchant,
                  amountMinor: microToUsdExact(parseMicro(envelope.data.amount)).amount,
                  currency: 'USD',
                  entryId: written.entryId,
                  occurredAt: new Date(envelope.created_at),
                });
              },
            }
          : closesHold
            ? {
                /* Under a lock on the authorization, re-checked, and closed on
                   the entry's own transaction — so a settlement and an expiry
                   racing each other cannot both release one hold. */
                precondition: async (client) => {
                  const locked = await client.query<{ open: boolean }>(
                    `SELECT NOT EXISTS (SELECT 1 FROM card_settlements s WHERE s.authorization_id = a.id) AS open
                       FROM card_authorizations a WHERE a.id = $1::bigint FOR UPDATE OF a`,
                    [hold.id],
                  );
                  if (locked.rows[0]?.open !== true) {
                    throw new ServiceUnavailableException({ error: 'authorization_moved' });
                  }
                },
                onEntry: async (client, written) => {
                  await client.query(
                    `INSERT INTO card_settlements
                       (authorization_id, outcome, entry_id, amount_minor, currency, occurred_at)
                     VALUES ($1::bigint, $2::card_hold_outcome, $3::bigint, $4::bigint, 'USD', $5)`,
                    [
                      hold.id,
                      envelope.event === BITNOB_EVENTS.cardSettlement ? 'settled' : 'expired',
                      written.entryId,
                      microToUsdExact(parseMicro(envelope.data.amount)).amount.toString(),
                      new Date(envelope.created_at),
                    ],
                  );
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
   * The authorization an event resolves: its id, what it held, and how it
   * was closed if it was. Scoped to the card — `provider_txn_id` is unique
   * per card, not globally.
   */
  async #holdOf(
    cardId: string,
    authorizationId: string | undefined,
  ): Promise<{ id: string; amountMinor: bigint; closed: 'settled' | 'expired' | null } | undefined> {
    if (authorizationId === undefined) return undefined;
    const result = await this.pool.query<{ id: string; amount_minor: string; closed: 'settled' | 'expired' | null }>(
      `SELECT a.id::text, a.amount_minor::text,
              (SELECT s.outcome::text FROM card_settlements s WHERE s.authorization_id = a.id) AS closed
         FROM card_authorizations a
        WHERE a.card_id = $1::bigint AND a.provider_txn_id = $2`,
      [cardId, authorizationId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, amountMinor: BigInt(row.amount_minor), closed: row.closed };
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
