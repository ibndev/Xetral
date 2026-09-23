import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { supportsDepositVerification } from '@xetral/providers';
import type { FundingPort, VerifiedDeposit } from '@xetral/providers';
import { money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { DATABASE, FUNDING_PORT, LEDGER } from '../tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationService } from '../notifications/notification.service.js';

const PROVIDER = 'flutterwave';

export type FlutterwaveDepositOutcome =
  | 'credited'
  | 'replayed'
  | 'suspense'
  /** No account of ours was opened under this reference. */
  | 'not_ours'
  /** Flutterwave does not call it successful — nothing to credit yet. */
  | 'not_settled';

interface AccountRow {
  readonly id: string;
  readonly user_id: string;
  readonly currency: string;
  readonly status: string;
}

/**
 * Money arriving in a Flutterwave DEDICATED ACCOUNT NUMBER.
 *
 * WHY THIS EXISTS. Every Flutterwave `charge.completed` went to the payment
 * link settler, which knows about checkouts. A transfer into a customer's
 * permanent account number is also a `charge.completed` — so the day naira
 * account numbers moved to Flutterwave, every deposit into one would have
 * been handed to a settler that found no such link and acknowledged it. The
 * money would be in our Flutterwave balance and in nobody's wallet, with
 * nothing retrying: 008's lost-webhook failure, caused by our own routing.
 *
 * WHAT IT TRUSTS: the reference on the event decides only WHETHER TO ASK.
 * Flutterwave does not sign the body, so the amount, the currency and the
 * status on the payload are a claim by whoever holds one shared secret. The
 * deposit is re-read by THEIR transaction id and credited on that answer —
 * and the account it credits is the one the VERIFIED reference names, not
 * the one the payload named.
 *
 * THE KEY IS `flutterwave:<transaction id>`, the same one the reconciliation
 * sweep derives from the same list, so whichever of the two arrives second is
 * a replay at the ledger.
 */
@Injectable()
export class FlutterwaveDepositService {
  readonly #logger = new Logger(FlutterwaveDepositService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(FUNDING_PORT) private readonly port: FundingPort,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /**
   * Whether this reference names one of OUR Flutterwave accounts.
   *
   * A database read and nothing else, so a checkout event costs no extra call
   * to Flutterwave on its way to the link settler.
   */
  async isAccountReference(reference: string): Promise<boolean> {
    return (await this.#accountFor(reference)) !== undefined;
  }

  async credit(transactionId: string): Promise<FlutterwaveDepositOutcome> {
    const verified = await this.#verify(transactionId);
    if (verified === undefined) return 'not_settled';

    const account =
      verified.accountReference === undefined
        ? undefined
        : await this.#accountFor(verified.accountReference);
    if (account === undefined) return 'not_ours';

    /*
     * THREE REASONS NOT TO CREDIT, and each still records the money. It
     * arrived whatever we can work out about it — 006's rule — so it goes to
     * SUSPENSE with the reason, where a person can find it.
     */
    let suspense: string | undefined;
    if (account.status === 'closed') {
      suspense = 'the account this landed on is closed';
    } else if (account.currency !== verified.currency) {
      // A cedi amount posted to a naira wallet is Phase 10's kobo-and-cents
      // mistake with a customer's balance on the end of it.
      suspense = `arrived in ${verified.currency} on a ${account.currency} account`;
    } else if (
      verified.currency === 'NGN' &&
      verified.amountMinor > (await this.settings.depositCeilingKobo())
    ) {
      // The ceiling is published in kobo and is a statement about naira only.
      suspense = 'above the deposit ceiling';
    }

    const currency = verified.currency;
    const amount = money(verified.amountMinor, currency);
    const posted = await this.ledger.post({
      idempotencyKey: `${PROVIDER}:${verified.providerReference}`,
      kind: 'wallet_funding',
      occurredAt: verified.occurredAt,
      description:
        suspense === undefined ? `${currency} deposit` : `${currency} deposit held in suspense`,
      metadata: {
        provider_reference: verified.providerReference,
        ...(suspense === undefined ? {} : { suspense_reason: suspense }),
      },
      postings: [
        posting(
          suspense === undefined
            ? { kind: 'customer_wallet', ownerId: account.user_id, currency }
            : { kind: 'suspense', currency },
          amount,
        ),
        posting({ kind: 'provider_float', currency }, money(-verified.amountMinor, currency)),
      ],
    });

    await this.pool.query(
      `INSERT INTO deposits
         (provider, provider_reference, user_id, virtual_account_id, amount_minor,
          currency, sender_name, sender_bank, sender_account, status, entry_id,
          suspense_reason)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, $6, $7, $8, $9, $10, $11::bigint, $12)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        PROVIDER,
        verified.providerReference,
        suspense === undefined ? account.user_id : null,
        suspense === undefined ? account.id : null,
        verified.amountMinor.toString(),
        currency,
        verified.senderName ?? null,
        verified.senderBank ?? null,
        verified.senderAccount ?? null,
        suspense === undefined ? 'credited' : 'suspense',
        posted.entryId,
        suspense ?? null,
      ],
    );

    if (posted.replayed) return 'replayed';
    if (suspense !== undefined) {
      this.#logger.error(
        `FLUTTERWAVE DEPOSIT ${verified.providerReference} is held in suspense: ${suspense}. ` +
          `A person must resolve it.`,
      );
      return 'suspense';
    }

    await this.#receipt(account.user_id, verified, currency);
    return 'credited';
  }

  async #verify(transactionId: string): Promise<VerifiedDeposit | undefined> {
    const switching = this.port as FundingPort & {
      verifyDepositAt?: (provider: string, ref: string) => Promise<VerifiedDeposit | undefined>;
    };
    if (typeof switching.verifyDepositAt === 'function') {
      return switching.verifyDepositAt(PROVIDER, transactionId);
    }
    // A single-rail deployment: only ask it if it IS this rail.
    if (this.port.provider === PROVIDER && supportsDepositVerification(this.port)) {
      return this.port.verifyDeposit(transactionId);
    }
    return undefined;
  }

  async #accountFor(reference: string): Promise<AccountRow | undefined> {
    const found = await this.pool.query<AccountRow>(
      `SELECT id, user_id, currency, status FROM virtual_accounts
        WHERE provider = $1 AND provider_customer_ref = $2
        ORDER BY id LIMIT 1`,
      [PROVIDER, reference],
    );
    return found.rows[0];
  }

  /**
   * Best effort, and DETACHED from the webhook's answer: a missing email must
   * not become a non-2xx that makes Flutterwave redeliver a deposit we have
   * already credited.
   */
  async #receipt(userId: string, deposit: VerifiedDeposit, currency: Currency): Promise<void> {
    try {
      const target = await this.pool.query<{ email: string | null }>(
        `SELECT email FROM users WHERE id = $1::bigint`,
        [userId],
      );
      const email = target.rows[0]?.email;
      if (email === null || email === undefined) return;
      await this.notifications.enqueueDetached({
        userId,
        recipient: email,
        idempotencyKey: `receipt:${PROVIDER}:${deposit.providerReference}`,
        request: {
          kind: 'deposit_credited',
          amount: toMajor(money(deposit.amountMinor, currency)),
          currency,
          reference: deposit.providerReference,
        },
      });
    } catch (error: unknown) {
      this.#logger.warn(
        `deposit ${deposit.providerReference} credited; its receipt was not queued: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
