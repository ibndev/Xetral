import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Get,
  Module,
  NotFoundException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { open } from '@xetral/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_CONFIG, DATABASE, NOTIFICATION_PORT } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { ErrorRecorder, fingerprintOf } from './error-recorder.service.js';
import { ErrorRecordingFilter } from './error.filter.js';
import { ErrorAlertService } from './error-alert.service.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Error capture, against a real database.
 *
 * The filter is driven through a REAL Nest application with real handlers that
 * throw, rather than by calling `catch()` directly. What is under test is not
 * "does this method run" but "does an exception escaping a handler end up in
 * the table" — and the wiring between those two is exactly where the audit
 * found three controllers that were imported and never mounted.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the error capture e2e suite needs DATABASE_URL with the migrations applied');
}

/** Handlers that fail in each of the ways that matter. */
@Controller('probe')
class FailingController {
  @Get('throws')
  throws(): never {
    throw new Error('the probe exploded');
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException({ error: 'nothing_here' });
  }

  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException({ error: 'invalid_request' });
  }

  @Get('fine')
  fine(): { ok: boolean } {
    return { ok: true };
  }
}

let pool: Pool;
let app: INestApplication;
let recorder: ErrorRecorder;
let alerts: ErrorAlertService;
let config: ReturnType<typeof testApiConfig>;

