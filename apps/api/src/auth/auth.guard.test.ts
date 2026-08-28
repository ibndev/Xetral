import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Controller, Get, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RoutePolicyRegistry, signAccessToken } from '@xetral/identity';
import type { AccessTokenKeyring } from '@xetral/identity';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from './auth.guard.js';
import { PinService } from './pin.service.js';
import { StaffService } from './staff.service.js';
import { StaffTotpService } from './staff-totp.service.js';
import { RequestRateLimiter } from './request-rate-limit.service.js';
import { InMemoryRateLimitStore } from './rate-limit.js';
import { RATE_LIMIT_STORE } from '../tokens.js';
import { API_CONFIG, CLOCK, ROUTE_POLICY } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Exercises the guard through a real Nest application rather than a mocked
 * ExecutionContext. The thing under test is precisely the wiring — that the
 * guard runs for every route and reads the same metadata the router did — and a
 * hand-built context would assert that the mock matches the guard's
 * expectations, not that the framework does.
 */

const key = { version: 'v1', secret: randomBytes(32) };
const keyring: AccessTokenKeyring = { current: key, accepted: [key] };
const NOW = 1_700_000_000;

/**
 * Deliberately far above anything these tests send. What is under test in this
 * file is the guard's ORDERING, and a realistic ceiling would make an unrelated
 * case fail on the twelfth request rather than on the thing it asserts. The
 * limiter's own behaviour is exercised by a second app at the bottom of this
 * file, with real numbers.
 */
const config = {
  accessTokenKeyring: keyring,
  accessTokenTtlSeconds: 900,
  requestRateLimit: {
    windowSeconds: 60,
    publicMax: 10_000,
    readMax: 10_000,
    writeMax: 10_000,
    moneyMax: 10_000,
    staffMax: 10_000,
  },
} as unknown as ApiConfig;

@Controller('v1/probe')
class ProbeController {
  @Get('open') open(): { ok: boolean } { return { ok: true }; }
  @Get('closed') closed(): { ok: boolean } { return { ok: true }; }
  @Post('money') money(): { ok: boolean } { return { ok: true }; }
  @Post('review') review(): { ok: boolean } { return { ok: true }; }
  /** Declared nowhere. The mistake this whole design exists to catch. */
  @Get('forgotten') forgotten(): { ok: boolean } { return { ok: true }; }
}

/**
 * Stands in for the real PinService, which needs a database. What is under test
 * here is the GUARD's behaviour around the PIN — that it demands one, that it
 * refuses without one, and crucially that it does not reach for one until the
 * bearer token has been verified. PinService's own logic is covered against a
 * real database in the e2e suite.
 */
const pinCalls: { sub: string; pin: string }[] = [];
let pinAccepts = true;

const pins = {
  async assertValid(sub: string, pin: string): Promise<void> {
    pinCalls.push({ sub, pin });
    if (!pinAccepts) throw new UnauthorizedException({ error: 'invalid_pin' });
  },
} as unknown as PinService;

let staffAccepts = true;
const staffCalls: string[] = [];
const staff = {
  assertRole: async (userUuid: string, role: string) => {
    staffCalls.push(`${userUuid}:${role}`);
    if (!staffAccepts) throw new ForbiddenException({ error: 'forbidden' });
  },
} as unknown as StaffService;

/**
 * Stands in for StaffTotpService, which needs a database and a keyring.
 *
 * Same reasoning as the other two stand-ins: what is under test here is the
 * guard's ORDERING and its refusals, not the TOTP arithmetic — that is covered
 * against RFC 6238's own vectors in `@xetral/identity`, and against real rows
 * in the e2e suite.
 */
