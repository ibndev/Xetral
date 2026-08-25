import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetentionService } from './retention.service.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * The retention sweep against a real database.
 *
 * `019_retention.test.sql` proves the RULES — that the ledger is untouched,
 * that a live token survives, that an undelivered message is never dropped.
 * What this covers is the half only the service can be wrong about: that it
 * reports what it deleted per table, that two instances racing produce one
 * sweep rather than two reports, and that the coverage view is readable
 * through the code an operations screen would call.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the retention e2e suite needs DATABASE_URL with the migrations applied');
}

let pool: Pool;
let retention: RetentionService;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  retention = new RetentionService(pool, testApiConfig(DATABASE_URL as string));
});

afterAll(async () => {
  await pool?.end();
});

describe('the retention sweep', () => {
  it('deletes what has aged out and names the table it came from', async () => {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
      [`retention-${randomUUID()}@example.ng`],
    );
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new Error('failed to seed user');

    const key = `retention-e2e-${randomUUID()}`;
    await pool.query(
      `INSERT INTO notification_outbox
         (user_id, kind, class, recipient, idempotency_key, status,
          sent_at, provider, provider_message_id, created_at)
       VALUES ($1::bigint, 'transfer_sent', 'transactional', 'aged@example.ng', $2,
               'sent', now() - INTERVAL '400 days', 'resend', 'msg_e2e',
               now() - INTERVAL '400 days')`,
      [userId, key],
    );

    const report = await retention.sweep();

    // A per-table report rather than one number. "Retention deleted 40,000
    // rows" is not something anybody can check.
    expect(report.deleted['notification_outbox']).toBeGreaterThan(0);
    expect(report.total).toBeGreaterThan(0);

    const left = await pool.query(
      `SELECT 1 FROM notification_outbox WHERE idempotency_key = $1`,
      [key],
    );
    expect(left.rowCount).toBe(0);
  });

  it('leaves the LEDGER exactly as it found it', async () => {
    // Asserted here as well as in SQL, because this is the object an operator
    // would ever call by hand — and the claim has to hold through the code
    // path they would use, not only through the function it wraps.
    const before = await pool.query<{ entries: string; postings: string }>(
      `SELECT (SELECT count(*) FROM journal_entries)::text AS entries,
              (SELECT count(*) FROM postings)::text        AS postings`,
    );

    await retention.sweep();

    const after = await pool.query<{ entries: string; postings: string }>(
      `SELECT (SELECT count(*) FROM journal_entries)::text AS entries,
              (SELECT count(*) FROM postings)::text        AS postings`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('does nothing while another instance holds the lock', async () => {
    /*
     * WRITTEN AS `Promise.all([sweep(), sweep()])` FIRST, AND THAT PROVED
     * NOTHING. A sweep on an empty-ish database finishes in milliseconds, so
     * the two ran one after the other, both acquired the lock in turn, and the
     * assertion that one of them backed off failed — not because the lock was
     * broken, but because there was never a moment when both wanted it. A test
     * whose outcome depends on which of two fast things finishes first passes
     * or fails by luck, in both directions.
     *
     * So the contention is made real: a separate connection takes the lock and
     * keeps it, and the sweep is asked to run while it is held.
     */
    const holder = await pool.connect();
    try {
      const took = await holder.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(8264100008::bigint) AS ok`,
      );
      expect(took.rows[0]?.ok).toBe(true);

      const blocked = await retention.sweep();
      expect(blocked.deleted).toEqual({});
      expect(blocked.total).toBe(0);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(8264100008::bigint)`);
      holder.release();
    }

    // And it runs again once the lock is free, so the back-off is not a wedge.
    const after = await retention.sweep();
    expect(Object.keys(after.deleted).length).toBeGreaterThan(0);
  });

  it('reports a decision for every table, and none UNDECIDED', async () => {
    // The same claim the invariant suite makes, read back through the call an
    // operations screen would make. A policy page that could show a table the
    // database has no decision about would be worse than no page.
    const coverage = await retention.coverage();
    expect(coverage.length).toBeGreaterThan(20);
    expect(coverage.filter((row) => row.decision === 'UNDECIDED')).toEqual([]);
    for (const row of coverage) {
      expect(row.rationale, `${row.table_name} has no stated reason`).toBeTruthy();
    }
  });
});
