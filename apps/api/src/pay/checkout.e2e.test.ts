import 'reflect-metadata';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
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
 * NOTHING COVERED THIS PATH AT ALL, and that is why it shipped broken. The
 * checkout adapters are constructed INSIDE `PaymentLinkService.#checkout()`
 * rather than injected, so there was no port to fake and no test was written;
 * the only proof the Flutterwave half worked was that the code read correctly.
 * It did read correctly. On a deployment holding a Paystack key and no
 * Flutterwave one, every cedi, shilling and dollar link answered
 * `checkout_unavailable` and naira worked perfectly — and nothing anywhere
 * connected the two facts.
 *
 * So this drives the REAL adapter over HTTP to a stub that answers exactly
 * what Flutterwave's published v3 API answers. That exercises the route table,
 * the unit conversion, the payment options and the envelope check — every one
 * of which is a place a plausible-looking constant could be wrong.
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
      if ((req.url ?? '').startsWith('/v3/payments')) {
        res.end(
          JSON.stringify({
            status: 'success',
            message: 'Hosted Link',
            data: { link: 'https://checkout.flutterwave.com/pay/abc' },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'error', message: 'no such endpoint' }));
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
          flutterwaveBaseUrl: `http://127.0.0.1:${stubPort}`,
          flutterwaveSecretKey: 'FLWSECK_TEST-not-a-real-key',
        },
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
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

describe('paying a link in a currency Flutterwave collects', () => {
  it('starts a checkout for GHS and USD', async () => {
    const slug = await ghanaian();
    for (const currency of ['GHS', 'USD']) {
      const res = await charge(slug, currency).expect(200);
      expect(res.body.authorization_url).toContain('checkout.flutterwave.com');
    }
  });

  it('REFUSES SHILLINGS WHILE NO PROVIDER IS CONFIRMED FOR THEM — before a row or a request', async () => {
    /*
     * 083 leaves Kenyan collection unrouted by the owner's assignment: no
     * provider is confirmed, so nothing is sent anywhere and the payer reads
     * a code the page turns into words, rather than a Flutterwave page that
     * fails for a reason nobody on our side can see.
     */
    const slug = await ghanaian();
    seen.length = 0;
    const res = await charge(slug, 'KES');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('currency_not_supported');
    expect(seen.filter((r) => r.url.startsWith('/v3/payments'))).toHaveLength(0);
  });

  it('SENDS MAJOR UNITS, which is the opposite of Paystack one directory away', async () => {
    /*
     * Copying the Paystack adapter's `amountMinor.toString()` into this rail
     * charges a payer ONE HUNDRED TIMES the amount, in the direction that
     * takes their money, and neither API would refuse it: 2500 cedis is a
     * perfectly valid charge. This is the assertion that catches that.
     */
    const slug = await ghanaian();
    seen.length = 0;
    await charge(slug, 'GHS', '25.00').expect(200);

    const sent = seen.find((r) => r.url.startsWith('/v3/payments'));
    expect(sent).toBeDefined();
    expect((sent!.body as { amount: string }).amount).toBe('25.00');
    expect((sent!.body as { currency: string }).currency).toBe('GHS');
  });

  it('bears the secret key, and does not sign', async () => {
    // Three providers in this package, three auth schemes. Copying Bitnob's
    // signing onto this rail is a 401 that reads as a bad key.
    const slug = await ghanaian();
    seen.length = 0;
    await charge(slug, 'GHS').expect(200);

    const sent = seen.find((r) => r.url.startsWith('/v3/payments'))!;
    expect(sent.auth).toBe('Bearer FLWSECK_TEST-not-a-real-key');
  });

  it('offers the methods that CURRENCY can actually be paid with', async () => {
    /*
     * Left to itself their page leads with card, which in Accra and Nairobi is
     * the method fewest payers have. A method the currency cannot use is not
     * an error either — it is a checkout page with nothing on it.
     */
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
      provider: 'flutterwave',
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

    const bodies = seen
      .filter((r) => r.url.startsWith('/v3/payments'))
      .map((r) => r.body as { payment_options?: string; currency?: string });

    /*
     * `account` AND NOT `banktransfer`, which is the distinction a Ghanaian
     * checkout failing while a Nigerian one worked turned on. Flutterwave's
     * two bank options are different products: `banktransfer` is the Nigerian
     * pay-with-transfer one. A payer offered a method the account cannot serve
     * does not get an error — they get a page with that method missing.
     *
     * And `card` is on both, because a link exists to be paid by people whose
     * rails we do not know in advance.
     */
    expect(bodies.map((b) => b.payment_options)).toEqual([
      'card,account,mobilemoneyghana',
      'card,account,mpesa',
    ]);

    /*
     * AND THE CURRENCY IS THE LITERAL CODE, asserted here because it was one
     * of four candidate explanations for the Ghanaian refusal and the only one
     * a test could settle: a country code, a blank, or anything but `GHS`
     * reaches Flutterwave as a refusal the payer reads as "try again shortly".
     */
    expect(bodies.map((b) => b.currency)).toEqual(['GHS', 'KES']);
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
      provider: 'flutterwave',
      currency: 'GHS',
      status: 'pending',
    });
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
    expect(body).not.toMatch(/paystack|flutterwave|FLWSECK|sk_/i);
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

  it('opens the page on the card when the card was pressed', async () => {
    const token = await ghanaianToken();
    seen.length = 0;
    const res = await request(app.getHttpServer())
      .post('/v1/funding/topup')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '25.00', method: 'card' })
      .expect(200);
    expect(res.body.authorization_url).toContain('checkout.flutterwave.com');
    const body = seen.find((r) => r.url.startsWith('/v3/payments'))?.body as { payment_options?: string };
    expect(body.payment_options).toBe('card');
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
    expect(seen.filter((r) => r.url.startsWith('/v3/payments'))).toHaveLength(0);
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