let totpEnrolled = true;
let totpAccepts = true;
const totpCalls: string[] = [];
const totp = {
  assertEnrolled: async (sub: string) => {
    totpCalls.push(`enrolled:${sub}`);
    if (!totpEnrolled) throw new ForbiddenException({ error: 'totp_not_enrolled' });
  },
  assertElevated: async (sub: string, sid: string, code: string | undefined) => {
    totpCalls.push(`elevate:${sub}:${sid}:${code ?? 'none'}`);
    if (code === undefined) throw new BadRequestException({ error: 'totp_required' });
    if (!totpAccepts) throw new UnauthorizedException({ error: 'invalid_totp' });
  },
} as unknown as StaffTotpService;

const policy = new RoutePolicyRegistry()
  .public('GET', '/v1/probe/open', 'a probe with no customer data, for these tests')
  .authenticated('GET', '/v1/probe/closed', { pin: false })
  .authenticated('POST', '/v1/probe/money', { pin: true })
  .staff('POST', '/v1/probe/review', { pin: true, role: 'giftcard_reviewer' });

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: API_CONFIG, useValue: config },
    { provide: ROUTE_POLICY, useValue: policy },
    { provide: CLOCK, useValue: { nowMs: () => NOW * 1000, nowSeconds: () => NOW } },
    { provide: PinService, useValue: pins },
    // Stands in for the real StaffService, which needs a database. These
    // tests cover the guard's ORDERING -- that a role is checked after the
    // bearer token and before the PIN -- not the role lookup itself, which is
    // exercised end to end against real rows.
    { provide: StaffService, useValue: staff },
    { provide: StaffTotpService, useValue: totp },
    // The REAL limiter over a real in-memory store. A stand-in here would
    // assert that a mock matches the guard's expectations rather than that the
    // limiter runs where the guard puts it — and where it runs is the whole
    // claim being made about it.
    { provide: RATE_LIMIT_STORE, useValue: new InMemoryRateLimitStore() },
    RequestRateLimiter,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class ProbeModule {}

let app: INestApplication;

const bearer = (ttl = 900, at = NOW): string =>
  signAccessToken({ sub: 'u', sid: 's', did: 'd' }, keyring, at, ttl);

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
});

beforeEach(() => {
  pinCalls.length = 0;
  pinAccepts = true;
  staffCalls.length = 0;
  staffAccepts = true;
  totpCalls.length = 0;
  totpEnrolled = true;
  totpAccepts = true;
});

afterAll(async () => {
  await app?.close();
});

