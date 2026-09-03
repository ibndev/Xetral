import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import {
  DepositCeilingError,
  handlePaystackDeposit,
  parsePaystackWebhook,
  verifyPaystackSignature,
} from '@xetral/providers';
import type { PaystackChargeEnvelope, PaystackDepositOutcome } from '@xetral/providers';
import { money, toMajor } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { FundingService } from './funding.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { NotificationService } from '../notifications/notification.service.js';

const PROVIDER = 'paystack';

/**
 * The webhook that creates customer money, on the default rail.
 *
 * The order of operations IS the security model, and it is the one
 * `DepositWebhookService` records for Bitnob:
 *
 *   1. Verify the signature against the RAW body, before parsing. No
 *      attacker-controlled bytes reach the JSON parser until they are proven
 *      to come from Paystack.
 *   2. Apply the ceiling. A breach is not credited.
 *   3. Resolve the account to a customer, or accept that we cannot.
 *   4. Post — to the customer, or to suspense. Never nothing.
 *
 * A SEPARATE SERVICE RATHER THAN A BRANCH INSIDE THE OTHER ONE. The two
 * payloads share no field names, sign with different credentials, and name
 * their events differently; a single handler with two paths through it would
 * be two handlers with a shared opportunity to apply the wrong one. What IS
 * shared — the ceiling, the suspense posting, the idempotency discipline —
 * lives in `@xetral/providers` and is imported by both.
 */
@Injectable()
export class PaystackWebhookService {
  readonly #logger = new Logger(PaystackWebhookService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(FundingService) private readonly funding: FundingService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderCredentialService)
    private readonly credentials: ProviderCredentialService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async handle(rawBody: string, headers: Record<string, string | undefined>): Promise<void> {
    /*
     * THE SAME KEY THAT AUTHORISES CALLS VERIFIES EVENTS.
     *
     * Paystack signs an inbound webhook with the secret key, so there is no
     * separate webhook secret — and reading it from the credential service
     * rather than the environment means a rotation during an incident takes
     * effect within the five-second cache rather than at the next restart.
     */
    const secret = await this.credentials.secretFor(
      PROVIDER,
      'secret_key',
      this.config.paystackSecretKey,
    );
    if (secret === undefined || secret === '') {
      // Refusing beats processing an unverifiable instruction to create money.
      //
      // 401 and not a bare throw: a bare Error becomes a 500, which pages
      // somebody over a stranger's probe, tells the sender we are broken
      // rather than unauthorised, and has the provider retry for ever.
      this.#logger.error(
        'no Paystack secret key is configured; refusing the deposit webhook',
      );
      throw new UnauthorizedException({ error: 'invalid_signature' });
    }

    // Verification precedes parsing, deliberately.
    if (!verifyPaystackSignature(rawBody, headers['x-paystack-signature'], secret)) {
      this.#logger.warn('paystack webhook rejected: signature did not verify');
      throw new UnauthorizedException({ error: 'invalid_signature' });
    }

    const event = parsePaystackWebhook(rawBody);

    let outcome: PaystackDepositOutcome;
    try {
      outcome = await handlePaystackDeposit(event, {
        // From settings, so raising the ceiling for a large expected transfer
        // is an audited change rather than a redeploy.
        ceilingKobo: await this.settings.depositCeilingKobo(),
        resolve: async (e) => this.#resolve(e),
      });
    } catch (error) {
      if (error instanceof DepositCeilingError) {
        // Money arrived and we will NOT credit it on these numbers. Held in
        // suspense and escalated: either the ceiling is too low for a
        // genuinely large transfer, or something is wrong with the amount —
        // and both are decisions for a person, not a webhook handler.
        await this.#suspend(event, error);
        return;
      }
      throw error;
    }

