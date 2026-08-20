import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { money, ngn, subtract, usd } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from './ledger-service.js';
import { InsufficientFundsError, InvalidEntryError } from './errors.js';
import { posting } from './intent.js';
import type { AccountRef, LedgerIntent } from './intent.js';

/**
 * The ledger service against the real schema.
 *
 * There is deliberately no unit suite with a mocked database. Everything this
 * service does that is worth testing — the overdraft guard, the replay
 * constraint, the deferred balance check — is enforced by Postgres, so a mock
 * would only assert that the author's idea of those rules matches itself.
 *
 * Requires DATABASE_URL with 001_ledger.sql applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the ledger e2e suite needs DATABASE_URL with 001_ledger.sql applied');
}

let pool: pg.Pool;
let ledger: LedgerService;
let alice: string;
let bob: string;

const wallet = (owner: string, currency: Currency = 'NGN'): AccountRef => ({
  kind: 'customer_wallet',
  ownerId: owner,
  currency,
});
const float = (currency: Currency = 'NGN'): AccountRef => ({ kind: 'provider_float', currency });
const fees = (currency: Currency = 'NGN'): AccountRef => ({ kind: 'revenue_fees', currency });

function intent(overrides: Partial<LedgerIntent> = {}): LedgerIntent {
  return {
    idempotencyKey: `test:${randomUUID()}`,
    kind: 'wallet_transfer',
    occurredAt: new Date('2026-08-20T10:00:00Z'),
    description: 'test entry',
    metadata: {},
    postings: [],
    ...overrides,
  };
}

/**
 * Generic over the currency, and it has to be: `Money` is invariant, so a
 * ternary yielding `Money<'NGN'> | Money<'USD'>` is NOT assignable to
 * `Money<'NGN' | 'USD'>`. The type parameter keeps one currency throughout.
 */
async function fund<C extends Currency>(
  owner: string,
  minor: number,
  currency: C = 'NGN' as C,
): Promise<void> {
  const amount = money(minor, currency);
  await ledger.post(
    intent({
      kind: 'wallet_funding',
      description: 'opening balance',
      postings: [
        posting(wallet(owner, currency), amount),
        posting(float(currency), negate(amount)),
      ],
    }),
  );
}

function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return subtract({ amount: 0n, currency: amount.currency }, amount);
}

const spendable = async (owner: string, currency: Currency = 'NGN'): Promise<bigint> =>
  (await ledger.balanceOf(wallet(owner, currency)))?.balanceMinor ?? 0n;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  ledger = new LedgerService(pool);

  // Owner ids from a high synthetic range, NOT MAX(owner_id) + 1.
  //
  // accounts.owner_id has no foreign key -- it is polymorphic -- so this suite
  // can invent owners. But the api suite creates REAL users whose ids come from
  // the users sequence, and both suites share one database in CI. Taking the
  // next id after the current maximum eventually lands on an id the sequence
  // will hand out, and then a customer's "empty wallet" already has a balance.
  const base = 9_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)) * 10n;
  alice = String(base);
  bob = String(base + 1n);

  await fund(alice, 20_000_00);
});

afterAll(async () => {
  await pool?.end();
});

