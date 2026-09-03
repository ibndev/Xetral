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
import type { FundingCustomer, FundingPort } from '@xetral/providers';
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

    /*
     * KYC IS NO LONGER ASKED FOR HERE, and that is a correction rather than a
     * relaxation.
     *
     * This used to refuse anybody without a `provider_customers` row, on the
     * reasoning that "a bank account cannot be issued to an unidentified
     * person". That is true of BITNOB, which will not issue one without a
     * verified BVN. It is not true of the rail: CBN's tiered KYC permits a
     * tier 1 account on a name and a phone number, and
     * `029_kyc_tiers.seed.sql` has capped tier 0 at ₦50,000 a day since it
     * landed. So the platform enforced the tier 1 ceiling and refused the
     * account that ceiling is for — on the screen a customer opens in order
     * to put money in, which read as "you may not deposit until you verify".
     *
     * The requirement did not disappear; it moved to where it is true. The
     * Bitnob adapter refuses an unverified customer in its own code, with its
     * own reason, and the Paystack adapter does not need to.
     *
     * The mapping is still PASSED when we have one — a customer who has been
     * through KYC should not get a second provider-side customer record.
     */
    const customer = await this.#fundingCustomer(userId);

    let issued;
    try {
      issued = await this.port.createVirtualAccount({
        customer,
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
         (user_id, provider, provider_account_id, provider_customer_ref,
          account_number, bank_name, account_name, currency, status)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, 'NGN', $8)
       ON CONFLICT (user_id, currency) WHERE (status <> 'closed') DO NOTHING
       RETURNING id, user_id, provider_account_id, account_number, bank_name,
                 account_name, currency, status`,
      [
        userId,
        // WHO ACTUALLY ISSUED IT, off the account rather than off the port.
        // The port is a switch whose `provider` is the configured default, so
        // reading it here would relabel this row the moment an operator
        // changed the setting — and the row is what routes every later read
        // and every webhook back to the rail that holds the money.
        issued.provider,
        issued.providerAccountId,
        issued.providerCustomerRef ?? null,
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
  /**
   * Which account a deposit landed on.
   *
   * THE PROVIDER IS AN ARGUMENT, NOT `this.port.provider`, and that changed
   * when a second rail landed. The port is now a switch whose `provider` is
   * the CONFIGURED DEFAULT, so filtering on it would have stopped resolving
   * every Bitnob-issued account the moment an operator set the default to
   * Paystack — and an unresolvable deposit does not fail loudly. It posts to
   * SUSPENSE, which is correct behaviour for money we cannot attribute and
   * completely wrong as a consequence of a settings change.
   *
   * A caller that knows which rail told it — every webhook does — passes it.
   */
  async resolveAccount(
    providerAccountId: string | undefined,
    accountNumber: string | undefined,
    provider?: string,
  ): Promise<AccountRow | undefined> {
    if (providerAccountId !== undefined) {
      const byId = await this.pool.query<AccountRow>(
        `SELECT id, user_id, provider_account_id, account_number, bank_name,
                account_name, currency, status
           FROM virtual_accounts
          WHERE provider_account_id = $2
            AND ($1::text IS NULL OR provider = $1)`,
        [provider ?? null, providerAccountId],
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

  /**
   * Who the account is for, from what the platform already holds.
   *
   * `users.full_name` is what somebody typed about themselves at signup, and
   * 040 is explicit that it is NOT the verified name — `kyc_submissions.full_name`
   * is what a reviewer read off a document, and only that one may inform a
   * money decision. Opening a tier 1 account is not a money decision about
   * WHO somebody is; it is giving them somewhere to be paid, under a ceiling
   * that already assumes they are unverified. So the signup name is the right
   * one to use here and would be the wrong one on a card.
   *
   * The provider mapping is passed when it exists, so a verified customer
   * does not acquire a second customer record at the provider.
   */
  async #fundingCustomer(userId: string): Promise<FundingCustomer> {
    const result = await this.pool.query<{
      email: string | null;
      full_name: string | null;
      phone: string | null;
      provider_customer_id: string | null;
    }>(
      `SELECT u.email, u.full_name, u.phone,
              (SELECT pc.provider_customer_id FROM provider_customers pc
                WHERE pc.user_id = u.id AND pc.provider = $2) AS provider_customer_id
         FROM users u WHERE u.id = $1::bigint`,
      [userId, this.port.provider],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });

    if (row.email === null || row.email === '') {
      // Every rail keys a customer on an email address, and this one cannot
      // be null for a registered account. Refusing here names the reason
      // rather than letting a provider answer with its own wording.
      throw new ConflictException({ error: 'profile_incomplete', field: 'email' });
    }

    const { firstName, lastName } = splitName(row.full_name);
    return {
      reference: userId,
      email: row.email,
      firstName,
      lastName,
      phone: row.phone ?? undefined,
      providerCustomerId: row.provider_customer_id ?? undefined,
    };
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

/**
 * One name field into the two every provider asks for.
 *
 * `users.full_name` is one string because that is how a person writes their
 * own name, and both rails want it split. The last word is the surname and
 * everything before it is the rest — which is right for "Ada Obi" and for
 * "Adebayo Olusegun Adeyemi", and wrong for a mononym, where the given name
 * is empty and a provider may refuse.
 *
 * A mononym therefore repeats the single word into both halves rather than
 * sending an empty one: an account opened under "Ada Ada" is a correctable
 * cosmetic problem, and a refused account is a customer who cannot be paid.
 */
export function splitName(fullName: string | null): {
  firstName: string;
  lastName: string;
} {
  const parts = (fullName ?? '').trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return { firstName: 'Xetral', lastName: 'Customer' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1] as string,
  };
}
