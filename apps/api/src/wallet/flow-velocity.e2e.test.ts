import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { money } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpendingLimitService } from './spending-limits.service.js';
import type { LimitScope } from './spending-limits.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * The ceilings on crypto withdrawals, conversions and gift card payouts.
 *
 * Driven through `precondition()` against a real ledger rather than over HTTP,
 * because every one of those routes needs a provider to reach its posting and
 * what is under test is the RULE, not the plumbing in front of it. The rule is
 * where the mistake would be: these three flows had no ceiling at all, and a
 * crypto withdrawal is the only movement here that nobody can recall once it
 * has gone.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the flow velocity suite needs DATABASE_URL');
}

let pool: Pool;
let ledger: LedgerService;
let limits: SpendingLimitService;
let settings: SettingsService;

async function customer(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [`velocity-${randomUUID()}@example.ng`],
  );
  return r.rows[0]!.id;
}

/** Credits a wallet in any asset, so a ceiling can be reached without an overdraft. */
async function fund(userId: string, amount: Money<Currency>): Promise<void> {
  await ledger.post({
    idempotencyKey: `flowvel-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'seed',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: amount.currency }, amount),
      posting({ kind: 'provider_float', currency: amount.currency }, money(-amount.amount, amount.currency)),
    ],
  });
}

/**
 * Posts one movement of a scope, through its real precondition.
 *
 * Returns the error code when the limit refused it, or undefined when it went
 * through — so a test reads as the sequence of outcomes a customer would get.
 */
async function move(
  userId: string,
  scope: LimitScope,
  kind: string,
  amount: Money<Currency>,
): Promise<string | undefined> {
  const key = `flowvel:${scope}:${randomUUID()}`;
  const precondition = await limits.precondition({ userId, scope, amount, idempotencyKey: key });

  try {
    await ledger.post(
      {
        idempotencyKey: key,
        kind: kind as never,
        occurredAt: new Date(),
        description: `${scope} probe`,
        metadata: {},
        postings: [
          posting({ kind: 'customer_wallet', ownerId: userId, currency: amount.currency },
                   money(-amount.amount, amount.currency)),
          posting({ kind: 'provider_float', currency: amount.currency }, amount),
        ],
      },
      precondition === undefined ? {} : { precondition },
    );
    return undefined;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return typeof response === 'object' && response !== null && 'error' in response
      ? String((response as { error: unknown }).error)
      : String((error as Error).message);
  }
}

/**
 * Changes a limit AND refreshes the cache.
 *
 * `SettingsService` caches for thirty seconds, which is correct in production
 * and is a trap here: written as a bare UPDATE, this test set a BTC ceiling of
 * 1,000 BTC, read the cached 0.1 BTC, and reported a refusal as though the
 * per-asset ceiling were broken. The setting was right and the reader was
 * stale.
 */
async function setLimit(key: string, value: string): Promise<void> {
  await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  await settings.refresh();
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  ledger = new LedgerService(pool);
  settings = new SettingsService(pool, testApiConfig(DATABASE_URL as string));
  limits = new SpendingLimitService(settings);

  // Small enough to reach without a hundred postings.
  await setLimit('crypto_withdrawal_count_hourly', '2');
  await setLimit('fx_count_hourly', '2');
  await setLimit('giftcard_count_hourly', '2');
  await setLimit('crypto_daily_limit_usdt_minor', '10000000'); // 10 USDT
});

afterAll(async () => {
  await pool?.end();
});

describe('crypto withdrawals', () => {
  it('refuses past the hourly COUNT, in an asset no kobo limit could reach', async () => {
    // The gap this closes. A kobo ceiling is a statement about naira, so the
    // only control that can cover USDT at all is a count — and there was none.
    const user = await customer();
    await fund(user, money(50_000_000n, 'USDT' as Currency));

    expect(await move(user, 'crypto_withdrawal', 'crypto_withdrawal', money(1_000_000n, 'USDT' as Currency))).toBeUndefined();
    expect(await move(user, 'crypto_withdrawal', 'crypto_withdrawal', money(1_000_000n, 'USDT' as Currency))).toBeUndefined();
    expect(await move(user, 'crypto_withdrawal', 'crypto_withdrawal', money(1_000_000n, 'USDT' as Currency)))
      .toBe('too_many_transfers');
  });

  it('refuses past the PER-ASSET daily amount, in that asset own minor units', async () => {
    // USDT has six decimals, so 10,000,000 is ten USDT. One number shared with
    // BTC would mean a tenth of a Bitcoin — which is why the ceiling is named
    // per asset rather than made currency-agnostic.
    await setLimit('crypto_withdrawal_count_hourly', '50');
    const user = await customer();
    await fund(user, money(50_000_000n, 'USDT' as Currency));

    expect(await move(user, 'crypto_withdrawal', 'crypto_withdrawal', money(9_000_000n, 'USDT' as Currency))).toBeUndefined();
    // Would take the day to 11 USDT against a 10 USDT ceiling.
    expect(await move(user, 'crypto_withdrawal', 'crypto_withdrawal', money(2_000_000n, 'USDT' as Currency)))
      .toBe('daily_limit_exceeded');

    await setLimit('crypto_withdrawal_count_hourly', '2');
  });

  it('reads BTC against its OWN ceiling, in satoshi', async () => {
    // The claim that matters: 10,000,000 means ten USDT and a tenth of a BTC,
    // so a shared number would be two different limits wearing one name. Here
    // BTC is given a ceiling a USDT-sized number could never express, and an
    // amount far above the USDT ceiling passes.
    await setLimit('crypto_withdrawal_count_hourly', '50');
    await setLimit('crypto_daily_limit_btc_minor', '100000000000');
    const user = await customer();
    await fund(user, money(500_000_000n, 'BTC' as Currency));

    expect(
      await move(user, 'crypto_withdrawal', 'crypto_withdrawal', money(400_000_000n, 'BTC' as Currency)),
    ).toBeUndefined();
    await setLimit('crypto_withdrawal_count_hourly', '2');
  });

  it('has NO amount ceiling for an asset nobody configured', async () => {
    /*
     * Deliberate and visible: a limit nobody set must not refuse every
     * withdrawal of that asset, and must not pretend to cap one either. The
     * hourly count still applies, which is the point of having both.
     *
     * Asserted on the ACCESSOR rather than by removing a row. The first
     * version deleted `crypto_daily_limit_btc_minor` — and when the suite was
     * re-run as the restricted `xetral_app` role it failed, because the
     * application holds DELETE on nothing at all. The test was asking the
     * database to do something the product must never do, and least privilege
     * is what said so.
     */
    expect(await settings.cryptoDailyLimitMinor('GBP')).toBeUndefined();
    expect(await settings.cryptoDailyLimitMinor('USDT')).toBeDefined();
  });
});

describe('conversions and gift cards', () => {
  it('refuses past the hourly conversion count', async () => {
    const user = await customer();
    await fund(user, money(100_000_00n, 'NGN' as Currency));

    expect(await move(user, 'fx', 'fx_trade', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
    expect(await move(user, 'fx', 'fx_trade', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
    expect(await move(user, 'fx', 'fx_trade', money(1_000_00n, 'NGN' as Currency))).toBe('too_many_transfers');
  });

  it('refuses past the hourly gift card count', async () => {
    const user = await customer();
    await fund(user, money(100_000_00n, 'NGN' as Currency));

    expect(await move(user, 'giftcard', 'giftcard_purchase', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
    expect(await move(user, 'giftcard', 'giftcard_purchase', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
    expect(await move(user, 'giftcard', 'giftcard_purchase', money(1_000_00n, 'NGN' as Currency)))
      .toBe('too_many_transfers');
  });

  it('counts each flow SEPARATELY', async () => {
    // A shared counter would mean a customer who converted twice could not sell
    // a gift card — three unrelated products sharing one ceiling, which is the
    // shape of limit people work around rather than respect.
    const user = await customer();
    await fund(user, money(100_000_00n, 'NGN' as Currency));

    expect(await move(user, 'fx', 'fx_trade', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
    expect(await move(user, 'fx', 'fx_trade', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
    expect(await move(user, 'fx', 'fx_trade', money(1_000_00n, 'NGN' as Currency))).toBe('too_many_transfers');

    // The gift card bucket is untouched.
    expect(await move(user, 'giftcard', 'giftcard_purchase', money(1_000_00n, 'NGN' as Currency))).toBeUndefined();
  });
});