describe('posting an entry', () => {
  it('creates accounts on demand and moves the balance', async () => {
    // Neither account existed before this call. Resolving a role to an account
    // is the ledger's job precisely so no caller has to know the account tree.
    const before = await spendable(alice);

    const result = await ledger.post(
      intent({
        description: 'transfer to bob',
        postings: [posting(wallet(alice), ngn(-5_000_00)), posting(wallet(bob), ngn(5_000_00))],
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.entryUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await spendable(alice)).toBe(before - 500_000n);
    expect(await spendable(bob)).toBe(500_000n);
  });

  it('writes a fee leg in the same entry', async () => {
    // The shape from ledger test 1: the sender pays amount + fee, the recipient
    // receives amount, revenue takes the difference. One entry, so the three
    // legs cannot be committed apart from each other.
    const before = await spendable(alice);
    // revenue_fees is a PLATFORM account: one row per currency, no owner, and
    // therefore shared with every other run against this database. Assert the
    // delta rather than an absolute, or the test passes exactly once.
    const feesBefore = (await ledger.balanceOf(fees()))?.balanceMinor ?? 0n;

    await ledger.post(
      intent({
        description: 'transfer with fee',
        postings: [
          posting(wallet(alice), ngn(-5_050_00)),
          posting(wallet(bob), ngn(5_000_00)),
          posting(fees(), ngn(50_00)),
        ],
      }),
    );

    expect(await spendable(alice)).toBe(before - 505_000n);
    expect((await ledger.balanceOf(fees()))?.balanceMinor).toBe(feesBefore + 5_000n);
  });
});

describe('replay', () => {
  it('returns the existing entry instead of writing a second one', async () => {
    // A replay is a SUCCESS. A webhook handler that treats the second delivery
    // as a failure keeps failing, and the provider keeps retrying, for ever.
    const key = `test:replay-${randomUUID()}`;
    const legs = [posting(wallet(alice), ngn(-100_00)), posting(wallet(bob), ngn(100_00))];

    const first = await ledger.post(intent({ idempotencyKey: key, postings: legs }));
    const balanceAfterFirst = await spendable(alice);

    const second = await ledger.post(intent({ idempotencyKey: key, postings: legs }));

    expect(second.replayed).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    expect(second.entryUuid).toBe(first.entryUuid);
    // The thing that actually matters to the customer.
    expect(await spendable(alice)).toBe(balanceAfterFirst);
  });

  it('does not confuse two different events with each other', async () => {
    const a = await ledger.post(
      intent({ postings: [posting(wallet(alice), ngn(-1_00)), posting(wallet(bob), ngn(1_00))] }),
    );
    const b = await ledger.post(
      intent({ postings: [posting(wallet(alice), ngn(-1_00)), posting(wallet(bob), ngn(1_00))] }),
    );
    expect(b.entryId).not.toBe(a.entryId);
    expect(b.replayed).toBe(false);
  });
});

describe('what the database refuses', () => {
  it('rejects an overdraft as insufficient funds', async () => {
    // Balanced, legal double-entry, and still an unsecured loan nobody agreed
    // to make. The guard is in the database because the race is in the service.
    await expect(
      ledger.post(
        intent({
          kind: 'wallet_withdrawal',
          postings: [
            posting(wallet(bob), ngn(-999_999_00)),
            posting(float(), ngn(999_999_00)),
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('does not leak the balance in the insufficient-funds error', async () => {
    // Returning "you have N4,300" to a caller that asked to send N5,000 turns a
    // transfer endpoint into a balance oracle for a stolen session.
    await expect(
      ledger.post(
        intent({
          postings: [
            posting(wallet(bob), ngn(-999_999_00)),
            posting(float(), ngn(999_999_00)),
          ],
        }),
      ),
    ).rejects.toThrow(/^insufficient funds$/);
  });

  it('rejects an unbalanced entry before it reaches the database', async () => {
    await expect(
      ledger.post(
        intent({ postings: [posting(wallet(alice), ngn(-100)), posting(wallet(bob), ngn(200))] }),
      ),
    ).rejects.toBeInstanceOf(InvalidEntryError);
  });

  it('rejects two errors in different currencies that cancel out', async () => {
    // The masking case from ledger test 4a: added as raw integers these sum to
    // zero, so a whole-entry check would let both wrong legs through.
    await expect(
      ledger.post(
        intent({
          kind: 'fx_trade',
          postings: [
            posting(wallet(alice), ngn(-1_650_000)),
            posting(float('NGN'), ngn(1_651_000)),
            posting(float('USD'), usd(-1_000)),
            posting(wallet(alice, 'USD'), usd(1_000)),
            posting(float('USD'), usd(-1_000)),
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidEntryError);
  });

  it('rolls the whole entry back when the database refuses one leg', async () => {
    // Atomicity is the point of doing this in one transaction. A partially
    // written entry is money that exists on one side only.
    //
    // The entry below is balanced and passes every check this service makes,
    // so it genuinely reaches Postgres — and is refused there by the overdraft
    // guard. An earlier version of this test used a zero-amount leg, which
    // assertBalanced rejects before any SQL runs, and so proved nothing.
    const aliceBefore = await spendable(alice);
    const bobBefore = await spendable(bob);
    const feesBefore = (await ledger.balanceOf(fees()))?.balanceMinor ?? 0n;

    await expect(
      ledger.post(
        intent({
          postings: [
            posting(wallet(alice), ngn(-999_999_00)),
            posting(wallet(bob), ngn(999_899_00)),
            posting(fees(), ngn(100_00)),
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    // Not one of the three legs survived.
    expect(await spendable(alice)).toBe(aliceBefore);
    expect(await spendable(bob)).toBe(bobBefore);
    expect((await ledger.balanceOf(fees()))?.balanceMinor).toBe(feesBefore);
  });

});

describe('reading balances', () => {
  it('reports spendable, pending and total separately', async () => {
    // The customer's SPENDABLE balance is the wallet; their TOTAL is wallet
    // plus pending. Collapsing the two is how a card authorization either
    // double-counts or lets the money be spent twice.
    await ledger.post(
      intent({
        kind: 'card_authorization',
        postings: [
          posting(wallet(alice, 'USD'), usd(-25_00)),
          posting({ kind: 'customer_pending', ownerId: alice, currency: 'USD' }, usd(25_00)),
        ],
      }),
    ).catch(() => undefined); // needs USD funding first; funded below instead

    await fund(alice, 100_00, 'USD');
    const walletBefore = await spendable(alice, 'USD');

    await ledger.post(
      intent({
        kind: 'card_authorization',
        postings: [
          posting(wallet(alice, 'USD'), usd(-25_00)),
          posting({ kind: 'customer_pending', ownerId: alice, currency: 'USD' }, usd(25_00)),
        ],
      }),
    );

    const balances = await ledger.walletBalances(alice);
    const usdBalance = balances.find((b) => b.currency === 'USD');

    expect(usdBalance?.spendableMinor).toBe(walletBefore - 2500n);
    expect(usdBalance?.pendingMinor).toBe(2500n);
    expect(usdBalance?.totalMinor).toBe(walletBefore);
  });

  it('returns one row per currency the customer holds', async () => {
    const balances = await ledger.walletBalances(alice);
    expect(balances.map((b) => b.currency).sort()).toEqual(['NGN', 'USD']);
  });

  it('returns nothing for a customer with no accounts', async () => {
    expect(await ledger.walletBalances('999999999')).toEqual([]);
  });
});

describe('history', () => {
  it("shows only the customer's own leg", async () => {
    // A transfer is -N5,050 to the sender and +N5,000 to the recipient. Neither
    // wants to see the other's side, or the fee leg.
    const history = await ledger.history(bob, 'NGN');
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((h) => h.amountMinor > 0n)).toBe(true);
  });

  it('is newest first and paginates without an offset', async () => {
    const firstPage = await ledger.history(alice, 'NGN', { limit: 2 });
    expect(firstPage).toHaveLength(2);

    const cursor = firstPage[1]?.postingId;
    const secondPage = await ledger.history(alice, 'NGN', {
      limit: 2,
      ...(cursor === undefined ? {} : { before: cursor }),
    });

    // No overlap: an OFFSET would re-serve rows whenever a new entry lands
    // between the two calls.
    const firstIds = firstPage.map((h) => h.postingId);
    expect(secondPage.every((h) => !firstIds.includes(h.postingId))).toBe(true);
    expect(BigInt(secondPage[0]?.postingId ?? '0')).toBeLessThan(BigInt(cursor ?? '0'));
  });

  it('separates currencies', async () => {
    const ngnHistory = await ledger.history(alice, 'NGN');
    expect(ngnHistory.every((h) => h.currency === 'NGN')).toBe(true);
  });
});

describe('reconciliation', () => {
  it('leaves no drift between materialised balances and postings', async () => {
    const drift = await pool.query(`SELECT COUNT(*)::int AS n FROM ledger_drift`);
    expect(drift.rows[0]?.n).toBe(0);
  });
});
