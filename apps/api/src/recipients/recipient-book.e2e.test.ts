import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { ProviderRejectedError } from '@xetral/providers';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '@xetral/providers';
import type { Currency } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * The customer's address book, end to end — the table the one Send flow opens
 * on.
 *
 * FOUR PROPERTIES ARE WORTH MORE THAN THE REST, and every test below is one:
 *
 *   1. A GHANAIAN WALLET IS RESOLVED, NOT REFUSED. This is the whole of "why
 *      can't the momo details be found": the adapter matched a network code
 *      and threw without ever asking, so a number Flutterwave will name came
 *      back as unfindable. The rail is asked here.
 *   2. A RAIL WITH NO NAME ENQUIRY ASKS FOR A LABEL rather than failing.
 *      Kenya's M-PESA genuinely has none, so `resolved_name` is null and the
 *      screen collects a label — a different screen, not a dead end.
 *   3. THE LABEL IS NEVER PRESENTED AS THE RAIL'S ANSWER. `display_name` and
 *      `resolved_name` are separate fields and the second stays null.
 *   4. ONE CUSTOMER'S BOOK IS THEIRS. Somebody else's row answers the same
 *      404 as one that does not exist.
 *
 * Requires DATABASE_URL with 001..068 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the recipients e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';

/** What the RAIL says. Deliberately not a name any test types into a form. */
const NAME_ON_WALLET = 'RABI SIEDU';

/**
 * A payout port that answers the way the two rails actually do.
 *
 * GHANA RESOLVES AND KENYA DOES NOT, which is the distinction the product got
 * wrong for three rounds — so the fake draws it rather than answering one way
 * for every wallet. A fake that agreed with the bug is exactly what let the
 * bug ship: `payout-adapter.test.ts` asserted the refusal AND that no call was
 * made, and stayed green while Accra could not send money.
 */
class FakePayoutPort implements PayoutPort {
  readonly provider = 'flutterwave';
  readonly lookups: { country: string; bankCode: string; accountNumber: string }[] = [];

  async banks(country: string): Promise<readonly PayoutBank[]> {
    if (country === 'GH') {
      return [
        { code: 'MTN', name: 'MTN Mobile Money' },
        { code: 'VOD', name: 'Telecel Cash' },
      ];
    }
    if (country === 'KE') return [{ code: 'MPS', name: 'M-PESA' }];
    return [{ code: '058', name: 'GTBank' }];
  }

  async lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup> {
    this.lookups.push({ country, bankCode, accountNumber });
    if (country === 'KE') {
      // The true answer for M-PESA, and the one the screen turns into a
      // request for a label rather than into a refusal.
      throw new ProviderRejectedError(
        'flutterwave',
        'a KE mobile money wallet has no name enquiry',
        'name_unavailable',
      );
    }
    return { accountName: NAME_ON_WALLET, accountNumber, bankCode };
  }

  async send<C extends Currency>(_input: PayoutRequest<C>): Promise<PayoutReceipt> {
    return { providerPayoutId: 'po_1', state: 'sent' };
  }

  async status(): Promise<PayoutReceipt> {
    return { providerPayoutId: 'po_1', state: 'completed' };
  }
}

let pool: Pool;
let app: INestApplication;
let port: FakePayoutPort;

interface Customer {
  userId: string;
  token: string;
}

/**
 * A customer in a named country, with a phone number.
 *
 * THE NUMBER MATTERS HERE in a way it does not in most suites: it is the
 * Xetral-to-Xetral identifier, so a fixture without one describes an account
 * nobody can pay — which is the state `customers_without_a_phone` exists to
 * report, not one to test against by accident.
 */
