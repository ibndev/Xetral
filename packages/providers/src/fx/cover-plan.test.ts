import { describe, expect, it } from 'vitest';
import { cascadeOrder, leastToDeliver, planCover } from './cover-plan.js';
import type { CoverSource } from './cover-plan.js';
import { convertWithSpread } from './rate-math.js';
import type { FxRate } from '../ports/fx.js';
import { money } from '@xetral/shared';

const far = new Date('2030-01-01');
/** ₦1,650 per dollar: 100 cents per 165,000 kobo. */
const NGN_USD: FxRate = { base: 'NGN', quote: 'USD', numerator: 100n, denominator: 165_000n, expiresAt: far };
/** ₵15 per dollar. */
const GHS_USD: FxRate = { base: 'GHS', quote: 'USD', numerator: 100n, denominator: 1_500n, expiresAt: far };
/** 1 USDT = $1: one cent per 10,000 micro-USDT. */
const USDT_USD: FxRate = { base: 'USDT', quote: 'USD', numerator: 1n, denominator: 10_000n, expiresAt: far };

const ngn = (spendable: bigint, spread = 150, min = 0n): CoverSource => ({
  currency: 'NGN',
  spendableMinor: spendable,
  pricing: { rate: NGN_USD, spreadBasisPoints: spread, minBaseMinor: min },
});
const usd = (spendable: bigint): CoverSource => ({ currency: 'USD', spendableMinor: spendable });

describe('the wallet in the card currency comes first', () => {
  it('pays entirely from dollars when dollars cover it, and converts nothing', () => {
    const plan = planCover(2_500n, 'USD', [usd(10_000n), ngn(10_000_000n)]);
    expect(plan).toEqual({
      covered: true,
      surplusMinor: 0n,
      legs: [expect.objectContaining({ currency: 'USD', debitMinor: 2_500n, converted: false, spreadBasisPoints: 0 })],
    });
  });

  it('takes what dollars there are, then converts ONLY the shortfall', () => {
    const plan = planCover(2_500n, 'USD', [usd(1_000n), ngn(10_000_000n)]);
    if (!plan.covered) throw new Error('expected a plan');
    expect(plan.legs.map((l) => l.currency)).toEqual(['USD', 'NGN']);
    const naira = plan.legs[1]!;
    // $15.00 short. Converting exactly what the plan takes must deliver it.
    expect(naira.deliversMinor).toBeGreaterThanOrEqual(1_500n);
    expect(convertWithSpread(money(naira.debitMinor, 'NGN'), NGN_USD, 150).quoteMinor).toBe(naira.deliversMinor);
    // And one kobo less would not have: the fee is paid on nothing extra.
    expect(convertWithSpread(money(naira.debitMinor - 1n, 'NGN'), NGN_USD, 150).quoteMinor).toBeLessThan(1_500n);
  });
});

describe('the cascade', () => {
  it('moves on to the next wallet when one is not enough, converting all of the first', () => {
    const plan = planCover(10_000n, 'USD', [
      usd(0n),
      ngn(16_500_000n), // ₦165,000 ≈ $98.50 after 1.5%
      { currency: 'USDT', spendableMinor: 50_000_000n, pricing: { rate: USDT_USD, spreadBasisPoints: 0, minBaseMinor: 0n } },
    ]);
    if (!plan.covered) throw new Error('expected a plan');
    expect(plan.legs.map((l) => l.currency)).toEqual(['NGN', 'USDT']);
    expect(plan.legs[0]!.debitMinor).toBe(16_500_000n);
    const total = plan.legs.reduce((a, l) => a + l.deliversMinor, 0n);
    expect(total).toBe(10_000n + plan.surplusMinor);
  });

  it('never touches a wallet after the need is met', () => {
    const plan = planCover(500n, 'USD', [usd(500n), ngn(10_000_000n)]);
    if (!plan.covered) throw new Error('expected a plan');
    expect(plan.legs).toHaveLength(1);
  });

  it('skips a pair nobody has priced rather than guessing', () => {
    const plan = planCover(500n, 'USD', [usd(0n), { currency: 'KES', spendableMinor: 10_000_000n }, ngn(10_000_000n)]);
    if (!plan.covered) throw new Error('expected a plan');
    expect(plan.legs.map((l) => l.currency)).toEqual(['NGN']);
  });

  it('says it cannot cover, and names no figure, when everything together is short', () => {
    expect(planCover(1_000_000n, 'USD', [usd(100n), ngn(1_000n)])).toEqual({ covered: false });
  });

  it('meets a pair minimum above the shortfall, and the surplus stays the customer’s', () => {
    // Owed $1.00; the NGN→USD minimum is ₦5,000.
    const plan = planCover(100n, 'USD', [usd(0n), ngn(10_000_000n, 150, 500_000n)]);
    if (!plan.covered) throw new Error('expected a plan');
    expect(plan.legs[0]!.debitMinor).toBe(500_000n);
    expect(plan.surplusMinor).toBe(plan.legs[0]!.deliversMinor - 100n);
  });

  it('skips a wallet that cannot reach the pair minimum at all', () => {
    const plan = planCover(100n, 'USD', [
      usd(0n),
      ngn(1_000n, 150, 500_000n),
      { currency: 'GHS', spendableMinor: 100_000n, pricing: { rate: GHS_USD, spreadBasisPoints: 200, minBaseMinor: 0n } },
    ]);
    if (!plan.covered) throw new Error('expected a plan');
    expect(plan.legs.map((l) => l.currency)).toEqual(['GHS']);
  });

  it('refuses a source priced with the wrong pair', () => {
    expect(() =>
      planCover(100n, 'USD', [{ currency: 'GHS', spendableMinor: 10n ** 9n, pricing: { rate: NGN_USD, spreadBasisPoints: 0, minBaseMinor: 0n } }]),
    ).toThrow(RangeError);
  });
});

describe('the least amount that delivers', () => {
  it('is exact across exponents: 6-decimal USDT into 2-decimal dollars', () => {
    expect(leastToDeliver(1_234n, 'USDT', { rate: USDT_USD, spreadBasisPoints: 0 })).toBe(12_340_000n);
  });

  it('is minimal for every target in a range, with a spread', () => {
    for (let t = 1n; t <= 300n; t += 1n) {
      const b = leastToDeliver(t, 'NGN', { rate: NGN_USD, spreadBasisPoints: 175 })!;
      expect(convertWithSpread(money(b, 'NGN'), NGN_USD, 175).quoteMinor).toBeGreaterThanOrEqual(t);
      if (b > 1n) {
        let less = 0n;
        try {
          less = convertWithSpread(money(b - 1n, 'NGN'), NGN_USD, 175).quoteMinor;
        } catch {
          less = 0n;
        }
        expect(less).toBeLessThan(t);
      }
    }
  });
});

describe('the order', () => {
  it('is the card currency, then the base currency, then the platform order', () => {
    expect(cascadeOrder('USD', 'GHS').slice(0, 4)).toEqual(['USD', 'GHS', 'USDT', 'USDC']);
    expect(cascadeOrder('USD', 'USD')[0]).toBe('USD');
    expect(new Set(cascadeOrder('USD', 'NGN')).size).toBe(cascadeOrder('USD', 'NGN').length);
    expect(cascadeOrder('USD', undefined).at(-1)).toBe('BTC');
  });
});
