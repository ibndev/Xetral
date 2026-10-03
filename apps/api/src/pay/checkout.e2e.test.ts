import 'reflect-metadata';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { ProviderRouterService } from '../routing/provider-router.service.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * A PAYMENT LINK, PAID, ON EACH RAIL — against a stub speaking the provider's
 * own wire protocol.
 *
 * The checkout adapters are constructed INSIDE `PaymentLinkService.#checkout()`
 * rather than injected, so there is no port to fake: this drives the REAL Kora
 * adapter over HTTP to a stub that answers exactly what Kora's guides publish
 * (developers.korapay.com, read 3 October 2026). That exercises the route
 * table, the unit conversion, the channels, the envelope check and the
 * webhook signature — every one of which is a place a plausible-looking
 * constant could be wrong.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
/*
 * The OWNER, for one statement: putting a route back to "unrouted" is a
 * DELETE, which 099 takes away from the application role on purpose — an
 * operator removes a corridor at a prompt, never through the API.
 */
const OWNER_DATABASE_URL = process.env['DATABASE_OWNER_URL'] ?? DATABASE_URL;
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';

let pool: Pool;
let app: INestApplication;
let stub: Server;
let stubPort = 0;
/** Every request the stub received, so the WIRE can be asserted. */
const seen: { url: string; auth: string | undefined; body: unknown }[] = [];
/** What the stub says when a payment is verified by its reference. */
let verifyAnswer: { status: string; amount: string; currency: string } | undefined;