async function onboard(country: string, phone: string, fullName: string): Promise<Customer> {
  const identifier = `rb-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string; uuid: string }>(
    `INSERT INTO users (email, status, country, phone, full_name)
     VALUES ($1, 'active', $2, $3, $4) RETURNING id, uuid`,
    [identifier, country, phone, fullName],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('failed to seed user');

  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    row.id,
    await hashPassword(PASSWORD),
  ]);

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(200);

  return { userId: row.id, token: login.body.access_token as string };
}

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, overrides);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  port = new FakePayoutPort();
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config: makeConfig(), pool, clock: systemClock, payoutPort: port }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(() => {
  port.lookups.length = 0;
});

describe('resolving a destination', () => {
  it('ASKS THE RAIL for a Ghanaian wallet, and returns the name it gave', async () => {
    /*
     * THE TEST FOR THE WHOLE COMPLAINT. A Ghanaian momo number used to come
     * back as unfindable because the adapter refused to ask — so this asserts
     * both halves: that a call was made, and that its answer is what comes
     * back rather than anything the caller typed.
     */
    const me = await onboard('GH', '+233501112222', 'Ama Mensah');

    const found = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'momo', country: 'GH', rail_code: 'MTN', destination: '0553921133' })
      .expect(200);

    expect(found.body.resolved_name).toBe(NAME_ON_WALLET);
    expect(found.body.currency).toBe('GHS');
    expect(found.body.rail_name).toBe('MTN Mobile Money');
    // THE RAIL WAS ACTUALLY ASKED, in international form. `0553921133` is how
    // a number is written in Accra and `233553921133` is what the rail takes.
    expect(port.lookups).toEqual([
      { country: 'GH', bankCode: 'MTN', accountNumber: '233553921133' },
    ]);
    expect(found.body.destination).toBe('233553921133');
  });

  it('accepts the same wallet written three ways', async () => {
    // A unique index on text cannot see that these are one number, which is
    // why normalisation happens before anything reads the destination.
    const me = await onboard('GH', '+233501112223', 'Kofi Annan');
    for (const typed of ['0553921144', '+233 55 392 1144', '233553921144']) {
      const found = await request(app.getHttpServer())
        .post('/v1/recipients/resolve')
        .set('Authorization', `Bearer ${me.token}`)
        .send({ kind: 'momo', country: 'GH', rail_code: 'MTN', destination: typed })
        .expect(200);
      expect(found.body.destination).toBe('233553921144');
    }
  });

  it('answers a Kenyan wallet with NO NAME, which is not a failure', async () => {
    const me = await onboard('KE', '+254711112222', 'Wanjiru Kamau');

    const found = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'momo', country: 'KE', rail_code: 'MPS', destination: '0712345678' })
      .expect(200);

    // 200 with a null name, NOT a 404. The screen asks for a label; a refusal
    // here is what made the Kenyan corridor read as a broken lookup.
    expect(found.body.resolved_name).toBeNull();
    expect(found.body.currency).toBe('KES');
    expect(found.body.destination).toBe('254712345678');
  });

  it('refuses a network the rail does not offer', async () => {
    const me = await onboard('GH', '+233501112224', 'Yaw Boateng');
    const refused = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'momo', country: 'GH', rail_code: 'NOPE', destination: '0553921155' })
      .expect(422);
    expect(refused.body.error).toBe('unsupported_network');
    // And it did not ask the rail about a code the rail never listed.
    expect(port.lookups).toHaveLength(0);
  });

  it('finds a Xetral customer by a NATIONAL number, given the country', async () => {
    /*
     * `08031110002` IS HOW THE NUMBER IS WRITTEN IN LAGOS, and the stored
     * value is `+2348031110002`. Comparing typed digits to stored digits finds
     * nobody — which is the failure this flow reintroduced when it dropped the
     * dialling-code picker the old Send screen had.
     *
     * The country is not guessed from the SENDER: it is the one the currency
     * step already fixed, which is what makes a national number safe to accept
     * on a cross-border screen.
     */
    const me = await onboard('NG', '+2348031110001', 'Chidi Okeke');
    const them = await onboard('NG', '+2348031110002', 'Ngozi Eze');
    expect(them.userId).not.toBe(me.userId);

    const found = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'xetral', country: 'NG', destination: '08031110002' })
      .expect(200);
    expect(found.body.resolved_name).toBe('Ngozi Eze');
    expect(found.body.rail_code).toBeNull();
    // THE ROW RECORDS WHAT WAS MATCHED, never what was typed.
    expect(found.body.destination).toBe('2348031110002');

    const self = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'xetral', country: 'NG', destination: '08031110001' })
      .expect(422);
    expect(self.body.error).toBe('cannot_send_to_self');
  });

  it('finds the same customer by the INTERNATIONAL form with no country at all', async () => {
    // A number pasted out of a message carries its own country, and a link
    // already in the world supplies no ISO code — both must go on working.
    const me = await onboard('NG', '+2348031110004', 'Tunde Bello');
    await onboard('NG', '+2348031110005', 'Amaka Obi');

    for (const typed of ['2348031110005', '+234 803 111 0005']) {
      const found = await request(app.getHttpServer())
        .post('/v1/recipients/resolve')
        .set('Authorization', `Bearer ${me.token}`)
        .send({ kind: 'xetral', destination: typed })
        .expect(200);
      expect(found.body.resolved_name).toBe('Amaka Obi');
    }
  });

  it('does NOT pay a stranger abroad who shares the national digits', async () => {
    /*
     * THE REASON A BARE NATIONAL NUMBER IS NOT MATCHED ON A SUFFIX. Without a
     * country there is nothing to disambiguate, and on a money path guessing
     * pays somebody else entirely.
     */
    const me = await onboard('NG', '+2348031110006', 'Femi Kuti');
    await onboard('GH', '+233241110007', 'Ama Serwaa');

    const missing = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'xetral', destination: '0241110007' })
      .expect(404);
    expect(missing.body.error).toBe('recipient_not_found');

    // Named, it finds them — and only then.
    const found = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'xetral', country: 'GH', destination: '0241110007' })
      .expect(200);
    expect(found.body.resolved_name).toBe('Ama Serwaa');
  });

  it('answers an unknown number exactly as it answers a stranger', async () => {
    // A Send screen that told a customer apart from a stranger would be a way
    // to learn which numbers hold accounts here.
    const me = await onboard('NG', '+2348031110003', 'Bola Ade');
    const missing = await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'xetral', country: 'NG', destination: '08039999999' })
      .expect(404);
    expect(missing.body.error).toBe('recipient_not_found');
  });
});

describe('the address book', () => {
  it('saves a resolved wallet and lists it back', async () => {
    const me = await onboard('GH', '+233501113333', 'Efua Sutherland');

    const saved = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'momo', country: 'GH', rail_code: 'MTN', destination: '0553921166' })
      .expect(201);

    expect(saved.body.display_name).toBe(NAME_ON_WALLET);
    expect(saved.body.resolved_name).toBe(NAME_ON_WALLET);

    const listed = await request(app.getHttpServer())
      .get('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .expect(200);
    expect(listed.body.recipients.map((r: { id: string }) => r.id)).toContain(saved.body.id);
  });

  it('keeps the LABEL and the RAIL\'S ANSWER apart where there is no answer', async () => {
    /*
     * WHAT A CUSTOMER CALLS SOMEBODY IS NOT A CONFIRMATION. The label becomes
     * `display_name` so the list is readable, and `resolved_name` STAYS NULL —
     * so no screen can present the sender's own words as the account's name,
     * which is a confirmation screen that confirms nothing while looking
     * exactly like one.
     */
    const me = await onboard('KE', '+254711113333', 'Grace Njoroge');

    const saved = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send({
        kind: 'momo',
        country: 'KE',
        rail_code: 'MPS',
        destination: '0712345699',
        label: 'My landlord',
      })
      .expect(201);

    expect(saved.body.display_name).toBe('My landlord');
    expect(saved.body.resolved_name).toBeNull();
  });

  it('refuses to save an unnameable destination with NO label', async () => {
    // A bare number in an address book is how somebody pays the wrong person.
    const me = await onboard('KE', '+254711113344', 'Peter Mwangi');
    const refused = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'momo', country: 'KE', rail_code: 'MPS', destination: '0712345688' })
      .expect(422);
    expect(refused.body.error).toBe('recipient_name_required');
  });

  it('is idempotent: saving the same destination twice returns the same row', async () => {
    const me = await onboard('GH', '+233501114444', 'Akosua Busia');
    const body = { kind: 'momo', country: 'GH', rail_code: 'MTN', destination: '0553921177' };

    const first = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send(body)
      .expect(201);
    const again = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send(body)
      .expect(201);

    // The customer wanted this destination in their list and it is in their
    // list. A red banner here would be the product arguing with them.
    expect(again.body.id).toBe(first.body.id);
  });

  it('removes one, and a removed destination can be added again', async () => {
    const me = await onboard('GH', '+233501115555', 'Nana Ama');
    const body = { kind: 'momo', country: 'GH', rail_code: 'MTN', destination: '0553921188' };

    const saved = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/v1/recipients/${saved.body.id}`)
      .set('Authorization', `Bearer ${me.token}`)
      .expect(204);

    const listed = await request(app.getHttpServer())
      .get('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .expect(200);
    expect(listed.body.recipients.map((r: { id: string }) => r.id)).not.toContain(saved.body.id);

    // Added back rather than refused about a row they cannot see.
    const readded = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send(body)
      .expect(201);
    expect(readded.body.id).not.toBe(saved.body.id);
  });

  it('shows a customer only their own, and answers the same 404 for anybody else\'s', async () => {
    const mine = await onboard('GH', '+233501116666', 'Adjoa Andoh');
    const theirs = await onboard('GH', '+233501116667', 'Kwame Nkrumah');

    const saved = await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ kind: 'momo', country: 'GH', rail_code: 'MTN', destination: '0553921199' })
      .expect(201);

    const other = await request(app.getHttpServer())
      .get('/v1/recipients')
      .set('Authorization', `Bearer ${theirs.token}`)
      .expect(200);
    expect(other.body.recipients.map((r: { id: string }) => r.id)).not.toContain(saved.body.id);

    /*
     * AN EQUALITY RATHER THAN TWO ASSERTIONS, which is how the payment link's
     * two answers came to differ: "not yours" and "no such row" must be the
     * same response, status included, or the endpoint enumerates other
     * people's address books by id.
     */
    const notMine = await request(app.getHttpServer())
      .delete(`/v1/recipients/${saved.body.id}`)
      .set('Authorization', `Bearer ${theirs.token}`);
    const nobodys = await request(app.getHttpServer())
      .delete(`/v1/recipients/${randomUUID()}`)
      .set('Authorization', `Bearer ${theirs.token}`);
    expect(notMine.status).toBe(nobodys.status);
    expect(notMine.body).toEqual(nobodys.body);
    expect(notMine.status).toBe(404);
  });

  it('refuses every route without a bearer token', async () => {
    // The address book names people a customer pays. It is behind the session
    // like everything else, and `route-coverage.test.ts` is what makes that
    // structural — this is the same claim asked of the running app.
    await request(app.getHttpServer()).get('/v1/recipients').expect(401);
    await request(app.getHttpServer())
      .post('/v1/recipients/resolve')
      .send({ kind: 'xetral', destination: '08031110002' })
      .expect(401);
    await request(app.getHttpServer()).delete(`/v1/recipients/${randomUUID()}`).expect(401);
  });

  it('TAKES NO TRANSACTION PIN, deliberately', async () => {
    /*
     * The control is where the money is. A saved recipient moves nothing, the
     * send takes a PIN and re-fetches the rail's name on that request, and the
     * destination is immutable by trigger — so a stolen session that adds a
     * recipient has gained a row it still cannot spend through. Asking here
     * would be a second, weaker copy of a control that already holds, on the
     * screen a customer uses most.
     *
     * This customer has NO PIN AT ALL, so a route that had grown one would
     * answer `pin_not_set` rather than 201.
     */
    const me = await onboard('GH', '+233501117777', 'Esi Edugyan');
    await request(app.getHttpServer())
      .post('/v1/recipients')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ kind: 'momo', country: 'GH', rail_code: 'MTN', destination: '0553921200' })
      .expect(201);
  });
});
