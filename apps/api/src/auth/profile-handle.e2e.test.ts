import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * Changing a payment handle, over HTTP, against a real database.
 *
 * The claim worth proving here is 039's, from the other side: a handle is
 * never reissued, so changing one must RELEASE the old handle into history
 * and leave it unavailable to everybody — including the customer who just
 * gave it up. If that were wrong, a payment link somebody posted in a message
 * thread last month would start paying a stranger, and nobody re-reads a link
 * they have already shared.
 *
 * It is also the shape of failure this codebase keeps hitting: an UPDATE in a
 * SQL string, a trigger that raises `unique_violation` from a place the
 * compiler cannot see, and a route whose PIN is enforced by the guard rather
 * than by the handler. None of that is visible to a unit test.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '317204';

let pool: Pool;
let app: INestApplication;

interface Person {
  email: string;
  token: string;
}

async function register(): Promise<Person> {
  const email = `handle-${randomUUID()}@example.ng`;
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      full_name: 'Handle Test Person',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  const token = created.body.access_token as string;
  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { email, token };
}

const mine = (person: Person) =>
  request(app.getHttpServer())
    .get('/v1/auth/profile')
    .set('Authorization', `Bearer ${person.token}`);

const choose = (person: Person, handle: string, pin: string = PIN) =>
  request(app.getHttpServer())
    .post('/v1/auth/profile/handle')
    .set('Authorization', `Bearer ${person.token}`)
    .send({ handle, transaction_pin: pin });

/** Short, lowercase and unique per run — these suites share one database and
 *  a handle claimed by an earlier run is claimed for ever, by design. */
const fresh = (): string => `h${randomUUID().replace(/-/g, '').slice(0, 12)}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config: testApiConfig(DATABASE_URL as string), pool, clock: systemClock }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('changing a payment handle', () => {
  it('replaces it, and the old one is recorded as released', async () => {
    const person = await register();
    const before = await mine(person).expect(200);
    const old = before.body.handle as string;
    expect(old).toMatch(/^[a-z0-9][a-z0-9_]+[a-z0-9]$/);

    const wanted = fresh();
    const changed = await choose(person, wanted).expect(200);
    expect(changed.body.handle).toBe(wanted);

    // Read back through the API, not out of the response, because the two
    // could disagree — the response is what the handler built and this is
    // what the next request will see.
    const after = await mine(person).expect(200);
    expect(after.body.handle).toBe(wanted);

    const history = await pool.query<{ handle: string; released_at: Date | null }>(
      `SELECT handle, released_at FROM handle_history WHERE handle = ANY($1::text[])`,
      [[old, wanted]],
    );
    const rows = new Map(history.rows.map((r) => [r.handle, r.released_at]));
    expect(rows.get(old), 'the old handle stays in history').not.toBeUndefined();
    expect(rows.get(old), 'and is marked released').not.toBeNull();
    expect(rows.get(wanted), 'the new one is claimed').toBeNull();
  });

  it('never gives a released handle to somebody else, and does give it back to its owner', async () => {
    const person = await register();
    const old = ((await mine(person).expect(200)).body as { handle: string }).handle;
    await choose(person, fresh()).expect(200);

    // THE CASE THAT COSTS MONEY. A link posted in a message thread last
    // month must not start paying a stranger, so a handle its owner has
    // released is still taken — `handle_history` keeps it and 039's trigger
    // refuses it to any OTHER user id.
    const other = await register();
    const stolen = await choose(other, old).expect(409);
    expect(stolen.body.error).toBe('handle_taken');

    // AND THE ASYMMETRY IS DELIBERATE, which is why it is asserted rather
    // than left to be discovered. The same person taking their own handle
    // back is safe for exactly the reason a stranger taking it is not: every
    // link already pointing at it goes on paying the same person. Refusing
    // this would make an accidental change permanent for no benefit.
    const back = await choose(person, old).expect(200);
    expect(back.body.handle).toBe(old);
  });

  it('refuses a handle somebody else is holding right now', async () => {
    const holder = await register();
    const wanted = fresh();
    await choose(holder, wanted).expect(200);

    const other = await register();
    const refused = await choose(other, wanted).expect(409);
    expect(refused.body.error).toBe('handle_taken');
  });

  it('accepts what a customer actually types: a pasted @ and a capital', async () => {
    const person = await register();
    const wanted = fresh();
    // A phone keyboard capitalises the first letter and a handle copied out
    // of a message carries its `@`. Neither is a mistake to refuse — and the
    // stored value must be the lowercase one, or `@Olawale` and `@olawale`
    // become two people.
    const changed = await choose(person, `@${wanted.toUpperCase()}`).expect(200);
    expect(changed.body.handle).toBe(wanted);
  });

  it('refuses a shape the database would refuse', async () => {
    const person = await register();
    for (const bad of ['ab', '_leading', 'trailing_', 'has space', 'Wayyyyy_too_long_for_a_handle']) {
      const refused = await choose(person, bad);
      expect([400, 409], `"${bad}" should not be accepted`).toContain(refused.status);
      expect(refused.body.error).not.toBe(undefined);
    }
  });

  it('refuses without the transaction PIN, and the handle does not move', async () => {
    const person = await register();
    const before = ((await mine(person).expect(200)).body as { handle: string }).handle;

    // The guard verifies the PIN before the handler runs, so a wrong one must
    // never reach `choose()`. Asserting the handle afterwards is what proves
    // that rather than assuming it. 401 `invalid_pin` is the contract every
    // PIN'd route already answers with — see `wallet.e2e.test.ts`.
    const refused = await choose(person, fresh(), '000000').expect(401);
    expect(refused.body.error).toBe('invalid_pin');

    const after = ((await mine(person).expect(200)).body as { handle: string }).handle;
    expect(after).toBe(before);
  });
});
