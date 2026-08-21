import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import {
  DepositCeilingError,
  handleDepositWebhook,
  parseDepositWebhook,
  verifyWebhookSignature,
  WebhookVerificationError,
} from '@xetral/providers';
import type { BitnobDepositEnvelope, DepositOutcome } from '@xetral/providers';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { FundingService } from './funding.service.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * The webhook that creates customer money.
 *
 * Every other inbound event moves funds that are already ours to move. This
 * one takes a provider's word that a stranger's bank transfer arrived and
 * turns it into a spendable balance, so the order of operations is the
 * security model:
 *
 *   1. Verify the signature against the RAW body, before parsing. No
 *      attacker-controlled bytes reach the JSON parser until they are proven
 *      to come from Bitnob.
 *   2. Convert the amount through the ONE audited boundary, and apply the
 *      ceiling. A breach is not credited.
 *   3. Resolve the account to a customer, or accept that we cannot.
 *   4. Post — to the customer, or to suspense. Never nothing.
 */
@Injectable()
export class DepositWebhookService {
  readonly #logger = new Logger(DepositWebhookService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(FundingService) private readonly funding: FundingService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async handle(rawBody: string, headers: Record<string, string | undefined>): Promise<void> {
    const secret = this.config.bitnobWebhookSecret;
    if (secret === undefined) {
      // Refusing beats processing an unverifiable instruction to create money.
      throw new Error('BITNOB_WEBHOOK_SECRET is not configured; refusing the deposit webhook');
    }

    try {
      // Verification precedes parsing, deliberately.
      verifyWebhookSignature(rawBody, headers, { secret });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        // 401 and DROPPED, not 500 and not retried. A forged webhook is a
        // client error: answering 500 both pages somebody at 3am over
        // somebody else's probe, and tells the sender we are broken rather
        // than that they are unauthorised.
        this.#logger.warn(`deposit webhook rejected: ${error.message}`);
        throw new UnauthorizedException({ error: 'invalid_signature' });
      }
      throw error;
    }

    const event = parseDepositWebhook(rawBody);

    let outcome: DepositOutcome;
    try {
      outcome = await handleDepositWebhook(event, {
        amountUnit: this.config.bitnobNgnAmountUnit,
        // From settings, so raising the ceiling for a large expected transfer
        // is an audited change rather than a redeploy.
        ceilingKobo: await this.settings.depositCeilingKobo(),
        resolve: async (e) => this.#resolve(e),
      });
    } catch (error) {
      if (error instanceof DepositCeilingError) {
        // Money arrived and we will NOT credit it on these numbers. It is held
        // in suspense and escalated: either the ceiling is too low for a
        // genuinely large transfer, or the amount unit is misconfigured — and
        // both are decisions for a person, not a webhook handler.
        await this.#suspend(event, error);
        return;
      }
      throw error;
    }

    await this.#record(outcome, event);
  }

  /** Which customer, if any, this landed on. */
  async #resolve(
    event: BitnobDepositEnvelope,
  ): Promise<{ ownerId: string | undefined; reason?: string }> {
    const account = await this.funding.resolveAccount(
      event.data.virtual_account_id,
      event.data.account_number,
    );

    if (account === undefined) {
      return {
        ownerId: undefined,
        // Deliberately does not echo the account number into the reason: it
        // ends up in a ledger entry that can never be redacted.
        reason: 'no virtual account matched this deposit',
      };
    }
    if (account.status === 'closed') {
      return { ownerId: undefined, reason: 'the account this landed on is closed' };
    }
    return { ownerId: account.user_id };
  }

  async #record(outcome: DepositOutcome, event: BitnobDepositEnvelope): Promise<void> {
    const posted = await this.ledger.post(outcome.intent);

    if (posted.replayed) {
      // A redelivery. The ledger already refused to move the money twice, and
      // the deposits row already exists — so this is a SUCCESS, and the
      // handler must answer 2xx or Bitnob will keep retrying for ever.
      this.#logger.log(`deposit ${outcome.providerReference} was already credited; replay`);
      return;
    }

    const account = await this.funding.resolveAccount(
      event.data.virtual_account_id,
      event.data.account_number,
    );

    await this.pool.query(
      `INSERT INTO deposits
         (provider, provider_reference, user_id, virtual_account_id, amount_minor,
          currency, sender_name, sender_bank, sender_account, status, entry_id,
          suspense_reason)
       VALUES ('bitnob', $1, $2::bigint, $3::bigint, $4::bigint, 'NGN', $5, $6, $7, $8, $9::bigint, $10)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        outcome.providerReference,
        outcome.ownerId,
        outcome.ownerId === undefined ? null : (account?.id ?? null),
        outcome.amountKobo.toString(),
        outcome.sender.name ?? null,
        outcome.sender.bank ?? null,
        outcome.sender.account ?? null,
        outcome.ownerId === undefined ? 'suspense' : 'credited',
        posted.entryId,
        outcome.suspenseReason ?? null,
      ],
    );

    if (outcome.ownerId === undefined) {
      // Loud: this is a real person's money sitting unattributed.
      this.#logger.error(
        `UNATTRIBUTED DEPOSIT ${outcome.providerReference} of ${outcome.amountKobo} kobo ` +
          `is held in suspense: ${outcome.suspenseReason}. A person must resolve it.`,
      );
    }
  }

  /**
   * A ceiling breach. The money is recorded and posted to suspense, never
   * credited and never dropped.
   */
  async #suspend(event: BitnobDepositEnvelope, error: DepositCeilingError): Promise<void> {
    this.#logger.error(
      `DEPOSIT ABOVE CEILING: ${event.data.id} — ${error.message} ` +
        `Held in suspense pending a human decision.`,
    );

    const posted = await this.ledger.post({
      idempotencyKey: `bitnob:${event.event_id}`,
      kind: 'wallet_funding',
      occurredAt: new Date(event.created_at),
      description: 'NGN deposit above ceiling, held for review',
      metadata: { provider_reference: event.data.id, suspense_reason: 'above_ceiling' },
      postings: [
        { account: { kind: 'suspense', currency: 'NGN' }, amountMinor: error.amountKobo, currency: 'NGN' },
        {
          account: { kind: 'provider_float', currency: 'NGN' },
          amountMinor: -error.amountKobo,
          currency: 'NGN',
        },
      ],
    });

    await this.pool.query(
      `INSERT INTO deposits
         (provider, provider_reference, amount_minor, currency, sender_name,
          sender_bank, sender_account, status, entry_id, suspense_reason)
       VALUES ('bitnob', $1, $2::bigint, 'NGN', $3, $4, $5, 'suspense', $6::bigint, $7)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        event.data.id,
        error.amountKobo.toString(),
        event.data.sender_name ?? null,
        event.data.sender_bank ?? null,
        event.data.sender_account_number ?? null,
        posted.entryId,
        `above ceiling: ${error.amountKobo} kobo > ${error.ceilingKobo}`,
      ],
    );
  }
}
