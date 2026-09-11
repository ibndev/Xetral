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
  it('starts a checkout for GHS, KES and USD', async () => {
    const slug = await ghanaian();
    for (const currency of ['GHS', 'KES', 'USD']) {
      const res = await charge(slug, currency).expect(200);
      expect(res.body.authorization_url).toContain('checkout.flutterwave.com');
    }
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
    await charge(slug, 'KES').expect(200);

    const options = seen
      .filter((r) => r.url.startsWith('/v3/payments'))
      .map((r) => (r.body as { payment_options?: string }).payment_options);
    expect(options).toContain('mobilemoneyghana');
    expect(options).toContain('mpesa,banktransfer');
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
