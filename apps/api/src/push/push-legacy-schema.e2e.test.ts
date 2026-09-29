import 'reflect-metadata';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PushMessage, PushOutcome, PushPort } from '@xetral/providers';
import { testApiConfig } from '../test-support/api-config.js';
import { PushBroadcastService } from './push-broadcast.service.js';
import { PushService } from './push.service.js';

/**
 * ANNOUNCEMENTS ON A DATABASE THAT HAS NOT APPLIED 087.
 *
 * Production applies migrations by hand. The code reading `send_at` shipped,
 * 087 did not get applied, and the admin list answered 500 — along with the
 * customer's bell feed and the worker, which read the same columns. This
 * suite drops the two columns INSIDE A TRANSACTION, as the owner, drives the
 * real services over that connection, and rolls back: nothing any other
 * suite reads is changed once it finishes.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}
/** DDL needs the table's owner — 099 takes it away from the application. */
const OWNER_DATABASE_URL = process.env['DATABASE_OWNER_URL'] ?? DATABASE_URL;

class FakePush implements PushPort {
  readonly provider = 'fake';
  send(_message: PushMessage, tokens: readonly string[]): Promise<readonly PushOutcome[]> {
    return Promise.resolve(tokens.map((token) => ({ token, accepted: true, deviceGone: false })));
  }
}

let owner: Pool;
let client: PoolClient;
let service: PushService;
let worker: PushBroadcastService;
let staffUuid: string;

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: OWNER_DATABASE_URL, max: 1 });
  client = await owner.connect();
  await client.query('BEGIN');
  // CASCADE takes 087's view, index and CHECKs with them — exactly the state
  // of a database that never ran the file.
  await client.query(
    `ALTER TABLE push_broadcasts DROP COLUMN send_at CASCADE, DROP COLUMN cancelled_at CASCADE`,
  );
  // And 065's trigger function, which is what such a database runs: 087's
  // reads NEW.send_at, and left in place it would fail the worker's UPDATE
  // for a reason production never meets.
  await client.query(`
    CREATE OR REPLACE FUNCTION push_broadcasts_are_append_only()
    RETURNS TRIGGER AS $$
    BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'append-only'; END IF;
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.body IS DISTINCT FROM OLD.body
           OR NEW.country IS DISTINCT FROM OLD.country
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'immutable';
        END IF;
        IF OLD.sent_at IS NOT NULL THEN RAISE EXCEPTION 'already sent'; END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  const staff = await client.query<{ uuid: string }>(
    `INSERT INTO users (email, status, country)
     VALUES ('legacy-push-' || gen_random_uuid() || '@example.ng', 'active', 'NG')
     RETURNING uuid`,
  );
  staffUuid = staff.rows[0]!.uuid;

  // Every query the services issue goes through the one open transaction.
  const scoped = {
    query: client.query.bind(client),
    // The worker releases the lock connection it borrowed; this one is ours
    // until the ROLLBACK, so its release is a no-op on a wrapper.
    connect: () =>
      Promise.resolve({ query: client.query.bind(client), release: () => undefined }),
  } as unknown as Pool;
  service = new PushService(scoped);
  worker = new PushBroadcastService(scoped, testApiConfig(DATABASE_URL), new FakePush(), service);
});

afterAll(async () => {
  await client.query('ROLLBACK');
  client.release();
  await owner.end();
});

describe('announcements behind 087', () => {
  it('reports the schema as unscheduled', async () => {
    expect(await service.scheduling()).toBe(false);
  });

  it('lists, queues and reads the feed without the new columns', async () => {
    const queued = await service.queue(staffUuid, { title: 'Legacy', body: 'Old schema' });
    expect(queued.send_at).toBe(queued.created_at);
    expect(queued.cancelled_at).toBeNull();

    const history = await service.history(10);
    expect(history.some((b) => b.uuid === queued.uuid)).toBe(true);

    expect(await service.hasDue()).toBe(true);
    const feed = await service.announcementsFor(staffUuid);
    expect(feed.some((a) => a.uuid === queued.uuid)).toBe(true);
  });

  it('drains what is due', async () => {
    await worker.run();
    expect(await service.hasDue()).toBe(false);
  });

  it('refuses a schedule rather than sending it early', async () => {
    const later = new Date(Date.now() + 6 * 3600_000).toISOString();
    await expect(
      service.queue(staffUuid, { title: 'Tonight', body: 'Later', sendAt: later }),
    ).rejects.toMatchObject({ response: { error: 'scheduling_unavailable' } });
  });

  it('cannot cancel, because everything was due when written', async () => {
    const [first] = await service.history(1);
    await expect(service.cancel(first!.uuid)).rejects.toMatchObject({
      response: { error: 'broadcast_not_cancellable' },
    });
  });
});
