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

describe('reversals', () => {
  it('corrects a mistake by appending, never by editing', async () => {
    // The ledger is append-only. A wrong entry stays, and a reversing entry
    // points at it -- which is what an auditor wants to see, and what an
    // UPDATE would destroy.
    const before = await spendable(alice);

    const mistake = await ledger.post(
      intent({
        description: 'charged the wrong customer',
        postings: [posting(wallet(alice), ngn(-250_00)), posting(wallet(bob), ngn(250_00))],
      }),
    );

    const reversal = await ledger.post(
      intent({
        kind: 'reversal',
        reversesEntryId: mistake.entryId,
        description: 'reversing the wrong charge',
        postings: [posting(wallet(bob), ngn(-250_00)), posting(wallet(alice), ngn(250_00))],
      }),
    );

    expect(reversal.entryId).not.toBe(mistake.entryId);
    expect(await spendable(alice)).toBe(before);

    // Both entries survive, and the second names the first.
    const rows = await pool.query<{ reverses_id: string | null }>(
      `SELECT reverses_id FROM journal_entries WHERE id = $1`,
      [reversal.entryId],
    );
    expect(rows.rows[0]?.reverses_id).toBe(mistake.entryId);
  });

  it('refuses a reversal that names no entry', async () => {
    await expect(
      ledger.post(
        intent({
          kind: 'reversal',
          postings: [posting(wallet(alice), ngn(-100)), posting(wallet(bob), ngn(100))],
        }),
      ),
    ).rejects.toThrow(/names no entry it acts upon/);
  });

  it('refuses a non-reversal that names one', async () => {
    // The database has the same CHECK. Catching it here names the code that
    // built the entry instead of surfacing a constraint violation.
    await expect(
      ledger.post(
        intent({
          kind: 'wallet_transfer',
          reversesEntryId: '1',
          postings: [posting(wallet(alice), ngn(-100)), posting(wallet(bob), ngn(100))],
        }),
      ),
    ).rejects.toThrow(/names an entry to act upon but is kind/);
  });

  it('refuses to reverse an entry that does not exist', async () => {
    // A self-referencing foreign key, so a reversal cannot point into thin air.
    await expect(
      ledger.post(
        intent({
          kind: 'reversal',
          reversesEntryId: '999999999',
          postings: [posting(wallet(alice), ngn(-100)), posting(wallet(bob), ngn(100))],
        }),
      ),
    ).rejects.toThrow();
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
    //
    // Asserted with a distinctive amount rather than "every entry is positive":
    // that weaker claim held only because nothing had ever sent money the other
    // way, and it broke the moment a reversal did.
    const marker = 7_531_00;
    await ledger.post(
      intent({
        description: 'one-way marker transfer',
        postings: [posting(wallet(alice), ngn(-marker)), posting(wallet(bob), ngn(marker))],
      }),
    );

    const senderSide = await ledger.history(alice, 'NGN', { limit: 200 });
    const recipientSide = await ledger.history(bob, 'NGN', { limit: 200 });

    expect(senderSide.some((h) => h.amountMinor === BigInt(-marker))).toBe(true);
    expect(senderSide.some((h) => h.amountMinor === BigInt(marker))).toBe(false);

    expect(recipientSide.some((h) => h.amountMinor === BigInt(marker))).toBe(true);
    expect(recipientSide.some((h) => h.amountMinor === BigInt(-marker))).toBe(false);
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

/*
 * ONLY THE DATABASE CAN CHECK THIS.
 *
 * `AccountRef` is a literal union in TypeScript and `account_kind` is an enum
 * in Postgres, and nothing but an insert proves the two still agree. Phase 3
 * recorded exactly this for `EntryKind`, and `liability_tax_payable` — added
 * when tax stopped being booked as revenue — is a second instance of the same
 * shape: it typechecked, and would have failed on the first real transfer.
 *
 * The list is exhaustive BY THE COMPILER, and a `length: 12` assertion would
 * not be: a twelve-element array of a thirteen-member union typechecks
 * perfectly, so adding a kind and forgetting this file would leave the test
 * green while covering less. A `Record` keyed on the union has to name every
 * member, and the keys are read back off it.
 */
const EVERY_KIND = Object.keys({
  customer_wallet: true,
  customer_card: true,
  customer_pending: true,
  revenue_fees: true,
  revenue_fx_spread: true,
  expense_provider_cost: true,
  expense_dispute_loss: true,
  provider_float: true,
  asset_giftcard_inventory: true,
  liability_customer_funds: true,
  liability_tax_payable: true,
  suspense: true,
} satisfies Record<AccountRef['kind'], true>) as readonly AccountRef['kind'][];

describe('the account kinds TypeScript declares', () => {
  it.each(EVERY_KIND)('%s exists in the database enum', async (kind) => {
    const found = await pool.query(
      `SELECT 1 FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'account_kind' AND e.enumlabel = $1`,
      [kind],
    );
    expect(found.rowCount).toBe(1);
  });
});
