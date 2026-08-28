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
 * The metrics endpoint.
 *
 * THE ACCESS DECISION IS THE PART WORTH PROVING. This publishes queue depths,
 * provider health and what the platform owes customers — a
 * business-intelligence leak to anything that can route to the instance, and
 * worse: a drift figure published openly tells somebody the books are
 * inconsistent before we have noticed. It is declared public in the route
 * policy because a scraper has no session, and everything that makes it not
 * actually public happens in the handler.
 *
 * Requires DATABASE_URL with every migration applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the metrics e2e suite needs DATABASE_URL');
}

const TOKEN = `metrics-${randomUUID()}`;

let pool: Pool;
let guarded: INestApplication;
let unconfigured: INestApplication;

async function boot(metricsToken: string | undefined): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string, { metricsToken }),
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  const app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  return app;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  guarded = await boot(TOKEN);
  unconfigured = await boot(undefined);
});

afterAll(async () => {
  await guarded?.close();
  await unconfigured?.close();
  await pool?.end();
});

describe('who can read it', () => {
  it('answers 404 when no token is configured', async () => {
    // NOT 401. An unconfigured endpoint that answered 401 would confirm to a
    // prober that it exists and is worth coming back to; with no token there
    // is genuinely nothing here to authorise against.
    const res = await request(unconfigured.getHttpServer()).get('/metrics');
    expect(res.status).toBe(404);
  });

  it('refuses an unauthenticated scrape', async () => {
    const res = await request(guarded.getHttpServer()).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', 'Bearer not-the-token');
    expect(res.status).toBe(401);
  });

  it('serves the right one', async () => {
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('is not cached by anything in front of it', async () => {
    // It carries balances and queue depths, so a proxy holding a copy is a
    // copy of that outside the credential.
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('what it says', () => {
  it('reports every queue the overview declares', async () => {
    // Measured from the same view the dashboard reads, so a queue added later
    // is scraped without anybody remembering — the guarantee 036 gives the
    // dashboard, extended to monitoring.
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    const declared = await pool.query<{ queue_name: string }>(
      `SELECT queue_name FROM attention_sources WHERE decision = 'queue'`,
    );
    expect(declared.rowCount).toBeGreaterThan(20);

    for (const row of declared.rows) {
      expect(res.text).toContain(`xetral_queue_waiting{queue="${row.queue_name}"}`);
    }
  });

  it('reports liability in MINOR units', async () => {
    // Prometheus samples are floats, so a naira balance in major units would
    // be a float holding money — the one thing this codebase does not do. The
    // unit is in the name so nobody divides by a hundred twice.
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(res.text).toContain('xetral_customer_liability_minor');
    expect(res.text).not.toContain('xetral_customer_liability{');
  });

  it('is well-formed exposition', async () => {
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    for (const line of res.text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      // `name{labels} value` or `name value`, and the value is a bare number.
      // A stray quote or newline in a label would break every sample after it,
      // which is why the labels are escaped.
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?[0-9]+$/);
    }
  });

  it('says how long this instance has been up', async () => {
    // The cheapest way to see a crash loop: a process that restarts every
    // ninety seconds never reports an uptime above it.
    const res = await request(guarded.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.text).toMatch(/xetral_uptime_seconds [0-9]+/);
  });
});
