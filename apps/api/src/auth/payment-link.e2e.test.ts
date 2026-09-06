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
 * The payment link, over HTTP, against a real database.
 *
 * THIS REPLACES A SUITE ABOUT CHANGING AN `@handle`, and the reason it is gone
 * is the reason this one exists: the identifier of an account is the PHONE
 * NUMBER. A handle was a second name for the same person — one every screen
 * already knew, and one a customer had to be taught — and two identifiers for
 * one account is two things to get wrong for no capability the number does not
 * already have.
 *
 * What is worth proving here is the pair no unit test can reach: that the link
 * a customer is shown carries the number their account actually holds, and
 * that pasting that link back into the Send screen resolves to THEM. Those are
 * two regexes in two workspaces plus a route on a third — the same shape as
 * the `/pay` bug, where the service built links to a page that did not exist
 * and every one of them answered 404.
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
  phone: string;
}

async function register(): Promise<Person> {
  const email = `paylink-${randomUUID()}@example.ng`;
  // National digits. The dialling code comes from the country and the two are
  // joined server-side, so what `users.phone` ends up holding is E.164.
  const national = String(8000000000 + Math.floor(Math.random() * 999999999));
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      full_name: 'Payment Link Person',
      country: 'NG',
      phone: national,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  const token = created.body.access_token as string;
  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { email, token, phone: `+234${national}` };
}

const mine = (person: Person) =>
  request(app.getHttpServer())
    .get('/v1/auth/profile')
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

describe('a customer asking to be paid', () => {
  it('is given their own number, in the shape a sender abroad can use', async () => {
    const person = await register();

    const res = await mine(person).expect(200);
    // E.164, plus and all. The apps decide how to DISPLAY it; what the API
    // returns is the one string that resolves a recipient across borders.
    expect(res.body.phone).toBe(person.phone);
  });

  it('the link is the account\'s own slug, and every account has one', async () => {
    /*
     * THE LINK IS NO LONGER THE PHONE NUMBER, and that is not a cosmetic
     * change: it is now a page a STRANGER pays on, so the address a customer
     * publishes must not be the number their bank, their contacts and their
     * two-factor codes are attached to. The slug is minted by a trigger on
     * `users` in 058, so there is no path by which an account exists without
     * one — which is what makes "share your link" a thing every customer can
     * do on the day they sign up, with nothing to create first.
     *
     * It is also URL-safe by CHECK rather than by escaping. The `+` this test
     * used to guard against cannot occur in `^[a-z0-9]{8,32}$`, and neither
     * can anything else that changes meaning in a URL, a QR code or a text
     * message.
     */
    const person = await register();

    const res = await mine(person).expect(200);
    const slug = res.body.slug as string | null;
    const link = res.body.link as string | null;

    expect(slug).toMatch(/^[a-z0-9]{8,32}$/);
    // `testApiConfig` sets an app base URL, so the API can build one here. On
    // a deployment that has not been told its own address this is null and
    // each app fills it in from the origin it is already running on — which is
    // asserted in the clients, because only they have an origin.
    expect(link).not.toBeNull();
    expect(link).toContain(`/pay/${slug as string}`);
    // AND IT IS NOT THE NUMBER. Asserted rather than implied, because the
    // previous shape of this link WAS the number and a fallback that quietly
    // reverted would publish it again.
    expect(link).not.toContain(person.phone.slice(1));
  });

  it('a stranger with no account can read who a link pays', async () => {
    /*
     * THE WHOLE POINT OF THE LINK, and the half a signed-in test cannot see:
     * this request carries no bearer token at all. If it needed one, a payment
     * link would only be payable by people who already have an account, which
     * is not a payment link.
     *
     * It answers a NAME and a CURRENCY. Not an email, not a number — a payer
     * has to see who they are about to pay, and if the page could also show
     * the address behind the link then every published link would be a
     * harvester.
     */
    const payee = await register();
    const slug = (await mine(payee).expect(200)).body.slug as string;

    const seen = await request(app.getHttpServer()).get(`/v1/pay/${slug}`).expect(200);

    expect(seen.body.name).toBe('Payment Link Person');
    expect(seen.body.currency).toBe('NGN');
    expect(Object.keys(seen.body as object).sort()).toEqual(['currency', 'name']);
  });

  it('an unknown link answers exactly as a malformed one does', async () => {
    // Distinguishing them would say which slugs exist, one request at a time,
    // to a caller who needs no account to ask. Same rule as an unknown bank
    // account and an unreachable bank.
    const unknown = await request(app.getHttpServer()).get('/v1/pay/zzzzzzzzzzzz');
    const malformed = await request(app.getHttpServer()).get('/v1/pay/NOT-A-SLUG');

    expect(unknown.status).toBe(malformed.status);
    expect(unknown.body.error).toBe(malformed.body.error);
    expect(unknown.body.error).toBe('link_not_found');
  });

  it('a link already in the world, built from a number, still resolves', async () => {
    /*
     * NOBODY RE-READS A LINK THEY HAVE ALREADY SENT. Every link shared before
     * the slug existed carries a phone number, and those are in message
     * threads, bios and printouts we cannot reach. `payLinkTarget` therefore
     * unwraps `/pay/<segment>` first and reads all digits as a number, so the
     * old shape keeps working — silently redirecting them to nobody would be
     * the worst possible way to make this change.
     */
    const payee = await register();
    const payer = await register();

    const sent = await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${payer.token}`)
      .send({
        recipient: `https://app.xetral.test/pay/${payee.phone.slice(1)}`,
        amount: '100.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      });

    // The payer has no balance, so `insufficient_funds` is the answer that
    // says the RECIPIENT WAS FOUND — see the next test for why that is the
    // assertion rather than a 200.
    expect(sent.body.error).toBe('insufficient_funds');
  });

  it('pasting that link back into Send resolves to the person it names', async () => {
    // THE HALF THAT WAS NEVER CHECKED END TO END. The link is built in the
    // profile service and taken apart by `payLinkTarget` in the wallet
    // service, in different files, with no type between them — and the slug
    // branch resolves through `payable_links`, which is a third file again.
    const payee = await register();
    const payer = await register();

    const link = (await mine(payee).expect(200)).body.link as string;

    const sent = await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${payer.token}`)
      .send({
        // `recipient`, the field the transfer DTO declares — and the whole
        // pasted LINK, because that is what a customer does with one.
        recipient: link,
        amount: '100.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      });

    /*
     * The payer has no balance, so this refuses — and WHICH refusal is the
     * whole assertion. `insufficient_funds` means the recipient was found and
     * the entry was built; `recipient_not_found` would mean the link came
     * apart between the two regexes that make and read it, which from the
     * outside is indistinguishable from a customer who does not exist.
     */
    expect(sent.body.error).not.toBe('recipient_not_found');
    expect(sent.body.error).toBe('insufficient_funds');
  });

  it('there is no way to change it', async () => {
    // A handle could be changed, and the endpoint that did it is gone. The
    // number is changed by changing the number on the account, which is a
    // verified action rather than a text box — and a route that no longer
    // exists cannot be reached by a stolen session either.
    const person = await register();

    const gone = await request(app.getHttpServer())
      .post('/v1/auth/profile/handle')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ handle: 'somethingelse', transaction_pin: PIN });

    // 404 from the router, or 403 from the deny-by-default guard for a route
    // with no policy. Either is a refusal; what must not happen is a 200.
    expect([403, 404]).toContain(gone.status);
  });
});
