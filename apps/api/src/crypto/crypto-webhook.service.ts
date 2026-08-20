import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import {
  handleCryptoDeposit,
  parseCryptoWebhook,
  verifyWebhookSignature,
  WebhookVerificationError,
} from '@xetral/providers';
import type { BitnobCryptoEnvelope, CryptoDepositOutcome } from '@xetral/providers';
import type { Currency } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * On-chain deposit webhooks.
 *
 * The two phases are handled by the same method because they are the same
 * event twice, and the difference between them is entirely in what the ledger
 * is asked to do: `seen` credits an unspendable balance, `confirmed` makes it
 * spendable. Keeping them together means the confirmation cannot drift into
 * doing something the deposit never did.
 */
@Injectable()
export class CryptoWebhookService {
  readonly #logger = new Logger(CryptoWebhookService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async handle(rawBody: string, headers: Record<string, string | undefined>): Promise<void> {
    const secret = this.config.bitnobWebhookSecret;
    if (secret === undefined) {
      throw new Error('BITNOB_WEBHOOK_SECRET is not configured; refusing the crypto webhook');
    }

    try {
      verifyWebhookSignature(rawBody, headers, { secret });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        this.#logger.warn(`crypto webhook rejected: ${error.message}`);
        throw new UnauthorizedException({ error: 'invalid_signature' });
      }
      throw error;
    }

    const event = parseCryptoWebhook(rawBody);
    const outcome = await handleCryptoDeposit(event, {
      resolve: async (e) => this.#resolve(e),
    });

    if (outcome.phase === 'seen') {
      await this.#recordSeen(outcome, event);
      return;
    }
    await this.#recordConfirmed(outcome);
  }

  async #resolve(
    event: BitnobCryptoEnvelope,
  ): Promise<{ ownerId: string; asset: Currency } | undefined> {
    const result = await this.pool.query<{ user_id: string; asset: string }>(
      `SELECT user_id, asset FROM crypto_addresses
        WHERE address = $1 AND network = $2::crypto_network AND active`,
      [event.data.address, normaliseChain(event.data.chain)],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { ownerId: row.user_id, asset: row.asset as Currency };
  }

  /** Money is on the chain and not yet safe. It shows as pending. */
  async #recordSeen(outcome: CryptoDepositOutcome, event: BitnobCryptoEnvelope): Promise<void> {
    const posted = await this.ledger.post(outcome.intent);
    if (posted.replayed) {
      this.#logger.log(`crypto deposit ${outcome.providerReference} already seen; replay`);
      return;
    }

    const address = await this.pool.query<{ id: string }>(
      `SELECT id FROM crypto_addresses
        WHERE address = $1 AND network = $2::crypto_network AND active`,
      [event.data.address, outcome.network],
    );
    const addressId = address.rows[0]?.id;
    if (addressId === undefined) throw new Error('address vanished between resolve and record');

    await this.pool.query(
      `INSERT INTO crypto_deposits
         (provider, provider_reference, user_id, address_id, tx_hash, output_index,
          asset, network, amount_minor, confirmations, required_confirmations,
          seen_entry_id)
       VALUES ('bitnob', $1, $2::bigint, $3::bigint, $4, $5, $6, $7::crypto_network,
               $8::bigint, $9, $10, $11::bigint)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        outcome.providerReference,
        outcome.ownerId,
        addressId,
        outcome.txHash,
        outcome.outputIndex,
        outcome.asset,
        outcome.network,
        outcome.amountMinor.toString(),
        outcome.confirmations,
        // Stored per row: raising the threshold later must not retroactively
        // un-confirm deposits already credited.
        this.config.confirmationsFor(outcome.asset, outcome.network),
        posted.entryId,
      ],
    );
  }

  /** The chain has buried it deep enough. The money becomes spendable. */
  async #recordConfirmed(outcome: CryptoDepositOutcome): Promise<void> {
    const found = await this.pool.query<{ id: string; status: string; required: number }>(
      `SELECT id, status::text, required_confirmations AS required
         FROM crypto_deposits WHERE provider = 'bitnob' AND provider_reference = $1`,
      [outcome.providerReference],
    );
    const row = found.rows[0];

    if (row === undefined) {
      // The confirmation arrived and the "seen" event never did — webhooks
      // arrive out of order. Throwing means the provider retries, by which
      // time the seen event has usually landed. Crediting a spendable balance
      // for a deposit we have no record of would be worse.
      throw new Error(
        `crypto deposit ${outcome.providerReference} confirmed before it was seen; retrying`,
      );
    }
    if (row.status !== 'seen') {
      this.#logger.log(`crypto deposit ${outcome.providerReference} already ${row.status}`);
      return;
    }
    if (outcome.confirmations < row.required) {
      // The provider called it confirmed; the count says otherwise. The
      // database would refuse the UPDATE anyway — this makes the reason
      // legible instead of surfacing as a constraint violation.
      throw new Error(
        `crypto deposit ${outcome.providerReference} has ${outcome.confirmations} ` +
          `confirmations; ${row.required} are required`,
      );
    }

    const posted = await this.ledger.post(outcome.intent);

    await this.pool.query(
      `UPDATE crypto_deposits
          SET status = 'confirmed', confirmations = GREATEST(confirmations, $2),
              confirmed_entry_id = $3::bigint
        WHERE id = $1::bigint AND status = 'seen'`,
      [row.id, outcome.confirmations, posted.entryId],
    );
  }
}

function normaliseChain(chain: string): string {
  const lower = chain.toLowerCase();
  if (lower === 'btc') return 'bitcoin';
  if (lower === 'eth' || lower === 'erc20') return 'ethereum';
  if (lower === 'trx' || lower === 'trc20') return 'tron';
  if (lower === 'bep20') return 'bsc';
  return lower;
}
