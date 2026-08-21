import { describe, expect, it } from 'vitest';
import { money, ngn, usd } from '@xetral/shared';
import {
  UnbalancedIntentError,
  assertBalanced,
  posting,
} from './intent.js';
import type { AccountRef, LedgerIntent, PostingIntent } from './intent.js';

const wallet: AccountRef = { kind: 'customer_wallet', ownerId: 'u1', currency: 'NGN' };
const usdWallet: AccountRef = { kind: 'customer_wallet', ownerId: 'u1', currency: 'USD' };
const floatNgn: AccountRef = { kind: 'provider_float', currency: 'NGN' };
const floatUsd: AccountRef = { kind: 'provider_float', currency: 'USD' };
const spread: AccountRef = { kind: 'revenue_fx_spread', currency: 'USD' };

const intent = (postings: readonly PostingIntent[]): LedgerIntent => ({
  idempotencyKey: 'bitnob:evt_1',
  kind: 'fx_trade',
  occurredAt: new Date('2026-08-19T10:00:00Z'),
  description: 'test',
  postings,
  metadata: {},
});

describe('building a leg', () => {
  it('carries the amount and currency across together', () => {
    const leg = posting(wallet, ngn(-505_000));
    expect(leg.amountMinor).toBe(-505_000n);
    expect(leg.currency).toBe('NGN');
    expect(leg.account).toBe(wallet);
  });

  it('refuses an amount whose currency is not the account currency', () => {
    // The mistake a hand-written object literal makes easy: USD cents in an
    // NGN account. The database rejects this too, but by then the error is a
    // constraint violation several layers from whoever built it.
    expect(() => posting(wallet, usd(2500))).toThrow(UnbalancedIntentError);
  });
});

describe('balance checking', () => {
  it('accepts a balanced single-currency entry', () => {
    expect(() =>
      assertBalanced(intent([posting(wallet, ngn(-500_000)), posting(floatNgn, ngn(500_000))])),
    ).not.toThrow();
  });

  it('accepts an FX trade that balances in each currency separately', () => {
    // Sell N1,650,000 for $1,000 at 1650 with a 1% spread. Both legs are zero
    // on their own.
    expect(() =>
      assertBalanced(
        intent([
          posting(wallet, ngn(-165_000_000)),
          posting(floatNgn, ngn(165_000_000)),
          posting(floatUsd, usd(-100_000)),
          posting(usdWallet, usd(99_000)),
          posting(spread, usd(1_000)),
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an entry that is short in one currency', () => {
    // The spread was taken from the customer but never posted to revenue, so
    // the USD leg is 1000 short. Same shape as test 4 in 001_ledger.test.sql.
    expect(() =>
      assertBalanced(
        intent([
          posting(wallet, ngn(-165_000_000)),
          posting(floatNgn, ngn(165_000_000)),
          posting(floatUsd, usd(-100_000)),
          posting(usdWallet, usd(99_000)),
        ]),
      ),
    ).toThrow(/USD postings sum to -1000/);
  });

  it('rejects two errors in different currencies that cancel each other out', () => {
    // The case that justifies checking PER CURRENCY, and the mirror of test 4a
    // in 001_ledger.test.sql. The NGN leg is over by 1000 kobo and the USD leg
    // under by 1000 cents; added as raw integers they cancel exactly, so a
    // whole-entry sum sees zero and lets through an entry in which BOTH legs
    // are wrong. Kobo and cents are not commensurable.
    const postings = [
      posting(wallet, ngn(-1_650_000)),
      posting(floatNgn, ngn(1_651_000)),
      posting(floatUsd, usd(-1_000)),
      posting(usdWallet, usd(1_000)),
      posting(floatUsd, usd(-1_000)),
    ];

    const wholeEntrySum = postings.reduce((total, p) => total + p.amountMinor, 0n);
    expect(wholeEntrySum).toBe(0n); // a naive check would pass this

    expect(() => assertBalanced(intent(postings))).toThrow(UnbalancedIntentError);
  });

  it('rejects a zero-amount posting', () => {
    // Carries no information, and would let an entry balance trivially with no
    // money moving. The ledger has the same CHECK.
    expect(() =>
      assertBalanced(intent([posting(wallet, ngn(0)), posting(floatNgn, ngn(0))])),
    ).toThrow(/zero-amount/);
  });

  it('rejects an entry with fewer than two postings', () => {
    expect(() => assertBalanced(intent([posting(wallet, ngn(100))]))).toThrow(/at least 2/);
    expect(() => assertBalanced(intent([]))).toThrow(/at least 2/);
  });

  it('names the entry in the error, so a bad mapping is traceable', () => {
    // The whole reason for duplicating the database's check here: at COMMIT
    // the failure is a transaction abort with no idea which adapter built it.
    expect(() =>
      assertBalanced(intent([posting(wallet, ngn(1)), posting(floatNgn, ngn(2))])),
    ).toThrow(/bitnob:evt_1/);
  });

  it('handles a currency whose exponent is not 2', () => {
    // JPY has none. Nothing here may assume cents.
    const jpyWallet: AccountRef = { kind: 'customer_wallet', ownerId: 'u1', currency: 'JPY' };
    const jpyFloat: AccountRef = { kind: 'provider_float', currency: 'JPY' };
    expect(() =>
      assertBalanced(
        intent([
          posting(jpyWallet, money(-100n, 'JPY')),
          posting(jpyFloat, money(100n, 'JPY')),
        ]),
      ),
    ).not.toThrow();
  });
});
