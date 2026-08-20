import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { InsufficientFundsError, LedgerService } from '@xetral/ledger';
import {
  WebhookVerificationError,
  parseWebhook,
  toLedgerIntent,
  verifyWebhookSignature,
} from '@xetral/providers';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

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

    const ownerId = await this.#ownerOfCard(envelope.data.card_id);
    if (ownerId === undefined) {
      // A card we have never issued. Answering 200 stops the retries: there is
      // nothing we can do with it, and a permanent failure that keeps being
      // redelivered buries the events that matter.
      this.#logger.warn(
        `webhook for unknown card ${envelope.data.card_id}; acknowledged and ignored`,
      );
      return { received: true };
    }

    const intent = toLedgerIntent(envelope, { ownerId });
    if (intent === undefined) return { received: true };

    let posted;
    try {
      posted = await this.ledger.post(intent);
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

    if (posted.replayed) {
      // Bitnob retries. The ledger's UNIQUE constraint made the second
      // delivery a no-op, which is exactly what should happen.
      this.#logger.log(`webhook ${envelope.event_id} was a replay of entry ${posted.entryUuid}`);
    }

    return { received: true, entry_id: posted.entryUuid, replayed: posted.replayed };
  }

  async #ownerOfCard(providerCardId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM cards WHERE provider = 'bitnob' AND provider_card_id = $1`,
      [providerCardId],
    );
    return result.rows[0]?.user_id;
  }
}
