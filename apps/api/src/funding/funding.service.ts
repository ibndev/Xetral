import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import { ProviderTimeoutError } from '@xetral/providers';
import type { FundingPort } from '@xetral/providers';
import { toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { API_CONFIG, DATABASE, FUNDING_PORT, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * How a customer gets money into the platform.
 *
 * They are issued a dedicated Nigerian account number in their own name,
 * permanently. They transfer to it from any bank, and Bitnob tells us. That is
 * the whole product surface; almost all of the work is in making sure the
 * telling is believed exactly once.
 */

export interface VirtualAccountView {
  readonly account_number: string;
  readonly bank_name: string;
  readonly account_name: string;
  readonly currency: string;
  readonly status: string;
}

export interface DepositView {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly sender_name: string | null;
  readonly sender_bank: string | null;
  readonly created_at: string;
}

interface AccountRow {
  id: string;
  user_id: string;
  provider_account_id: string;
  account_number: string;
  bank_name: string;
  account_name: string;
  currency: string;
  status: string;
}

@Injectable()
export class FundingService {
  readonly #logger = new Logger(FundingService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(FUNDING_PORT) private readonly port: FundingPort,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * The customer's account, issued on first ask and returned for ever after.
   *
   * Idempotent by construction: the unique constraint on (user, currency)
   * means a second call cannot create a second number. That matters more here
   * than almost anywhere — a customer who saved the first number as a bank
   * beneficiary will keep paying into it, and a second account would receive
   * money nobody is watching.
   */
  /**
   * The account this customer already has, or nothing.
   *
   * READING IS NOT ISSUING, and the screen needs both as separate questions.
   * `accountFor` below CREATES one — it asks Bitnob, writes a row, and refuses
   * an unverified customer — so a page that called it merely to display a
   * number was opening a bank account as a side effect of being looked at.
   * That was survivable because issuing is idempotent, and it still meant the
   * only way to find out whether somebody had an account was to make sure they
   * did.
   *
   * `undefined` rather than a refusal: not having one is the resting state of
   * every new customer, not an error about them.
   */
  async existingAccount(userUuid: string): Promise<VirtualAccountView | undefined> {
    const userId = await this.#activeUserId(userUuid);
    const existing = await this.#accountOf(userId);
    return existing === undefined ? undefined : toAccountView(existing);
  }

  async accountFor(userUuid: string): Promise<VirtualAccountView> {
    const userId = await this.#activeUserId(userUuid);

    const existing = await this.#accountOf(userId);
    if (existing !== undefined) return toAccountView(existing);

    // Registering a customer with Bitnob is a KYC step with its own consent
    // and audit trail — the same rule Phase 5 applies to cards. A bank account
    // cannot be issued to an unidentified person, so we refuse rather than
    // registering somebody as a side effect of them tapping "add money".
    const providerCustomerId = await this.#providerCustomerId(userId);

    let issued;
    try {
      issued = await this.port.createVirtualAccount({
        providerCustomerId,
        currency: 'NGN',
        // Derived from our user id, so a retry after a timeout asks for the
        // same account rather than a second one.
        idempotencyKey: `xetral-va-${userId}-NGN`,
      });
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        // We do not know whether an account was created. Asking again is safe
        // BECAUSE the request carried an idempotency key; inventing one here
        // would make the retry a second account.
        throw new ServiceUnavailableException({ error: 'account_issue_pending' });
      }
      throw error;
    }

    const inserted = await this.pool.query<AccountRow>(
      `INSERT INTO virtual_accounts
         (user_id, provider, provider_account_id, account_number, bank_name,
          account_name, currency, status)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, 'NGN', $7)
       ON CONFLICT (user_id, currency) WHERE (status <> 'closed') DO NOTHING
       RETURNING id, user_id, provider_account_id, account_number, bank_name,
                 account_name, currency, status`,
      [
        userId,
        this.port.provider,
        issued.providerAccountId,
        issued.accountNumber,
        issued.bankName,
        issued.accountName,
        issued.active ? 'active' : 'pending',
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return toAccountView(row);

    // Two requests raced. The loser reads the winner's row rather than
    // failing — the customer asked once as far as they are concerned.
    const raced = await this.#accountOf(userId);
    if (raced === undefined) throw new Error('virtual account insert returned no row');
    return toAccountView(raced);
  }

  async deposits(userUuid: string): Promise<readonly DepositView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<{
      uuid: string;
      amount_minor: string;
      currency: string;
      sender_name: string | null;
      sender_bank: string | null;
      created_at: string;
    }>(
      `SELECT uuid, amount_minor, currency, sender_name, sender_bank, created_at
         FROM deposits
        WHERE user_id = $1::bigint AND status = 'credited'
        ORDER BY id DESC LIMIT 100`,
      [userId],
    );

    return rows.rows.map((r) => ({
      id: r.uuid,
      amount: toMajor({ amount: BigInt(r.amount_minor), currency: r.currency as Currency }),
      currency: r.currency,
      sender_name: r.sender_name,
      sender_bank: r.sender_bank,
      created_at: r.created_at,
    }));
  }

  /* ------------------------------------------------------------------ */

  /** Resolves the account a deposit landed on, by provider id or by NUBAN. */
  async resolveAccount(
    providerAccountId: string | undefined,
    accountNumber: string | undefined,
  ): Promise<AccountRow | undefined> {
    if (providerAccountId !== undefined) {
      const byId = await this.pool.query<AccountRow>(
        `SELECT id, user_id, provider_account_id, account_number, bank_name,
                account_name, currency, status
           FROM virtual_accounts WHERE provider = $1 AND provider_account_id = $2`,
        [this.port.provider, providerAccountId],
      );
      if (byId.rows[0] !== undefined) return byId.rows[0];
    }

    if (accountNumber !== undefined) {
      // The NUBAN is the fallback, not the primary: it is what a customer
      // types and what a provider may echo, but the provider's own id is the
      // thing that cannot be mistyped.
      const byNumber = await this.pool.query<AccountRow>(
        `SELECT id, user_id, provider_account_id, account_number, bank_name,
                account_name, currency, status
           FROM virtual_accounts WHERE account_number = $1`,
        [accountNumber],
      );
      if (byNumber.rows[0] !== undefined) return byNumber.rows[0];
    }

    return undefined;
  }

  async #accountOf(userId: string): Promise<AccountRow | undefined> {
    const result = await this.pool.query<AccountRow>(
      `SELECT id, user_id, provider_account_id, account_number, bank_name,
              account_name, currency, status
         FROM virtual_accounts
        WHERE user_id = $1::bigint AND currency = 'NGN' AND status <> 'closed'`,
      [userId],
    );
    return result.rows[0];
  }

  async #providerCustomerId(userId: string): Promise<string> {
    const result = await this.pool.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM provider_customers
        WHERE user_id = $1::bigint AND provider = $2`,
      [userId, this.port.provider],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ConflictException({ error: 'kyc_required', product: 'ngn_account' });
    }
    return row.provider_customer_id;
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

function toAccountView(row: AccountRow): VirtualAccountView {
  return {
    account_number: row.account_number,
    bank_name: row.bank_name,
    account_name: row.account_name,
    currency: row.currency,
    status: row.status,
  };
}
