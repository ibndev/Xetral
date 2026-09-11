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
  uuid: string;
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

  const token = created.body.access_token as string;
  const row = await pool.query<{ uuid: string }>(`SELECT uuid FROM users WHERE email = $1`, [
    email,
  ]);
  return { email, token, phone: `+234${national}`, uuid: row.rows[0]!.uuid };
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

describe('an UNVERIFIED customer filling in what is missing', () => {
  it('writes a name, and the next read returns what was written', async () => {
    const person = await register();

    const saved = await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      // Padded deliberately: the database trims, so the response is what says
      // whether the trim happened rather than what the form believed it sent.
      .send({ full_name: '  Chinelo Okafor  ' })
      .expect(201);

    expect(saved.body.full_name).toBe('Chinelo Okafor');
    expect(saved.body.kyc_verified).toBe(false);
    expect(saved.body.editable).toContain('phone');

    const read = await details(person).expect(200);
    expect(read.body.full_name).toBe('Chinelo Okafor');
  });

  it('ADDS A MISSING PHONE NUMBER, which is what nobody could do', async () => {
    /*
     * An account opened before the number was required has none — and the
     * number IS the Xetral-to-Xetral identifier, so Request payment reads
     * "Not set" and every sender is told there is no such customer. There was
     * no path anywhere in the product to fix that.
     */
    const person = await register();
    await pool.query(`UPDATE users SET phone = NULL WHERE uuid = $1`, [person.uuid]);

    const before = await details(person).expect(200);
    expect(before.body.phone).toBeNull();

    const national = String(8000000000 + Math.floor(Math.random() * 999999999));
    const saved = await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      // NATIONAL digits. The dialling code comes from the country, joined
      // server-side, because a unique index on text cannot see that three
      // spellings are one person.
      .send({ phone: national })
      .expect(201);

    expect(saved.body.phone).toBe(`+234${national}`);
  });

  it('strips the trunk zero exactly as registration does', async () => {
    const person = await register();
    await pool.query(`UPDATE users SET phone = NULL WHERE uuid = $1`, [person.uuid]);

    const national = String(8000000000 + Math.floor(Math.random() * 999999999));
    const saved = await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ phone: `0${national}` })
      .expect(201);

    // A domestic dialling convention rather than part of the number. Left on,
    // the account holds a string nobody can be reached at.
    expect(saved.body.phone).toBe(`+234${national}`);
  });

  it('REFUSES A NUMBER ANOTHER ACCOUNT HOLDS, without saying whose', async () => {
    const theirs = await register();
    const mine = await register();
    await pool.query(`UPDATE users SET phone = NULL WHERE uuid = $1`, [mine.uuid]);

    const taken = await pool.query<{ phone: string }>(
      `SELECT phone FROM users WHERE uuid = $1`,
      [theirs.uuid],
    );
    const national = taken.rows[0]!.phone.replace('+234', '');

    const refused = await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ phone: national })
      .expect(409);

    // One number, one account: every per-customer control assumes it.
    expect(refused.body.error).toBe('phone_taken');
    expect(JSON.stringify(refused.body)).not.toContain(theirs.uuid);
  });

  it('refuses a name the database CHECK would refuse', async () => {
    const person = await register();

    for (const full_name of ['a', 'x'.repeat(121)]) {
      await request(app.getHttpServer())
        .post('/v1/auth/profile')
        .set('Authorization', `Bearer ${person.token}`)
        .send({ full_name })
        .expect(400);
    }

    const read = await details(person).expect(200);
    expect(read.body.full_name).toBe('Original Name');
  });

  it('REFUSES A SMUGGLED EMAIL rather than ignoring one', async () => {
    /*
     * `.strict()`, and this is what it is for. The email is what
     * `users_email_unique` refuses a duplicate account on, so an endpoint that
     * could move an address between accounts is an account-takeover primitive
     * with a text box in front of it. A field silently ignored is a field
     * somebody will one day wire up.
     */
    const person = await register();

    await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'Someone Else', email: 'attacker@example.com' })
      .expect(400);

    const read = await details(person).expect(200);
    expect(read.body.email).toBe(person.email);
    expect(read.body.full_name).toBe('Original Name');
  });

  it('changes only this customer, never another', async () => {
    const mine = await register();
    const theirs = await register();

    await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ full_name: 'Only Mine' })
      .expect(201);

    const other = await details(theirs).expect(200);
    expect(other.body.full_name).toBe('Original Name');
  });

  it('takes NO transaction PIN, because it moves no money', async () => {
    const person = await register();

    // No PIN has been set on this account at all, and the write still lands.
    await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ full_name: 'No Pin Needed' })
      .expect(201);
  });
});

