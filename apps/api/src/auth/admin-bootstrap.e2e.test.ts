import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import type { ApiConfig } from '../config.js';

/**
 * The first grant, and — much more importantly — the fact that it happens
 * exactly once.
 *
 * `ADMIN_BOOTSTRAP_EMAIL` is the only thing in this system that hands out a
 * privilege without a privileged person asking for it, so the property worth
 * proving is not that it works. It is that it REFUSES the moment an
 * administrator exists: a variable that could grant a second one would be a
 * standing back door, and it would look identical in review to this.
 *
 * The suite builds the world it needs rather than asserting on whatever the
 * shared e2e database happens to hold — an earlier suite grants staff roles,
 * so a test that expected an empty table would pass or fail on file order.
 * It revokes the live admin grants, runs its own, and puts them back.
 * `fileParallelism: false` is what makes that safe.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error(
    'the e2e suite needs DATABASE_URL pointing at a database with the migrations applied',
  );
}

let pool: Pool;
let service: AdminBootstrapService;
/** The grants this suite stood down, restored in afterAll. */
let suspended: readonly string[] = [];

function configWith(email: string | undefined): ApiConfig {
  // Only the one field is read by grantFirstAdmin, and constructing a whole
  // ApiConfig here would couple this suite to every unrelated field added to
  // it later.
  return { adminBootstrapEmail: email } as unknown as ApiConfig;
}

async function seedActiveUser(): Promise<string> {
  const email = `bootstrap-${randomUUID()}@example.ng`;
  await pool.query(`INSERT INTO users (email, status) VALUES ($1, 'active')`, [email]);
  return email;
}

async function liveAdminCount(): Promise<number> {
  const rows = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM staff_roles WHERE role = 'admin' AND revoked_at IS NULL`,
  );
  return Number(rows.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  service = new AdminBootstrapService(pool, configWith(undefined));

  const standing = await pool.query<{ id: string }>(
    `UPDATE staff_roles SET revoked_at = now()
      WHERE role = 'admin' AND revoked_at IS NULL RETURNING id`,
  );
  suspended = standing.rows.map((r) => r.id);
});

afterAll(async () => {
  if (suspended.length > 0) {
    await pool.query(`UPDATE staff_roles SET revoked_at = NULL WHERE id = ANY($1::bigint[])`, [
      suspended,
    ]);
  }
  await pool?.end();
});

describe('the first administrator', () => {
  it('is granted when nobody holds admin, and recorded in the audit log', async () => {
    expect(await liveAdminCount()).toBe(0);
    const email = await seedActiveUser();

    expect(await service.grantFirstAdmin(email)).toBe('granted');
    expect(await liveAdminCount()).toBe(1);

    // Attributed, because an unattributed privilege is the thing this log
    // exists to prevent — and to itself, because nobody else exists yet.
    const audit = await pool.query<{ action: string; detail: { via?: string } }>(
      `SELECT a.action, a.detail FROM admin_audit_log a
         JOIN users u ON u.id = a.actor_id
        WHERE u.email = $1`,
      [email],
    );
    expect(audit.rows[0]?.action).toBe('staff.grant');
    expect(audit.rows[0]?.detail.via).toBe('ADMIN_BOOTSTRAP_EMAIL');
  });

  it('REFUSES once an administrator exists — the whole safety property', async () => {
    // The previous test left one standing. This is the state every boot after
    // the first is in, and the variable must be inert in it.
    expect(await liveAdminCount()).toBe(1);
    const second = await seedActiveUser();

    expect(await service.grantFirstAdmin(second)).toBe('admin_exists');
    expect(await liveAdminCount()).toBe(1);
  });

  it('cannot manufacture an account, and says so', async () => {
    // Prove it against an empty room, so the refusal is about the address
    // rather than about an administrator already existing.
    const restore = await pool.query<{ id: string }>(
      `UPDATE staff_roles SET revoked_at = now()
        WHERE role = 'admin' AND revoked_at IS NULL RETURNING id`,
    );
    try {
      expect(await service.grantFirstAdmin(`nobody-${randomUUID()}@example.ng`)).toBe(
        'no_such_account',
      );
      expect(await liveAdminCount()).toBe(0);
    } finally {
      await pool.query(`UPDATE staff_roles SET revoked_at = NULL WHERE id = ANY($1::bigint[])`, [
        restore.rows.map((r) => r.id),
      ]);
    }
  });

  it('will not hand the dashboard to a frozen account', async () => {
    // Freezing is how an account is taken out of service. A variable that put
    // one back in would undo a support action from the environment.
    const frozen = await seedActiveUser();
    await pool.query(`UPDATE users SET status = 'frozen' WHERE email = $1`, [frozen]);

    const restore = await pool.query<{ id: string }>(
      `UPDATE staff_roles SET revoked_at = now()
        WHERE role = 'admin' AND revoked_at IS NULL RETURNING id`,
    );
    try {
      expect(await service.grantFirstAdmin(frozen)).toBe('no_such_account');
      expect(await liveAdminCount()).toBe(0);
    } finally {
      await pool.query(`UPDATE staff_roles SET revoked_at = NULL WHERE id = ANY($1::bigint[])`, [
        restore.rows.map((r) => r.id),
      ]);
    }
  });

  it('does nothing at all when the variable is unset', async () => {
    const before = await liveAdminCount();
    await new AdminBootstrapService(pool, configWith(undefined)).onApplicationBootstrap();
    expect(await liveAdminCount()).toBe(before);
  });
});
