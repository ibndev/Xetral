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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from './auth.guard.js';
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
  /** Declared nowhere. The mistake this whole design exists to catch. */
  @Get('forgotten') forgotten(): { ok: boolean } { return { ok: true }; }
}

const policy = new RoutePolicyRegistry()
  .public('GET', '/v1/probe/open', 'a probe with no customer data, for these tests')
  .authenticated('GET', '/v1/probe/closed', { pin: false })
  .authenticated('POST', '/v1/probe/money', { pin: true });

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: API_CONFIG, useValue: config },
    { provide: ROUTE_POLICY, useValue: policy },
    { provide: CLOCK, useValue: { nowMs: () => NOW * 1000, nowSeconds: () => NOW } },
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

describe('PIN-guarded routes fail closed', () => {
  it('refuses a route declaring pin: true while enforcement is unbuilt', async () => {
    // The one outcome that must never happen is a money-moving route serving
    // traffic while its author believes `pin: true` is protecting it. Until the
    // PIN check exists, such a route cannot respond at all -- even with a
    // perfectly valid access token.
    const res = await request(app.getHttpServer())
      .post('/v1/probe/money')
      .set('Authorization', `Bearer ${bearer()}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('pin_enforcement_unavailable');
  });
});