describe('a VERIFIED customer', () => {
  it('IS REFUSED EVERY CHANGE, and the refusal is the control', async () => {
    /*
     * The direction looks backwards and is the point. What a reviewer read off
     * a document is the record; letting its subject retype their own name or
     * number afterwards would make the verification a claim about a moment
     * rather than about the account, and the name a money decision may read
     * would no longer be the name anybody checked.
     *
     * The screen hiding the fields is a courtesy. This is the rule.
     */
    const person = await register();
    await pool.query(`UPDATE users SET kyc_tier = 1 WHERE uuid = $1`, [person.uuid]);

    const read = await details(person).expect(200);
    expect(read.body.kyc_verified).toBe(true);
    // Named rather than implied, so the screen cannot present a field the
    // server would refuse.
    expect(read.body.editable).toEqual([]);

    for (const body of [
      { full_name: 'A New Name' },
      { phone: '8039999999' },
      { country: 'GH' },
    ]) {
      const refused = await request(app.getHttpServer())
        .post('/v1/auth/profile')
        .set('Authorization', `Bearer ${person.token}`)
        .send(body)
        .expect(403);
      expect(refused.body.error).toBe('profile_locked');
    }

    const after = await details(person).expect(200);
    expect(after.body.full_name).toBe('Original Name');
    expect(after.body.phone).toBe(person.phone);
    expect(after.body.country).toBe('NG');
  });

  it('MAY STILL FILL IN A BLANK, and the phone is the one that matters', async () => {
    /*
     * THE SCREENSHOT THAT PROMPTED THIS. A verified account showing an em dash
     * for Name and Phone, under a sentence saying those can no longer be
     * changed — so the customer was told the blank was correct and had no path
     * anywhere in the product.
     *
     * THE COST IS NOT COSMETIC. The number is the Xetral-to-Xetral identifier:
     * a customer without one cannot be found on the Send screen, so NOBODY CAN
     * PAY THEM, and their Request payment panel has nothing to share.
     *
     * Verified locks what is THERE. Nothing was attested about a field that is
     * empty, so there is nothing for filling it in to contradict.
     */
    const person = await register();
    await pool.query(`UPDATE users SET kyc_tier = 1, phone = NULL WHERE uuid = $1`, [person.uuid]);

    const read = await details(person).expect(200);
    expect(read.body.kyc_verified).toBe(true);
    expect(read.body.phone).toBeNull();
    // The blank one, and ONLY the blank one.
    expect(read.body.editable).toEqual(['phone']);

    // UNIQUE PER RUN. The e2e files share one database and
    // `users_phone_unique` is global, so a fixed number here passes once and
    // answers `phone_taken` ever after.
    const national = `80${String(Date.now()).slice(-8)}`;
    const saved = await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ phone: national })
      .expect(201);
    expect(saved.body.phone).toBe(`+234${national}`);
    // And once it holds a value it is attested-adjacent like the rest: the
    // field closes behind them.
    expect(saved.body.editable).toEqual([]);

    const refused = await request(app.getHttpServer())
      .post('/v1/auth/profile')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ phone: `80${String(Date.now() + 1).slice(-8)}` })
      .expect(403);
    expect(refused.body.error).toBe('profile_locked');
  });

  it('READS THE NAME OFF THE APPROVED SUBMISSION when the account has none', async () => {
    /*
     * 040 keeps `users.full_name` and `kyc_submissions.full_name` apart for a
     * good reason, and nothing noticed an account can hold the SECOND AND NOT
     * THE FIRST. The admin dashboard reads the submission and showed a name;
     * the customer's own screen read `users` and showed a dash. Same person,
     * same database, two answers — and the customer is the one told nothing is
     * there.
     */
    const person = await register();
    // Nobody approves their own identity documents — 009's CHECK — so the
    // reviewer is a second account.
    const other = await register();
    const reviewer = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [other.uuid])
    ).rows[0]?.id;
    await pool.query(`UPDATE users SET full_name = NULL WHERE uuid = $1`, [person.uuid]);
    await pool.query(
      `INSERT INTO kyc_submissions
         (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4,
          bvn_fingerprint, address, status, reviewed_by, reviewed_at)
       SELECT u.id, 'OLAWALE ADEYEMI', DATE '1990-01-01', '08031234567', 'v1:sealed',
              '1234', $2, '1 Test Street', 'approved', $3::bigint, now()
         FROM users u WHERE u.uuid = $1`,
      [person.uuid, `v1:${Date.now().toString(16).padStart(64, 'b')}`, reviewer],
    );

    const read = await details(person).expect(200);
    expect(read.body.full_name).toBe('OLAWALE ADEYEMI');
    expect(read.body.kyc_verified).toBe(true);
  });
});
