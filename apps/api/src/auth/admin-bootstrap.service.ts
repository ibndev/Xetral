import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE } from '../tokens.js';

/**
 * THE FIRST GRANT, which is the one the dashboard cannot make.
 *
 * Every staff role is granted at `/v1/admin/staff`. That is a staff route, so
 * it requires a staff role, so on a fresh deployment there is an operations
 * dashboard that nobody alive can open. The documented way in was an INSERT
 * typed at a production psql prompt — correct, and it means finishing an
 * install requires opening a shell on the database holding customer money.
 * An install step that asks for that is an install step people do badly.
 *
 * So: name an address in the environment and the account holding it becomes
 * the first administrator at boot.
 *
 * WHAT KEEPS THIS FROM BEING A BACK DOOR is that it fires only into an empty
 * room. If any live `admin` grant exists — one, anywhere, held by anybody —
 * this does nothing and says so. The variable is therefore not a standing
 * privilege escalation: after the first boot it is inert, and it cannot be
 * used to add a second administrator, to restore a revoked one, or to reach
 * past a revocation. The one moment it has any power is the moment when
 * nobody has any.
 *
 * It is a deployment value and there is deliberately NO ENDPOINT. A request
 * that could mint the first administrator is a request worth forging, and it
 * would have to be reachable without authentication to be useful — which is
 * the shape of every "setup wizard" that was still live two years later.
 *
 * It also cannot manufacture an account. The address must already belong to a
 * registered, active user: somebody signs up through the ordinary form and is
 * then recognised, rather than an account appearing with a password only the
 * environment knows.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  readonly #logger = new Logger(AdminBootstrapService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = this.config.adminBootstrapEmail;
    if (email === undefined) return;

    try {
      await this.grantFirstAdmin(email);
    } catch (error: unknown) {
      // A failed bootstrap must never stop the API serving customers. The
      // consequence of swallowing it is a dashboard that stays shut, which an
      // operator discovers in seconds; the consequence of throwing is an API
      // that will not boot, which customers discover instead.
      this.#logger.error(
        `could not grant the first administrator to ${email}: ${describe(error)}. ` +
          `The API is serving normally; the dashboard is still closed.`,
      );
    }
  }

  /**
   * Grants `admin` to the named address, if and only if nobody holds it.
   *
   * One transaction, and the lock is what makes the "if nobody holds it" test
   * mean anything: two instances booting together would otherwise both read an
   * empty table and both grant. Only one of them can be the first, and it does
   * not matter which — what matters is that the check and the write cannot be
   * separated by another instance's write.
   *
   * Returns what it did, so a test can assert on the decision rather than on a
   * log line.
   */
  async grantFirstAdmin(email: string): Promise<'granted' | 'admin_exists' | 'no_such_account'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Serialises concurrent boots. A transaction advisory lock, so COMMIT or
      // ROLLBACK releases it and a process dying here cannot wedge the next.
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x7845_7A01]);

      const existing = await client.query<{ ok: boolean }>(
        `SELECT TRUE AS ok FROM staff_roles
          WHERE role = 'admin' AND revoked_at IS NULL LIMIT 1`,
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        this.#logger.log(
          `ADMIN_BOOTSTRAP_EMAIL is set and did nothing: an administrator already ` +
            `exists. Grant further roles in the dashboard, and unset the variable.`,
        );
        return 'admin_exists';
      }

      // Active only. A frozen or closed account must not be handed the
      // dashboard by a variable — freezing is how an account is taken out of
      // service, and this would put one back in.
      const user = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND status = 'active'`,
        [email],
      );
      const row = user.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        this.#logger.warn(
          `ADMIN_BOOTSTRAP_EMAIL names ${email}, which is not a registered active ` +
            `account. Sign up with that address first, then restart this instance.`,
        );
        return 'no_such_account';
      }

      await client.query(
        `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, 'admin', $1)`,
        [row.id],
      );

      // Attributed to the account itself, because nobody else exists yet to
      // attribute it to. An unattributed privilege is precisely what this log
      // exists to make impossible, and "it granted itself, at boot, from the
      // environment" is a true and legible answer to "how did this account get
      // approval rights?".
      await client.query(
        // The subject is passed a SECOND time rather than reusing $1. It is
        // the same value and two different types — `actor_id` is a bigint and
        // `subject_id` is text — and Postgres will not deduce one type for a
        // parameter used as both: it answers `inconsistent types deduced for
        // parameter $1` and the grant never happens. Found by booting, not by
        // the compiler, which has no opinion about the inside of a string.
        `INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, detail)
         VALUES ($1::bigint, 'staff.grant', 'user', $2::text,
                 jsonb_build_object('role', 'admin', 'via', 'ADMIN_BOOTSTRAP_EMAIL'))`,
        [row.id, row.id],
      );

      await client.query('COMMIT');
      this.#logger.warn(
        `Granted 'admin' to ${email} because no administrator existed. ` +
          `Enrol an authenticator at /admin/security — every staff route refuses ` +
          `until you do — then UNSET ADMIN_BOOTSTRAP_EMAIL.`,
      );
      return 'granted';
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