const KEY = 'sk_test_not-a-real-key';

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        auth: req.headers['authorization'],
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').startsWith('/api/v1/charges/initialize')) {
        const reference = (JSON.parse(raw) as { reference: string }).reference;
        res.end(
          JSON.stringify({
            status: true,
            message: 'Charge created successfully',
            data: { reference, checkout_url: `https://checkout.korapay.com/${reference}/pay` },
          }),
        );
        return;
      }
      if ((req.url ?? '').startsWith('/api/v1/charges/') && verifyAnswer !== undefined) {
        res.end(
          JSON.stringify({
            status: true,
            message: 'Charge retrieved successfully',
            data: { ...verifyAnswer, amount_paid: verifyAnswer.amount, payment_method: 'mobile_money' },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ status: false, message: 'no such endpoint' }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = (stub.address() as { port: number }).port;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: {
          ...testApiConfig(DATABASE_URL as string),
          koraBaseUrl: `http://127.0.0.1:${stubPort}`,
          koraSecretKey: KEY,
        },
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

async function ghanaian(): Promise<string> {
  const email = `checkout-${randomUUID()}@example.gh`;
  await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      full_name: 'Kofi Mensah',
      country: 'GH',
      phone: String(240000000 + Math.floor(Math.random() * 9999999)),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  const row = await pool.query<{ slug: string }>(
    `SELECT p.slug FROM payment_links p JOIN users u ON u.id = p.user_id WHERE u.email = $1`,
    [email],
  );
  return row.rows[0]!.slug;
}

const charge = (slug: string, currency: string, amount = '25.00') =>
  request(app.getHttpServer())
    .post(`/v1/pay/${slug}/charge`)
    .send({ amount, currency, email: 'payer@example.com' });

const initialized = () => seen.filter((r) => r.url.startsWith('/api/v1/charges/initialize'));

describe('paying a link in a currency Kora collects', () => {
  it('starts a cedi checkout and answers Kora\'s checkout URL', async () => {
    const slug = await ghanaian();
    const res = await charge(slug, 'GHS').expect(200);
    expect(res.body.authorization_url).toContain('checkout.korapay.com');
  });

  it('REFUSES DOLLARS AND SHILLINGS WHILE NOTHING IS ROUTED FOR THEM — before a row or a request', async () => {
    /*
     * Kora documents card payments in naira only, so 095 left dollar
     * collection unrouted rather than guessed; and 083 leaves Kenyan
     * collection unrouted until a provider is confirmed. Nothing is sent and
     * the payer reads a code the page turns into words.
     */
    const slug = await ghanaian();
    seen.length = 0;
    for (const currency of ['USD', 'KES']) {
      const res = await charge(slug, currency);
      expect(res.status, currency).toBe(400);
      expect(res.body.error, currency).toBe('currency_not_supported');
    }
    expect(initialized()).toHaveLength(0);
  });

  it('SENDS MAJOR UNITS, which is the opposite of Paystack one directory away', async () => {
    /*
     * Copying the Paystack adapter's `amountMinor.toString()` into this rail
     * charges a payer ONE HUNDRED TIMES the amount, in the direction that
     * takes their money, and neither API would refuse it.
     */
    const slug = await ghanaian();
    seen.length = 0;
    await charge(slug, 'GHS', '25.00').expect(200);

    const sent = initialized()[0];
    expect(sent).toBeDefined();
    expect((sent!.body as { amount: string }).amount).toBe('25.00');
    expect((sent!.body as { currency: string }).currency).toBe('GHS');
  });

  it('bears the secret key, and does not sign', async () => {
    const slug = await ghanaian();
    seen.length = 0;
    await charge(slug, 'GHS').expect(200);
    expect(initialized()[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  it('opens a cedi or shilling payer on mobile money, the channel Kora documents there', async () => {
    const slug = await ghanaian();
    seen.length = 0;
    await charge(slug, 'GHS').expect(200);
    /*
     * THE KENYAN SLOT IS PLUGGABLE: routed by an operator the day a provider
     * is confirmed, the adapter must already offer M-Pesa. Routed for this
     * assertion and put back, because the e2e files share one database.
     */
    const operator = await pool.query<{ uuid: string }>(`SELECT uuid FROM users LIMIT 1`);
    await app.get(ProviderRouterService).route({
      operation: 'collect',
      currency: 'KES',
      provider: 'kora',
      byUserUuid: operator.rows[0]!.uuid,
    });
    try {
      await charge(slug, 'KES').expect(200);
    } finally {
      const owner = new pg.Pool({ connectionString: OWNER_DATABASE_URL, max: 1 });
      try {
        await owner.query(`DELETE FROM provider_routes WHERE operation = 'collect' AND currency = 'KES'`);
      } finally {
        await owner.end();
      }
    }

    const bodies = initialized().map((r) => r.body as { channels?: string[]; currency?: string });
    expect(bodies.map((b) => b.channels)).toEqual([['mobile_money'], ['mobile_money']]);
    expect(bodies.map((b) => b.currency)).toEqual(['GHS', 'KES']);
  });

  it('refuses a method the currency lacks, before a row or a call', async () => {
    /* Kora documents card payments in naira only, so a card is not offered
     * for cedis — refused here rather than sent to a page without it. */
    const slug = await ghanaian();
    seen.length = 0;
    const refused = await request(app.getHttpServer())
      .post(`/v1/pay/${slug}/charge`)
      .send({ amount: '25.00', currency: 'GHS', email: 'payer@example.com', method: 'card' })
      .expect(400);
    expect(refused.body.error).toBe('payment_method_not_supported');
    expect(initialized()).toHaveLength(0);
  });

  it('writes the row BEFORE the payer leaves, naming the rail', async () => {
    /*
     * 058's security argument, unchanged by the rail: the reference is OURS
     * and names a row saying which customer and how much, so an event whose
     * reference matches no row credits nobody. And the rail is recorded on the
     * row, so settling cannot be broken by an operator moving a corridor.
     */
    const slug = await ghanaian();
    const res = await charge(slug, 'GHS').expect(200);

    const row = await pool.query<{ provider: string; currency: string; status: string }>(
      `SELECT provider, currency, status FROM link_payments WHERE reference = $1`,
      [res.body.reference],
    );
    expect(row.rows[0]).toMatchObject({
      provider: 'kora',
      currency: 'GHS',
      status: 'pending',
    });
  });

  it('ASKS FOR THE EVENT AGAIN while the rail has not confirmed the payment, then credits it once', async () => {
    // A charge event for a payment Kora had not finished must not be
    // acknowledged and dropped: nothing else ever asks about a link payment.
    const slug = await ghanaian();
    const res = await charge(slug, 'GHS', '25.00').expect(200);
    const reference = res.body.reference as string;
    const event = (status: string) => {
      const data = { reference, currency: 'GHS', amount: 25, fee: 0.25, status, payment_method: 'mobile_money' };
      return request(app.getHttpServer())
        .post('/v1/webhooks/kora')
        .set('x-korapay-signature', createHmac('sha256', KEY).update(JSON.stringify(data)).digest('hex'))
        .set('content-type', 'application/json')
        .send(JSON.stringify({ event: 'charge.success', data }));
    };

    // A forged event — signed with a different key — is refused and moves nothing.
    await request(app.getHttpServer())
      .post('/v1/webhooks/kora')
      .set('x-korapay-signature', createHmac('sha256', 'sk_test_other').update('{}').digest('hex'))
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event: 'charge.success', data: {} }))
      .expect(401);

    try {
      verifyAnswer = { status: 'processing', amount: '25.00', currency: 'GHS' };
      await event('success').expect(503);

      verifyAnswer = { status: 'success', amount: '25.00', currency: 'GHS' };
      await event('success').expect(200);
      // A redelivery is a replay: processed idempotently by its reference.
      await event('success').expect(200);
    } finally {
      verifyAnswer = undefined;
    }

    const row = await pool.query<{ status: string; entries: string }>(
      `SELECT l.status,
              (SELECT count(*)::text FROM journal_entries e
                WHERE e.metadata->>'reference' = l.reference) AS entries
         FROM link_payments l WHERE l.reference = $1`,
      [reference],
    );
    expect(row.rows[0]?.status).toBe('paid');
  });

  it('SAYS A MISSING KEY IS A MISSING KEY, not "try again later"', async () => {
    /*
     * THE WHOLE REPORTED FAULT. This config has no Paystack key, so naira —
     * routed to Paystack — is the unconfigured rail here, which is the exact
     * inverse of the deployment where cedis failed and naira worked.
     *
     * One code for a missing credential, a refusal and an outage meant a payer
     * was told to try again later about something that will never work until
     * somebody pastes a key, and no screen anywhere said which.
     */
    const slug = await ghanaian();
    const res = await charge(slug, 'NGN', '2500.00').expect(503);
    expect(res.body.error).toBe('checkout_not_configured');
  });

  it('never puts a provider name or a key in front of the payer', async () => {
    // The sentence names our integration -- 006's rule -- so it stays in the
    // log. Asserted over the whole body, because what is guarded against is a
    // field nobody thought to name.
    const slug = await ghanaian();
    const res = await charge(slug, 'NGN', '2500.00').expect(503);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/paystack|kora|sk_/i);
  });
});

describe('topping up by card or USSD', () => {
  /*
   * Add Money's two buttons. The customer has already chosen, so the
   * provider's page opens on THAT method — and USSD, a Nigerian bank's short
   * code on every rail, is refused for any other currency before a row is
   * written, because sent on it is a checkout page with no method on it.
   */
  async function ghanaianToken(): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email: `topup-${randomUUID()}@example.gh`,
        password: PASSWORD,
        full_name: 'Ama Owusu',
        country: 'GH',
        phone: String(240000000 + Math.floor(Math.random() * 9999999)),
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
      })
      .expect(201);
    return created.body.access_token as string;
  }

  it('opens the page on mobile money when mobile money was pressed', async () => {
    const token = await ghanaianToken();
    seen.length = 0;
    const res = await request(app.getHttpServer())
      .post('/v1/funding/topup')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '25.00', method: 'mobile_money' })
      .expect(200);
    expect(res.body.authorization_url).toContain('checkout.korapay.com');
    const body = initialized()[0]?.body as { channels?: string[] };
    expect(body.channels).toEqual(['mobile_money']);
  });

  it('REFUSES USSD for cedis, before anything is written or sent', async () => {
    const token = await ghanaianToken();
    seen.length = 0;
    const res = await request(app.getHttpServer())
      .post('/v1/funding/topup')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '25.00', method: 'ussd' })
      .expect(400);
    expect(res.body.error).toBe('payment_method_not_supported');
    expect(initialized()).toHaveLength(0);
  });

  it('refuses a method it does not know, rather than ignoring it', async () => {
    const token = await ghanaianToken();
    await request(app.getHttpServer())
      .post('/v1/funding/topup')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '25.00', method: 'crypto' })
      .expect(400);
  });
});
