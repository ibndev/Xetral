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
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from './auth.guard.js';
import { PinService } from './pin.service.js';
import { StaffService } from './staff.service.js';
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

const config = {
  accessTokenKeyring: keyring,
  accessTokenTtlSeconds: 900,
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
      .send({ transaction_pin: '123456' })
      .expect(201);

    expect(res.body).toEqual({ ok: true });
    expect(staffCalls).toEqual(['u:giftcard_reviewer']);
    expect(pinCalls).toHaveLength(1);
  });
});
