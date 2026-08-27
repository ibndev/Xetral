import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { DATABASE, LEDGER } from '../tokens.js';
import { AuditService } from './audit.service.js';

/**
 * The operations surface.
 *
 * Everything here is something a person needs to do to run the platform, that
 * previously required either a developer or a psql session. The rule
 * throughout: an action that takes something from a customer records WHO did
 * it and WHY, before they are told it worked.
 */

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly kyc_status: string | null;
  readonly created_at: string;
}

@Injectable()
export class AdminService {
  readonly #logger = new Logger(AdminService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ------------------------------ overview ----------------------------- */

  /**
   * Everything waiting on a human, plus what the platform owes.
   *
   * One round trip for the queues and one for the liability, because a
   * dashboard that needs six queries to answer "is anything stuck?" is a
   * dashboard nobody opens.
   */
  async overview(): Promise<Record<string, unknown>> {
    const [queues, liability, recent] = await Promise.all([
      this.pool.query(`SELECT queue, waiting, oldest FROM admin_work_queue`),
      this.pool.query(
        `SELECT currency, wallets_minor::text, pending_minor::text, cards_minor::text,
                total_owed_minor::text, suspense_minor::text
           FROM admin_liability`,
      ),
      this.pool.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS entries_24h,
                COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')   AS entries_1h
           FROM journal_entries`,
      ),
    ]);

    return {
      queues: queues.rows,
      liability: liability.rows.map((row) => ({
        ...row,
        // Major units for display, minor units kept alongside. The dashboard
        // never does arithmetic on these — it shows what the ledger says.
        total_owed: toMajor({
          amount: BigInt((row as { total_owed_minor: string }).total_owed_minor),
          currency: (row as { currency: string }).currency as Currency,
        }),
      })),
      activity: recent.rows[0] ?? {},
    };
  }

  /**
   * The reconciliation figure that matters: is the ledger internally
   * consistent?
   *
   * `ledger_drift` compares each account's materialised balance against the
   * sum of its own postings. A non-empty result means a trigger did not fire
   * or somebody wrote around the ledger, and it is the one number an operator
   * should look at every morning.
   */
  async drift(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(`SELECT * FROM ledger_drift`);
    return rows.rows as Record<string, unknown>[];
  }

  /* -------------------------------- users ------------------------------ */

  async users(options: {
    readonly search?: string;
    readonly status?: string;
    readonly limit: number;
    readonly before?: string;
  }): Promise<readonly UserSummary[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.search !== undefined && options.search !== '') {
      params.push(`%${options.search.toLowerCase()}%`);
      clauses.push(`lower(u.email) LIKE $${params.length}`);
    }
    if (options.status !== undefined) {
      params.push(options.status);
      clauses.push(`u.status = $${params.length}`);
    }
    if (options.before !== undefined) {
      params.push(options.before);
      clauses.push(`u.id < $${params.length}::bigint`);
    }
    params.push(options.limit);

    const rows = await this.pool.query<UserSummary & { row_id: string }>(
      `SELECT u.id::text AS row_id, u.uuid AS id, u.email, u.status, u.created_at,
              (SELECT k.status::text FROM kyc_submissions k
                WHERE k.user_id = u.id ORDER BY k.id DESC LIMIT 1) AS kyc_status
         FROM users u
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY u.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.rows;
  }

  /** One customer, with everything an operator needs before acting. */
  async user(uuid: string): Promise<Record<string, unknown>> {
    const found = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

    const [profile, balances, devices, statusHistory, tierHistory, tierLimits] =
      await Promise.all([
      this.pool.query(
        `SELECT u.uuid AS id, u.email, u.status, u.created_at, u.kyc_tier,
                k.status::text AS kyc_status, k.full_name, k.bvn_last4, k.phone
           FROM users u
           LEFT JOIN kyc_submissions k
             ON k.user_id = u.id AND k.status IN ('approved','pending')
          WHERE u.id = $1::bigint`,
        [row.id],
      ),
      this.pool.query(
        `SELECT a.kind::text, a.currency, b.balance_minor::text
           FROM account_balances b JOIN accounts a ON a.id = b.account_id
          WHERE a.owner_id = $1::bigint ORDER BY a.currency, a.kind`,
        [row.id],
      ),
      this.pool.query(
        `SELECT platform, display_name, created_at, revoked_at
           FROM devices WHERE user_id = $1::bigint ORDER BY created_at DESC LIMIT 20`,
        [row.id],
      ),
      this.pool.query(
        `SELECT c.from_status, c.to_status, c.reason, c.created_at, a.email AS changed_by
           FROM user_status_changes c JOIN users a ON a.id = c.changed_by
          WHERE c.user_id = $1::bigint ORDER BY c.created_at DESC LIMIT 20`,
        [row.id],
      ),
      this.pool.query(
        `SELECT t.from_tier, t.to_tier, t.reason, t.changed_at, a.email AS changed_by
           FROM kyc_tier_changes t
           LEFT JOIN users a ON a.id = t.changed_by
          WHERE t.user_id = $1::bigint ORDER BY t.changed_at DESC LIMIT 20`,
        [row.id],
      ),
      // What this customer's tier actually allows, so an operator looking at a
      // refused transfer does not have to hold the grid in their head.
      this.pool.query(
        `SELECT l.currency, l.daily_limit_minor::text
           FROM users u JOIN kyc_tier_limits l ON l.tier = u.kyc_tier
          WHERE u.id = $1::bigint ORDER BY l.currency`,
        [row.id],
      ),
    ]);

    return {
      profile: profile.rows[0] ?? {},
      balances: balances.rows,
      devices: devices.rows,
      status_history: statusHistory.rows,
      tier_history: tierHistory.rows,
      tier_limits: tierLimits.rows,
    };
  }

  /**
   * Raises or lowers a customer's verification tier.
   *
   * SEPARATE FROM `setUserStatus`, deliberately. Freezing is a protective
   * action about an account's safety; a tier is a claim about what we know
   * about a person, and the two answer different questions. Conflating them
   * would mean unfreezing an account also restored a ceiling somebody removed
   * for a reason.
   *
   * A REASON IS REQUIRED IN BOTH DIRECTIONS. Raising one to enhanced is the act
   * that decides how much money may leave in a day, and the answer to "who
   * allowed this" has to exist. Lowering one takes something away from a
   * customer, which `admin_audit_log`'s CHECK already demands a reason for.
   */
  async setUserTier(
    uuid: string,
    tier: number,
    actorUuid: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updated = await client.query<{ id: string; kyc_tier: number }>(
        `UPDATE users SET kyc_tier = $2 WHERE uuid = $1::uuid RETURNING id, kyc_tier`,
        [uuid, tier],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

      // The trigger records the change; this fills in WHO and WHY, which the
      // trigger cannot know. Updating the row it just wrote is safe because
      // `kyc_tier_changes` is append-only only against later edits — this is
      // the same statement completing its own record.
      await client.query(
        `UPDATE kyc_tier_changes SET changed_by = $2::bigint, reason = $3
          WHERE id = (SELECT max(id) FROM kyc_tier_changes WHERE user_id = $1::bigint)`,
        [row.id, actorId, reason],
      );

      await client.query('COMMIT');
      return { id: uuid, kyc_tier: row.kyc_tier };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (
        error !== null &&
        typeof error === 'object' &&
        String((error as { message?: string }).message ?? '').includes('rests on the evidence')
      ) {
        throw new UnprocessableEntityException({ error: 'tier_skips_evidence' });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Freezes, unfreezes or closes an account.
   *
   * `users.status` is checked on every money path and nothing could change it
   * before this. Note that freezing does NOT touch balances: the money stays
   * the customer's and stays owed to them. Freezing stops it moving, which is
   * a different thing from taking it, and conflating the two is how a support
   * action becomes a seizure.
   */
  async setUserStatus(
    uuid: string,
    to: 'active' | 'frozen' | 'closed',
    actorUuid: string,
    reason: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const found = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

    if (row.status === to) {
      throw new ConflictException({ error: 'already_in_status', status: to });
    }
    if (row.status === 'closed') {
      // Closing is final. Reopening would resurrect an account somebody was
      // told no longer exists, and whose closure may have been a legal
      // requirement rather than a preference.
      throw new ConflictException({ error: 'account_closed' });
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET status = $2 WHERE id = $1::bigint`, [row.id, to]);
      await client.query(
        `INSERT INTO user_status_changes (user_id, from_status, to_status, changed_by, reason)
         VALUES ($1::bigint, $2, $3, $4::bigint, $5)`,
        [row.id, row.status, to, actorId, reason],
      );

      // Freezing revokes live sessions. Leaving them means a stolen session
      // keeps working for the rest of its access token's life on an account
      // somebody just decided was compromised.
      //
      // TWO THINGS HERE WERE WRONG and both were only visible against a real
      // database. The table is `auth_sessions`, not `sessions`, so freezing an
      // account — the most important thing support can do — raised and rolled
      // back every time. And `revocation_is_complete` requires the reason to
      // be set whenever `revoked_at` is: a bare timestamp fails the CHECK, so
      // even the right table name would have failed on the next line.
      if (to !== 'active') {
        await client.query(
          `UPDATE auth_sessions
              SET revoked_at = now(), revoked_reason = 'admin'
            WHERE user_id = $1::bigint AND revoked_at IS NULL`,
          [row.id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await this.audit.record({
      actorId: actorUuid,
      action: to === 'active' ? 'user.unfreeze' : to === 'frozen' ? 'user.freeze' : 'user.close',
      subjectType: 'user',
      subjectId: uuid,
      detail: { from: row.status, to },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });

    this.#logger.warn(`user ${uuid}: ${row.status} -> ${to} by ${actorUuid} (${reason})`);
    return { id: uuid, status: to };
  }

  /* ------------------------------ suspense ----------------------------- */

  async suspense(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT deposit_uuid, provider, provider_reference, amount_minor::text,
              currency, sender_name, sender_bank, suspense_reason, created_at,
              unresolved_for::text
         FROM admin_suspense LIMIT 200`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * Gives a suspense deposit to the customer it belongs to.
   *
   * By APPENDING a correcting entry, never by editing the original. The
   * original posting was a true statement — money arrived and we could not say
   * whose — and the correction is a second true statement made later. Editing
   * the first would erase the fact that we ever did not know.
   */
  async attributeDeposit(
    depositUuid: string,
    userUuid: string,
    actorUuid: string,
    reason: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const targetId = await this.#userId(userUuid);

    const found = await this.pool.query<{
      id: string;
      status: string;
      amount_minor: string;
      currency: string;
      provider_reference: string;
    }>(
      `SELECT id, status::text, amount_minor::text, currency, provider_reference
         FROM deposits WHERE uuid = $1`,
      [depositUuid],
    );
    const deposit = found.rows[0];
    if (deposit === undefined) throw new NotFoundException({ error: 'deposit_not_found' });
    if (deposit.status !== 'suspense') {
      throw new ConflictException({ error: 'not_in_suspense', status: deposit.status });
    }

    const currency = deposit.currency as Currency;
    const amount = money(BigInt(deposit.amount_minor), currency);

    await this.ledger.post({
      // Derived from the deposit, so a retry after a timeout is a replay
      // rather than a second credit.
      idempotencyKey: `suspense-attribute:${deposit.provider_reference}`,
      kind: 'adjustment',
      occurredAt: new Date(),
      description: 'suspense deposit attributed to a customer',
      metadata: { deposit: depositUuid, reason },
      postings: [
        posting({ kind: 'suspense', currency }, money(-amount.amount, currency)),
        posting({ kind: 'customer_wallet', ownerId: targetId, currency }, amount),
      ],
    });

    await this.pool.query(
      `UPDATE deposits SET status = 'credited', user_id = $2::bigint,
              virtual_account_id = (SELECT id FROM virtual_accounts
                                     WHERE user_id = $2::bigint AND currency = $3
                                       AND status <> 'closed' LIMIT 1)
        WHERE id = $1::bigint`,
      [deposit.id, targetId, deposit.currency],
    );

    await this.audit.record({
      actorId: actorUuid,
      action: 'deposit.attribute',
      subjectType: 'deposit',
      subjectId: depositUuid,
      detail: { to_user: userUuid, amount_minor: deposit.amount_minor, currency: deposit.currency },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });

    return { id: depositUuid, status: 'credited', user: userUuid };
  }

  /* ---------------------------- monitoring ----------------------------- */

  /** Held purchases and open crypto withdrawals — money waiting on an answer. */
  async stuck(): Promise<Record<string, unknown>> {
    const [purchases, withdrawals] = await Promise.all([
      this.pool.query(
        `SELECT purchase_uuid, provider, service, amount_minor::text, currency,
                created_at, held_for::text
           FROM pending_purchases LIMIT 100`,
      ),
      this.pool.query(
        `SELECT w.uuid, w.asset, w.network::text, w.amount_minor::text, w.status::text,
                w.created_at, w.tx_hash
           FROM crypto_withdrawals w
          WHERE w.status IN ('reserved','broadcast')
          ORDER BY w.created_at LIMIT 100`,
      ),
    ]);
    return { purchases: purchases.rows, crypto_withdrawals: withdrawals.rows };
  }

  /* ------------------------------- staff ------------------------------- */

  async staff(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT u.uuid AS user_id, u.email, r.role::text, r.granted_at,
              g.email AS granted_by
         FROM staff_roles r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users g ON g.id = r.granted_by
        WHERE r.revoked_at IS NULL
        ORDER BY r.granted_at DESC`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  async grantRole(
    userUuid: string,
    role: string,
    actorUuid: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const targetId = await this.#userId(userUuid);

    if (targetId === actorId) {
      // Granting yourself a role defeats the point of there being roles.
      throw new BadRequestException({ error: 'cannot_grant_to_self' });
    }

    await this.pool
      .query(
        `INSERT INTO staff_roles (user_id, role, granted_by)
         VALUES ($1::bigint, $2::staff_role, $3::bigint)`,
        [targetId, role, actorId],
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('staff_roles_live_grant')) {
          throw new ConflictException({ error: 'already_granted' });
        }
        throw new BadRequestException({ error: 'invalid_role', detail: message });
      });

    await this.audit.record({
      actorId: actorUuid,
      action: 'staff.grant',
      subjectType: 'staff',
      subjectId: userUuid,
      detail: { role },
      ...(ip === undefined ? {} : { ip }),
    });

    return { user: userUuid, role };
  }

  async revokeRole(
    userUuid: string,
    role: string,
    actorUuid: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const targetId = await this.#userId(userUuid);

    const revoked = await this.pool.query(
      `UPDATE staff_roles SET revoked_at = now()
        WHERE user_id = $1::bigint AND role = $2::staff_role AND revoked_at IS NULL`,
      [targetId, role],
    );
    if (revoked.rowCount === 0) {
      throw new NotFoundException({ error: 'grant_not_found' });
    }

    await this.audit.record({
      actorId: actorUuid,
      action: 'staff.revoke',
      subjectType: 'staff',
      subjectId: userUuid,
      detail: { role },
      ...(ip === undefined ? {} : { ip }),
    });

    // Roles are read fresh on every request, so this takes effect on the
    // target's very next call rather than when their token expires.
    return { user: userUuid, role, revoked: true };
  }

  async #userId(uuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }
}