const countFor = async (fingerprint: string): Promise<number> => {
  const row = await pool.query<{ occurrences: string }>(
    `SELECT occurrences::text AS occurrences FROM error_events WHERE fingerprint = $1`,
    [fingerprint],
  );
  return Number(row.rows[0]?.occurrences ?? '0');
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  config = testApiConfig(DATABASE_URL as string);

  const mod = await Test.createTestingModule({
    imports: [
      (() => {
        @Module({
          controllers: [FailingController],
          providers: [
            { provide: DATABASE, useValue: pool },
            { provide: API_CONFIG, useValue: config },
            // No mailer. The alerts are asserted against the OUTBOX — the row
            // is the guarantee, and what happens after it is the worker's
            // problem, tested in the password reset suite.
            { provide: NOTIFICATION_PORT, useValue: undefined },
            ErrorRecorder,
            NotificationService,
            ErrorAlertService,
            { provide: APP_FILTER, useClass: ErrorRecordingFilter },
          ],
        })
        class ProbeModule {}
        return ProbeModule;
      })(),
    ],
  }).compile();

  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  recorder = app.get(ErrorRecorder);
  alerts = app.get(ErrorAlertService);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('what the filter records', () => {
  it('records an unhandled throw', async () => {
    const res = await request(app.getHttpServer()).get('/probe/throws');
    expect(res.status).toBe(500);
    // The body says nothing about the exception. A 500 that started describing
    // what threw would be an information leak added by the thing meant to
    // help.
    expect(res.body).toEqual({ error: 'internal_error' });

    // Recording is deliberately not awaited by the filter, so give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const fingerprint = fingerprintOf({
      message: 'Error: the probe exploded',
      route: '/probe/throws',
    });
    expect(await countFor(fingerprint)).toBeGreaterThanOrEqual(1);
  });

  it('does NOT record a 404', async () => {
    // A 4xx is the system working. Recording them would bury the one row that
    // matters under ten thousand that do not, and the end of that is nobody
    // opening the page.
    await request(app.getHttpServer()).get('/probe/not-found').expect(404);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const row = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM error_events WHERE route = '/probe/not-found'`,
    );
    expect(row.rows[0]?.n).toBe('0');
  });

  it('does NOT record a 400', async () => {
    await request(app.getHttpServer()).get('/probe/bad-request').expect(400);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const row = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM error_events WHERE route = '/probe/bad-request'`,
    );
    expect(row.rows[0]?.n).toBe('0');
  });

  it('leaves a working request alone', async () => {
    await request(app.getHttpServer()).get('/probe/fine').expect(200);
  });

  it('records the route PATTERN, never a resolved path', async () => {
    const row = await pool.query<{ route: string }>(
      `SELECT route FROM error_events WHERE route LIKE '/probe/%' LIMIT 1`,
    );
    // A resolved path would carry customer identifiers into a table read by
    // everybody on call, and would give every customer their own fingerprint.
    expect(row.rows[0]?.route).toBe('/probe/throws');
  });

  it('counts repeats rather than accumulating rows', async () => {
    const fingerprint = fingerprintOf({
      message: 'Error: the probe exploded',
      route: '/probe/throws',
    });
    const before = await countFor(fingerprint);

    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer()).get('/probe/throws').expect(500);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await countFor(fingerprint)).toBe(before + 3);

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM error_events WHERE fingerprint = $1`,
      [fingerprint],
    );
    expect(rows.rows[0]?.n).toBe('1');
  });
});

describe('the recorder never makes things worse', () => {
  it('does not throw when the message is enormous', async () => {
    // It is truncated, not refused. A recorder that threw on a long message
    // would fail inside an exception filter written never to throw.
    await expect(
      recorder.record({ message: 'x'.repeat(50_000), route: '/probe/huge', statusCode: 500 }),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the database refuses the write', async () => {
    // A severity outside the enum is refused by Postgres. The point is not the
    // severity — it is that a failing recorder is swallowed rather than
    // propagated into whatever was already going wrong.
    await expect(
      recorder.record({
        message: 'a failure while failing',
        severity: 'catastrophic' as 'error',
        statusCode: 500,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('alerting', () => {
  it('tells somebody about a failure nobody has heard of', async () => {
    const marker = `alert-probe-${randomUUID()}`;
    await recorder.record({ message: marker, route: '/probe/alert', statusCode: 500 });

    const report = await alerts.sweep();
    expect(report.sent).toBeGreaterThanOrEqual(1);

    const fingerprint = fingerprintOf({ message: marker, route: '/probe/alert' });
    const queued = await pool.query<{ payload_sealed: string }>(
      `SELECT payload_sealed FROM notification_outbox
        WHERE kind = 'operations_alert' AND idempotency_key LIKE $1
        ORDER BY id DESC LIMIT 1`,
      [`error_alert:${fingerprint}:%`],
    );

    const sealed = queued.rows[0]?.payload_sealed;
    expect(sealed, 'no operations alert was queued').toBeDefined();

    const keyring = config.encryptionKeyring;
    if (keyring === undefined) throw new Error('the fixture has no keyring');
    const rendered = JSON.parse(open(sealed as string, keyring)) as { subject: string };
    expect(rendered.subject).toContain('New failure');
  });

  it('does not say it again just because it happened again', async () => {
    // The rule that keeps the channel worth reading. Every open bug happens
    // again; alerting on that is how an alert becomes noise and then a mute.
    const marker = `repeat-probe-${randomUUID()}`;
    await recorder.record({ message: marker, route: '/probe/alert', statusCode: 500 });
    await alerts.sweep();

    await recorder.record({ message: marker, route: '/probe/alert', statusCode: 500 });
    const second = await alerts.sweep();

    const fingerprint = fingerprintOf({ message: marker, route: '/probe/alert' });
    const alerted = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox
        WHERE idempotency_key LIKE $1`,
      [`error_alert:${fingerprint}:%`],
    );
    expect(alerted.rows[0]?.n).toBe('1');
    expect(second.due).toBe(0);
  });

  it('DOES say it again when it gets an order of magnitude worse', async () => {
    const marker = `escalate-probe-${randomUUID()}`;
    await recorder.record({ message: marker, route: '/probe/alert', statusCode: 500 });
    await alerts.sweep();

    const fingerprint = fingerprintOf({ message: marker, route: '/probe/alert' });
    await pool.query(`UPDATE error_events SET occurrences = 40 WHERE fingerprint = $1`, [
      fingerprint,
    ]);

    await alerts.sweep();

    const alerted = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox WHERE idempotency_key LIKE $1`,
      [`error_alert:${fingerprint}:%`],
    );
    expect(alerted.rows[0]?.n).toBe('2');
  });

  it('reopens a resolved failure when it recurs', async () => {
    const marker = `reopen-probe-${randomUUID()}`;
    await recorder.record({ message: marker, route: '/probe/alert', statusCode: 500 });
    const fingerprint = fingerprintOf({ message: marker, route: '/probe/alert' });

    expect(await recorder.resolve(fingerprint)).toBe(true);
    let open_ = await pool.query(`SELECT 1 FROM errors_open WHERE fingerprint = $1`, [fingerprint]);
    expect(open_.rows.length).toBe(0);

    await recorder.record({ message: marker, route: '/probe/alert', statusCode: 500 });
    open_ = await pool.query(`SELECT 1 FROM errors_open WHERE fingerprint = $1`, [fingerprint]);
    // A bug somebody closed and which has come back is news again. Leaving it
    // resolved would hide the recurrence behind the fix that did not work.
    expect(open_.rows.length).toBe(1);
  });
});
