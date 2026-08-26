import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { ngn } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import type { ProviderBalancePort } from '@xetral/providers';
import { ProviderUnavailableError } from '@xetral/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BalanceReconciliationService } from './balance-reconciliation.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * Comparing what the provider says it holds against what the ledger says.
 *
 * THE CLAIM UNDER TEST IS THAT IT NEVER CORRECTS. Recording a discrepancy is
 * easy; the discipline is refusing to post an adjustment that would make the
 * ledger agree with a number that is routinely and legitimately stale. A card
 * authorisation and its settlement are up to fourteen business days apart, so
 * "the provider says something different" is a question, not a fact about the
 * money.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the balance reconciliation suite needs DATABASE_URL');
}

let pool: Pool;
let ledger: LedgerService;
let settings: SettingsService;
let notifications: NotificationService;

/** A provider that says exactly what a test tells it to say. */
class StubBalances implements ProviderBalancePort {
  readonly provider = 'bitnob';
  constructor(private readonly answer: () => readonly Money<Currency>[]) {}
  async floatBalances(): Promise<readonly Money<Currency>[]> {
    return this.answer();
  }
}

function serviceWith(port: ProviderBalancePort): BalanceReconciliationService {
  // No card port: the float half is what this suite drives, and a real card
  // port would need a provider.
  return new BalanceReconciliationService(
    pool,
    testApiConfig(DATABASE_URL as string),
    settings,
    notifications,
    port,
    undefined,
  );
}

/** The ledger's own view of the NGN float, in minor units. */
async function ledgerFloat(): Promise<bigint> {
  const r = await pool.query<{ minor: string }>(
    `SELECT COALESCE(SUM(b.balance_minor), 0)::text AS minor
       FROM accounts a JOIN account_balances b ON b.account_id = a.id
      WHERE a.kind = 'provider_float' AND a.currency = 'NGN'`,
  );
  return BigInt(r.rows[0]?.minor ?? '0');
}

const openFindings = async (): Promise<number> => {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM provider_balance_drift WHERE scope = 'provider_float'`,
  );
  return Number(r.rows[0]?.n ?? '0');
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  ledger = new LedgerService(pool);
  const config = testApiConfig(DATABASE_URL as string);
  settings = new SettingsService(pool, config);
  notifications = new NotificationService(config, pool, undefined);

  // Give the float a non-zero, known position.
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [`balance-${randomUUID()}@example.ng`],
  );
  await ledger.post({
    idempotencyKey: `balance-seed:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'seed',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: user.rows[0]!.id, currency: 'NGN' }, ngn(50_000)),
      posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-50_000)),
    ],
  });
});

afterAll(async () => {
  await pool?.end();
});

describe('when the two sides agree', () => {
  it('records NOTHING', async () => {
    // The absence of a row IS the pass. A row per agreement would be thousands
    // a day, hiding the handful that matter.
    const ours = await ledgerFloat();
    const before = await openFindings();

    const report = await serviceWith(
      new StubBalances(() => [{ amount: ours, currency: 'NGN' } as Money<Currency>]),
    ).sweep();

    expect(report.checked).toBeGreaterThan(0);
    expect(report.differences).toBe(0);
    expect(await openFindings()).toBe(before);
  });
});

describe('when they disagree', () => {
  it('records the finding and does NOT touch the ledger', async () => {
    const ours = await ledgerFloat();
    const before = await openFindings();

    // The provider claims 900 kobo more than we do.
    const claimed = ours + 900n;
    const report = await serviceWith(
      new StubBalances(() => [{ amount: claimed, currency: 'NGN' } as Money<Currency>]),
    ).sweep();

    expect(report.differences).toBe(1);
    expect(await openFindings()).toBe(before + 1);

    const row = await pool.query<{ provider_minor: string; ledger_minor: string; difference_minor: string }>(
      `SELECT provider_minor::text, ledger_minor::text, difference_minor::text
         FROM provider_balance_checks
        WHERE scope = 'provider_float' AND currency = 'NGN'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(row.rows[0]?.provider_minor).toBe(claimed.toString());
    expect(row.rows[0]?.ledger_minor).toBe(ours.toString());
    expect(row.rows[0]?.difference_minor).toBe('900');

    // THE POINT OF THE WHOLE DESIGN: the ledger is exactly where it was. No
    // adjusting entry was posted to make the books agree with the provider.
    expect(await ledgerFloat()).toBe(ours);
  });

  it('posts no journal entry of any kind', async () => {
    // Asserted on the entry count rather than on the balance alone, because an
    // adjustment that happened to net to zero would still be a fabricated
    // entry sitting in the customer's history.
    const before = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries`,
    );
    await serviceWith(
      new StubBalances(() => [{ amount: 123_456_789n, currency: 'NGN' } as Money<Currency>]),
    ).sweep();
    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe('when the provider cannot be reached', () => {
  it('records no finding — an outage is not a discrepancy', async () => {
    // Recording one would fill the queue with findings about our own
    // connectivity, and the real one would be lost among them. Same rule the
    // purchase sweep follows on a refused connection.
    const before = await openFindings();

    const report = await serviceWith(
      new StubBalances(() => {
        throw new ProviderUnavailableError('bitnob', 'connection refused');
      }),
    ).sweep();

    expect(report.skipped).toBe(1);
    expect(report.differences).toBe(0);
    expect(await openFindings()).toBe(before);
  });
});

describe('the tolerance', () => {
  it('ships at zero, so the smallest difference is still a finding', async () => {
    const ours = await ledgerFloat();
    const before = await openFindings();

    // ONE kobo. On a double-entry ledger the correct difference is nothing.
    const report = await serviceWith(
      new StubBalances(() => [{ amount: ours + 1n, currency: 'NGN' } as Money<Currency>]),
    ).sweep();

    expect(report.differences).toBe(1);
    expect(await openFindings()).toBe(before + 1);
  });
});