describe('deny by default', () => {
  it('refuses a route no policy declares', async () => {
    // The route exists and its handler would happily return 200. Nothing about
    // the handler says "authenticate me" — the denial comes from the absence of
    // a declaration, which is the only way forgetting can be made loud.
    const res = await request(app.getHttpServer()).get('/v1/probe/forgotten');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('route_not_declared');
  });

  it('allows a declared public route with no credentials', async () => {
    const res = await request(app.getHttpServer()).get('/v1/probe/open').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('refuses a declared authenticated route with no credentials', async () => {
    const res = await request(app.getHttpServer()).get('/v1/probe/closed');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});

describe('bearer verification', () => {
  it('allows a valid token', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe/closed')
      .set('Authorization', `Bearer ${bearer()}`)
      .expect(200);
  });

  it('refuses an expired token', async () => {
    const stale = signAccessToken({ sub: 'u', sid: 's', did: 'd' }, keyring, NOW - 5000, 900);
    const res = await request(app.getHttpServer())
      .get('/v1/probe/closed')
      .set('Authorization', `Bearer ${stale}`);
    expect(res.status).toBe(401);
  });

  it('refuses a token signed with another key', async () => {
    const foreign = { version: 'v1', secret: randomBytes(32) };
    const forged = signAccessToken(
      { sub: 'u', sid: 's', did: 'd' },
      { current: foreign, accepted: [foreign] },
      NOW,
      900,
    );
    await request(app.getHttpServer())
      .get('/v1/probe/closed')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('tells the client nothing about WHY a token failed', () => {
    // Expired, forged and malformed must be indistinguishable from outside.
    // Which one it was is in our logs, where it is useful.
    return (async () => {
      const headers = ['Bearer nonsense', 'Basic abc', 'Bearer ', 'Bearer a.b.c.d'];
      for (const header of headers) {
        const res = await request(app.getHttpServer())
          .get('/v1/probe/closed')
          .set('Authorization', header);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_token');
      }

      // No header at all is the same answer.
      const bare = await request(app.getHttpServer()).get('/v1/probe/closed');
      expect(bare.status).toBe(401);
      expect(bare.body.error).toBe('invalid_token');
    })();
  });
});

describe('PIN-guarded routes', () => {
  it('verifies the transaction PIN before the handler runs', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/probe/money')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '374915' });

    // 201: the probe controller sets no @HttpCode, so Nest's POST default
    // applies. The real transfer route pins it to 200.
    expect(res.status).toBe(201);
    expect(pinCalls).toEqual([{ sub: 'u', pin: '374915' }]);
  });

  it('refuses a money route with no PIN in the body', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/probe/money')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('transaction_pin_required');
    expect(pinCalls).toEqual([]);
  });

  it('refuses when the PIN is wrong', async () => {
    pinAccepts = false;
    const res = await request(app.getHttpServer())
      .post('/v1/probe/money')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '000001' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_pin');
  });

  it('does not spend a PIN attempt when the session is invalid', async () => {
    // Order matters. Verifying a PIN for a caller whose bearer token is
    // forged would burn one of that customer's five attempts on a request
    // they never made -- a way to lock anyone out of their own money.
    const res = await request(app.getHttpServer())
      .post('/v1/probe/money')
      .set('Authorization', 'Bearer forged')
      .send({ transaction_pin: '374915' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
    expect(pinCalls).toEqual([]);
  });

  it('does not ask for a PIN on a route that does not require one', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe/closed')
      .set('Authorization', `Bearer ${bearer()}`)
      .expect(200);

    expect(pinCalls).toEqual([]);
  });
});

describe('staff routes', () => {
  it('refuses a signed-in customer who holds no role', async () => {
    staffAccepts = false;
    const res = await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456' });

    expect(res.status).toBe(403);
    // No detail about which role was wanted. Somebody probing admin paths
    // learns only that they cannot have them.
    expect(res.body.error).toBe('forbidden');
  });

  it('checks the role BEFORE the PIN', async () => {
    // The ordering claim, asserted rather than commented. A customer poking at
    // an admin path must not have one of their five PIN attempts spent proving
    // they are not staff — that is a way to lock somebody out of their own
    // money from an endpoint they were never allowed to call.
    staffAccepts = false;
    await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456' });

    expect(staffCalls).toHaveLength(1);
    expect(pinCalls).toHaveLength(0);
  });

  it('does not look up a role for an unverified caller', async () => {
    // And the same ordering one level up: an unauthenticated request must not
    // reach the database at all.
    const res = await request(app.getHttpServer()).post('/v1/probe/review').send({});
    expect(res.status).toBe(401);
    expect(staffCalls).toHaveLength(0);
  });

  it('lets a reviewer through, and still asks for their PIN', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456', totp_code: '123456' })
      .expect(201);

    expect(res.body).toEqual({ ok: true });
    expect(staffCalls).toEqual(['u:giftcard_reviewer']);
    expect(pinCalls).toHaveLength(1);
  });
});

describe('the staff second factor', () => {
  it('refuses an operator who has not enrolled one', async () => {
    // Every staff route, including reads. Gating only the ACTING routes would
    // leave the whole customer database — names, balances, KYC status — behind
    // one password, and that data is what a targeted phishing campaign is
    // built from.
    totpEnrolled = false;
    const res = await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456', totp_code: '123456' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('totp_not_enrolled');
  });

  it('refuses an acting route with no code in the body', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('totp_required');
  });

  it('refuses a wrong code', async () => {
    totpAccepts = false;
    const res = await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456', totp_code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_totp');
  });

  it('checks the ROLE before the second factor', async () => {
    // Same rule the PIN already follows. A customer poking at an admin path
    // must not be able to burn an operator's five TOTP attempts — that is a
    // way to lock the operations team out of their own dashboard from an
    // endpoint the attacker was never allowed to call.
    staffAccepts = false;
    await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456', totp_code: '123456' })
      .expect(403);

    expect(totpCalls).toEqual([]);
  });

  it('checks the second factor BEFORE the PIN', async () => {
    // And the PIN after that, so a failed second factor does not spend a PIN
    // attempt either. The order is bearer, role, factor, PIN — cheapest and
    // least damaging refusal first, every time.
    totpAccepts = false;
    await request(app.getHttpServer())
      .post('/v1/probe/review')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456', totp_code: '000000' })
      .expect(401);

    expect(pinCalls).toEqual([]);
  });

  it('does not ask a plain customer for a second factor', async () => {
    // A money route is not a staff route. Requiring an authenticator app to
    // send somebody money would be a different product.
    await request(app.getHttpServer())
      .post('/v1/probe/money')
      .set('Authorization', `Bearer ${bearer()}`)
      .send({ transaction_pin: '123456' })
      .expect(201);

    expect(totpCalls).toEqual([]);
  });
});

/**
 * The general request ceiling, through the guard rather than around it.
 *
 * A separate application with REAL numbers, because the app above deliberately
 * runs with limits nothing can reach. What is asserted here is not that a
 * sliding window counts — `rate-limit.test.ts` and the shared contract suite
 * cover that against both backends — but the three things only the wiring can
 * be wrong about: that the ceiling applies to ordinary routes at all, that it
 * counts the CUSTOMER rather than the address, and that it refuses before the
 * PIN is ever looked at.
 */
describe('the general request ceiling', () => {
  const tightConfig = {
    accessTokenKeyring: keyring,
    accessTokenTtlSeconds: 900,
    requestRateLimit: {
      windowSeconds: 60,
      publicMax: 3,
      readMax: 3,
      writeMax: 3,
      moneyMax: 2,
      staffMax: 3,
    },
  } as unknown as ApiConfig;

  const tightPinCalls: string[] = [];
  const tightPins = {
    async assertValid(sub: string): Promise<void> {
      tightPinCalls.push(sub);
    },
  } as unknown as PinService;

  @Module({
    controllers: [ProbeController],
    providers: [
      { provide: API_CONFIG, useValue: tightConfig },
      { provide: ROUTE_POLICY, useValue: policy },
      { provide: CLOCK, useValue: { nowMs: () => NOW * 1000, nowSeconds: () => NOW } },
      { provide: PinService, useValue: tightPins },
      { provide: StaffService, useValue: staff },
      { provide: StaffTotpService, useValue: totp },
      { provide: RATE_LIMIT_STORE, useValue: new InMemoryRateLimitStore() },
      RequestRateLimiter,
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
  class TightModule {}

  let tight: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [TightModule] }).compile();
    tight = mod.createNestApplication(new ExpressAdapter());
    await tight.init();
  });

  afterAll(async () => {
    await tight.close();
  });

  const tokenFor = (sub: string): string =>
    signAccessToken({ sub, sid: 's', did: 'd' }, keyring, NOW, 900);

  it('refuses an ordinary read once the ceiling is reached', async () => {
    // The gap this closes: before it existed, only login, registration and
    // password reset had any ceiling, so a stolen session could read a
    // customer's whole history as fast as the network allowed.
    const token = tokenFor('reader');
    for (let i = 0; i < 3; i += 1) {
      await request(tight.getHttpServer())
        .get('/v1/probe/closed')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
    }

    const blocked = await request(tight.getHttpServer())
      .get('/v1/probe/closed')
      .set('authorization', `Bearer ${token}`)
      .expect(429);

    // A DISTINCT code from the credential limiter's `too_many_attempts`: one
    // means "too fast", the other "we have stopped accepting guesses at this
    // account", and a client showing the same words for both would tell a
    // customer their sign-in was blocked when it was not.
    expect(blocked.body.error).toBe('too_many_requests');
    expect(blocked.body.retry_after_seconds).toBeGreaterThan(0);
  });

  it('counts the CUSTOMER, not the address', async () => {
    // THE NIGERIA-SPECIFIC CASE. Both customers here arrive from the same
    // address, which is what carrier-grade NAT does to a whole MTN or Airtel
    // subscriber pool. Keyed on the address, the second customer would be
    // refused for what the first one did.
    const first = tokenFor('nat-one');
    const second = tokenFor('nat-two');

    for (let i = 0; i < 3; i += 1) {
      await request(tight.getHttpServer())
        .get('/v1/probe/closed')
        .set('authorization', `Bearer ${first}`)
        .expect(200);
    }
    await request(tight.getHttpServer())
      .get('/v1/probe/closed')
      .set('authorization', `Bearer ${first}`)
      .expect(429);

    // Same socket, different account, unaffected.
    await request(tight.getHttpServer())
      .get('/v1/probe/closed')
      .set('authorization', `Bearer ${second}`)
      .expect(200);
  });

  it('refuses BEFORE the PIN is verified', async () => {
    /*
     * The ordering claim, and the reason it matters is cost rather than
     * neatness. A PIN is verified with scrypt, which is deliberately slow —
     * that slowness is what makes five attempts meaningful. If the ceiling ran
     * after it, a flood would spend that cost on every request before being
     * refused, and the limiter would be what brought the instance down.
     */
    const token = tokenFor('spender');
    for (let i = 0; i < 2; i += 1) {
      await request(tight.getHttpServer())
        .post('/v1/probe/money')
        .set('authorization', `Bearer ${token}`)
        .send({ transaction_pin: '1234' })
        // 201, because Nest answers a POST that way by default.
        .expect(201);
    }
    expect(tightPinCalls.filter((s) => s === 'spender')).toHaveLength(2);

    await request(tight.getHttpServer())
      .post('/v1/probe/money')
      .set('authorization', `Bearer ${token}`)
      .send({ transaction_pin: '1234' })
      .expect(429);

    // Still two. The refused request never reached scrypt.
    expect(tightPinCalls.filter((s) => s === 'spender')).toHaveLength(2);
  });

  it('gives money routes a tighter ceiling than reads', async () => {
    // Two classes, derived from the policy each route already declares rather
    // than from a second list somebody has to remember to fill in.
    const token = tokenFor('classes');
    for (let i = 0; i < 3; i += 1) {
      await request(tight.getHttpServer())
        .get('/v1/probe/closed')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
    }
    // The read bucket is now full; the money bucket is untouched and smaller.
    for (let i = 0; i < 2; i += 1) {
      await request(tight.getHttpServer())
        .post('/v1/probe/money')
        .set('authorization', `Bearer ${token}`)
        .send({ transaction_pin: '1234' })
        // 201, because Nest answers a POST that way by default.
        .expect(201);
    }
    await request(tight.getHttpServer())
      .post('/v1/probe/money')
      .set('authorization', `Bearer ${token}`)
      .send({ transaction_pin: '1234' })
      .expect(429);
  });

  it('does not spend a bucket on a request with no valid token', async () => {
    // The ceiling sits after the bearer check, so an unauthenticated caller
    // cannot fill a real customer's bucket by guessing their id.
    for (let i = 0; i < 10; i += 1) {
      await request(tight.getHttpServer())
        .get('/v1/probe/closed')
        .set('authorization', 'Bearer forged')
        .expect(401);
    }

    await request(tight.getHttpServer())
      .get('/v1/probe/closed')
      .set('authorization', `Bearer ${tokenFor('untouched')}`)
      .expect(200);
  });
});
