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
import type { FundingPort } from '@xetral/providers';
import { API_CONFIG, DATABASE, FUNDING_PORT } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { isTestEmail, isTestPhone } from '../auth/test-accounts.js';

export interface TestAccountReset {
  readonly reset: true;
  /** What went, in the words the reset log carries. */
  readonly removed: string;
  /** Money the retired account still holds, in minor units, or null. */
  readonly left_behind: string | null;
  /** Account numbers switched off at the rail that issued them. */
  readonly account_numbers_deactivated: number;
  /** Account numbers on a rail with no switch-off call: still live there. */
  readonly account_numbers_left_live: number;
}

/**
 * RESETTING A TEST ACCOUNT so its email and phone register again as a
 * brand-new customer — and only an account on the operator's list.
 *
 * THE ACCOUNT IS RETIRED, NOT DELETED. `reset_test_account()` (091) removes
 * what can go and releases the email, phone and BVN; the ledger, audit log,
 * consent records and sign-in history stay attached to a row nobody can sign
 * in with, because they are append-only by trigger and a reset that could
 * remove them could be pointed at evidence. Every other account's delete path
 * is untouched.
 *
 * THE ACCOUNT NUMBER IS SWITCHED OFF AT THE RAIL FIRST. Paystack keys a
 * customer on the email address, so the same address registered again is the
 * same customer there and would be handed the same live number — which our
 * immutable row still names as the retired account's. Switched off, the next
 * registration is issued a fresh one. A rail that refuses stops the reset
 * before anything here changes, rather than leaving a live number behind a
 * closed row.
 */
@Injectable()
export class TestAccountService {
  readonly #logger = new Logger('TestAccounts');

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(FUNDING_PORT) private readonly funding: FundingPort,
  ) {}

  /**
   * Which account an identifier names, refused with 403 unless it is on the
   * list. An email is anything with an `@`; anything else is a phone, written
   * in E.164 as the list and the rows are.
   */
  #identify(identifier: string): { readonly email?: string; readonly phone?: string } {
    const raw = identifier.trim();
    if (raw.includes('@')) {
      const email = raw.toLowerCase();
      if (!isTestEmail(this.config, email)) {
        throw new ForbiddenException({ error: 'test_account_not_whitelisted' });
      }
      return { email };
    }
    const digits = raw.replace(/[\s-]/g, '');
    const phone = digits.startsWith('+') ? digits : `+${digits}`;
    if (!isTestPhone(this.config, phone)) {
      throw new ForbiddenException({ error: 'test_account_not_whitelisted' });
    }
    return { phone };
  }

  async reset(identifier: string, actorUuid: string): Promise<TestAccountReset> {
    const who = this.#identify(identifier);

    const found = await this.pool.query<{ id: string; uuid: string; staff: boolean }>(
      `SELECT u.id::text, u.uuid::text,
              EXISTS (SELECT 1 FROM staff_roles s
                       WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS staff
         FROM users u
        WHERE ($1::text IS NOT NULL AND lower(u.email) = $1)
           OR ($2::text IS NOT NULL AND u.phone = $2)
        ORDER BY u.id
        LIMIT 1`,
      [who.email ?? null, who.phone ?? null],
    );
    const user = found.rows[0];
    if (user === undefined) throw new NotFoundException({ error: 'test_account_not_found' });

    // BEFORE the rail is asked: a staff account's number must not be switched
    // off for a reset the database will refuse anyway.
    if (user.staff) throw new ConflictException({ error: 'test_account_is_staff' });

    const actor = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM users WHERE uuid = $1::uuid`,
      [actorUuid],
    );
    const actorId = actor.rows[0]?.id;
    if (actorId === undefined) throw new Error('reset requested by an unknown staff member');

    const { deactivated, leftLive } = await this.#deactivateNumbers(user.id);

    let removed: string;
    try {
      const result = await this.pool.query<{ removed: string }>(
        `SELECT reset_test_account($1::bigint, $2::bigint) AS removed`,
        [user.id, actorId],
      );
      removed = result.rows[0]?.removed ?? '';
    } catch (error) {
      if ((error as { code?: unknown }).code === '23001') {
        throw new ConflictException({ error: 'test_account_is_staff' });
      }
      throw error;
    }

    const logged = await this.pool.query<{ left_behind: string | null }>(
      `SELECT left_behind FROM test_account_resets
        WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 1`,
      [user.id],
    );
    const leftBehind = logged.rows[0]?.left_behind ?? null;

    // WHO, WHICH ACCOUNT, WHEN — the log line, beside the row 091 wrote and
    // the audit entry the controller writes. The account is named by its
    // uuid: an address in a log line outlives every retention rule here.
    this.#logger.warn(
      `test account ${user.uuid} reset by staff ${actorUuid} at ${new Date().toISOString()}` +
        ` (${removed}${leftBehind === null ? '' : `; still holds ${leftBehind}`})`,
    );

    return {
      reset: true,
      removed,
      left_behind: leftBehind,
      account_numbers_deactivated: deactivated,
      account_numbers_left_live: leftLive,
    };
  }

  /**
   * Every live account number the retired account holds, switched off at the
   * rail that issued it — read off the ROW, like every other account read,
   * because the id means something only to its issuer.
   */
  async #deactivateNumbers(
    userId: string,
  ): Promise<{ readonly deactivated: number; readonly leftLive: number }> {
    const accounts = await this.pool.query<{ provider: string; provider_account_id: string }>(
      `SELECT provider, provider_account_id FROM virtual_accounts
        WHERE user_id = $1::bigint AND status <> 'closed'`,
      [userId],
    );
    const switching = this.funding as FundingPort & {
      deactivateAt?: (provider: string, providerAccountId: string) => Promise<boolean>;
    };

    let deactivated = 0;
    let leftLive = 0;
    for (const account of accounts.rows) {
      if (typeof switching.deactivateAt !== 'function') {
        leftLive += 1;
        continue;
      }
      try {
        if (await switching.deactivateAt(account.provider, account.provider_account_id)) {
          deactivated += 1;
        } else {
          leftLive += 1;
        }
      } catch (error) {
        // The rail's sentence names our integration, so it goes to the log;
        // the operator gets a code and nothing here has changed yet.
        this.#logger.error(
          `could not switch off ${account.provider} account ${account.provider_account_id} ` +
            `for a test reset: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new ServiceUnavailableException({ error: 'test_account_provider_refused' });
      }
    }
    return { deactivated, leftLive };
  }
}