    await this.#record(outcome, event);
  }

  /** Which customer, if any, this landed on. */
  async #resolve(
    event: PaystackChargeEnvelope,
  ): Promise<{ ownerId: string | undefined; reason?: string }> {
    /*
     * BY THE NUBAN THE MONEY LANDED IN.
     *
     * Paystack's charge payload names the receiving account under
     * `authorization.receiver_bank_account_number`, and that number is UNIQUE
     * across `virtual_accounts` — it is the one thing about this event that
     * cannot mean two customers. The customer code is a second try for a
     * payload that omits it.
     */
    const account = await this.funding.resolveAccount(
      event.data.customer?.customer_code ?? undefined,
      event.data.authorization?.receiver_bank_account_number ?? undefined,
      PROVIDER,
    );

    if (account === undefined) {
      return {
        ownerId: undefined,
        // Deliberately does not echo the account number: it ends up in a
        // ledger entry that can never be redacted.
        reason: 'no virtual account matched this deposit',
      };
    }
    if (account.status === 'closed') {
      return { ownerId: undefined, reason: 'the account this landed on is closed' };
    }
    return { ownerId: account.user_id };
  }

  async #record(
    outcome: PaystackDepositOutcome,
    event: PaystackChargeEnvelope,
  ): Promise<void> {
    const posted = await this.ledger.post(outcome.intent);

    if (posted.replayed) {
      // A redelivery. The ledger already refused to move the money twice and
      // the deposits row already exists — so this is a SUCCESS, and the
      // handler must answer 2xx or Paystack retries for ever.
      this.#logger.log(`deposit ${outcome.providerReference} was already credited; replay`);
      return;
    }

    const account = await this.funding.resolveAccount(
      event.data.customer?.customer_code ?? undefined,
      event.data.authorization?.receiver_bank_account_number ?? undefined,
      PROVIDER,
    );

    await this.pool.query(
      `INSERT INTO deposits
         (provider, provider_reference, user_id, virtual_account_id, amount_minor,
          currency, sender_name, sender_bank, sender_account, status, entry_id,
          suspense_reason)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, 'NGN', $6, $7, $8, $9, $10::bigint, $11)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        PROVIDER,
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
      // And NO receipt. There is nobody to send one to — that is the whole
      // meaning of suspense — and guessing would tell the wrong customer that
      // money had arrived.
      return;
    }

    await this.#receipt(outcome);
  }

  /**
   * Money arrived and could not be credited on these numbers.
   *
   * It still arrived. Posting to suspense is the only honest record, and it
   * is what makes the money findable by a person rather than a line in a log.
   */
  async #suspend(event: PaystackChargeEnvelope, error: DepositCeilingError): Promise<void> {
    this.#logger.error(
      `deposit ${event.data.reference} of ${error.amountKobo} kobo exceeds the ` +
        `ceiling of ${error.ceilingKobo}; holding in suspense. ${error.message}`,
    );

    const currency = 'NGN' as const;
    const posted = await this.ledger.post({
      idempotencyKey: `${PROVIDER}:${event.data.reference}`,
      kind: 'wallet_funding',
      occurredAt: new Date(event.data.paid_at ?? Date.now()),
      description: 'NGN deposit held above the ceiling',
      metadata: {
        provider_reference: event.data.reference,
        suspense_reason: 'above the deposit ceiling',
      },
      postings: [
        {
          account: { kind: 'suspense', currency },
          amountMinor: error.amountKobo,
          currency,
        },
        {
          account: { kind: 'provider_float', currency },
          amountMinor: -error.amountKobo,
          currency,
        },
      ],
    });

    await this.pool.query(
      `INSERT INTO deposits
         (provider, provider_reference, user_id, amount_minor, currency,
          status, entry_id, suspense_reason)
       VALUES ($1, $2, NULL, $3::bigint, 'NGN', 'suspense', $4::bigint, $5)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        PROVIDER,
        event.data.reference,
        error.amountKobo.toString(),
        posted.entryId,
        'above the deposit ceiling',
      ],
    );
  }

  /**
   * Tell the customer their money arrived.
   *
   * Detached rather than joined to a transaction: the ledger entry has
   * already committed and the deposit row is written on the pool. Best-effort
   * by construction, because a webhook answering non-2xx over a receipt would
   * have Paystack redeliver a deposit that was already credited — turning a
   * missing email into a permanently retrying webhook.
   */
  async #receipt(outcome: PaystackDepositOutcome): Promise<void> {
    if (outcome.ownerId === undefined) return;

    const target = await this.pool.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1::bigint`,
      [outcome.ownerId],
    );
    const email = target.rows[0]?.email;
    if (email === null || email === undefined) return;

    await this.notifications.enqueueDetached({
      userId: outcome.ownerId,
      recipient: email,
      idempotencyKey: `receipt:${outcome.intent.idempotencyKey}`,
      request: {
        kind: 'deposit_credited',
        amount: toMajor(money(outcome.amountKobo, 'NGN')),
        currency: 'NGN',
        reference: outcome.providerReference,
      },
    });
  }
}
