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
 * The customer's own account, over HTTP, against a real database.
 *
 * THERE WAS NO SCREEN AT ALL. Settings carried the PIN, the theme, consent and
 * the two data rights, and nothing anywhere showed a customer what the account
 * holds about them — so an account whose `full_name` was null greeted them as
 * "there" for ever, with no way to fill it in.
 *
 * What only a round trip can prove here is the pair a unit test cannot see:
 * that the details read survives the LEFT JOIN to `countries` — the join that
 * took `describeSession` down and returned every field as null — and that the
 * name written by the POST is the name the next GET returns. A SQL string is
 * invisible to TypeScript, which is how a statement naming `$9` against an
 * array of eight answered 500 on every card issue with the compiler entirely
 * satisfied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';

let pool: Pool;
let app: INestApplication;

interface Person {
  email: string;
  token: string;
  phone: string;
}

async function register(): Promise<Person> {
  const email = `details-${randomUUID()}@example.ng`;
  const national = String(8000000000 + Math.floor(Math.random() * 999999999));
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      full_name: 'Original Name',
      country: 'NG',
      phone: national,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  return { email, token: created.body.access_token as string, phone: `+234${national}` };
}

const details = (person: Person) =>
  request(app.getHttpServer())
    .get('/v1/auth/profile/details')
    .set('Authorization', `Bearer ${person.token}`);

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

describe('a customer reading their own account', () => {
  it('is shown what the account actually holds, country and all', async () => {
    const person = await register();

    const res = await details(person).expect(200);

    expect(res.body.full_name).toBe('Original Name');
    expect(res.body.email).toBe(person.email);
    expect(res.body.phone).toBe(person.phone);
    expect(res.body.country).toBe('NG');
    // The LEFT JOIN, asserted rather than assumed. This is the join that
    // returned EVERY FIELD AS NULL out of `describeSession` on a database
    // behind 040.
    expect(res.body.country_name).toBe('Nigeria');
    expect(typeof res.body.created_at).toBe('string');
    expect(res.body.kyc_tier).toBe(0);
  });

  it('does not carry a secret of any kind', async () => {
    const person = await register();

    const res = await details(person).expect(200);

    // Asserted over the WHOLE serialised body rather than key by key, because
    // what is being guarded against is a field nobody thought to name — the
    // rule `data-rights.e2e.test.ts` follows for the same reason.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/\bpin\b/i);
    expect(body).not.toMatch(/bvn/i);
  });

  it('refuses without a bearer token', async () => {
    await request(app.getHttpServer()).get('/v1/auth/profile/details').expect(401);
  });
});

describe('a customer filling in their name', () => {
  it('writes it, and the next read returns what was written', async () => {
    const person = await register();

    const saved = await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      // Padded deliberately: the database trims, so the response is what says
      // whether the trim happened rather than what the form believed it sent.
      .send({ full_name: '  Chinelo Okafor  ' })
      .expect(201);

    expect(saved.body.full_name).toBe('Chinelo Okafor');

    const read = await details(person).expect(200);
    expect(read.body.full_name).toBe('Chinelo Okafor');
  });

  it('refuses a name the database CHECK would refuse', async () => {
    const person = await register();

    // `users_full_name_check` demands 2..120 characters after trimming. The
    // schema states the same bounds so the refusal is readable, but the CHECK
    // is what holds — this asserts the readable half.
    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'a' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'x'.repeat(121) })
      .expect(400);

    // The name is untouched by either refusal.
    const read = await details(person).expect(200);
    expect(read.body.full_name).toBe('Original Name');
  });

  it('REFUSES A SMUGGLED EMAIL, PHONE OR COUNTRY rather than ignoring one', async () => {
    const person = await register();

    /*
     * `.strict()`, and this is what it is for. Those three are read-only for
     * reasons that are not about validation — the email is what
     * `users_email_unique` refuses a duplicate account on, the phone is the
     * identifier every per-customer control assumes one person holds one of,
     * and the country decides which rails serve them. A field silently ignored
     * is a field somebody will one day wire up; a field refused is a decision
     * anybody reading the code can see.
     */
    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'Someone Else', email: 'attacker@example.com' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'Someone Else', phone: '+2348030000000' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'Someone Else', country: 'GH' })
      .expect(400);

    const read = await details(person).expect(200);
    expect(read.body.email).toBe(person.email);
    expect(read.body.phone).toBe(person.phone);
    expect(read.body.country).toBe('NG');
    expect(read.body.full_name).toBe('Original Name');
  });

  it('changes only this customer, never another', async () => {
    const mine = await register();
    const theirs = await register();

    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ full_name: 'Only Mine' })
      .expect(201);

    const other = await details(theirs).expect(200);
    expect(other.body.full_name).toBe('Original Name');
  });

  it('takes NO transaction PIN, because it moves no money', async () => {
    const person = await register();

    // No PIN has been set on this account at all, and the write still lands.
    // A PIN authorises money leaving; a greeting on a checkout page is not
    // that, and 040 keeps this name and the verified one apart precisely so
    // nothing that moves money reads this one.
    await request(app.getHttpServer())
      .post('/v1/auth/profile/name')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'No Pin Needed' })
      .expect(201);
  });
});
