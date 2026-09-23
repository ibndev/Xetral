import { describe, expect, it } from 'vitest';
import { cryptoPortfolio } from './portfolio.js';

const line = (currency: string, amount_minor: string) => ({ currency, held: '0', amount: '0', amount_minor });

describe('cryptoPortfolio', () => {
  it('sums the API’s own dollar lines for crypto only', () => {
    const p = cryptoPortfolio(
      { lines: [line('USD', '323250'), line('USDT', '1500'), line('USDC', '250')] },
      [
        { currency: 'USD', spendable: '3232.50' },
        { currency: 'USDT', spendable: '15.000000' },
        { currency: 'USDC', spendable: '2.500000' },
      ],
    );
    expect(p.totalMinor).toBe('1750');
    expect(p.largest).toBe('USDT');
    expect(p.unpriced).toEqual([]);
  });

  it('names a held asset with no price and leaves it out of the total', () => {
    const p = cryptoPortfolio({ lines: [line('USDT', '1500')] }, [
      { currency: 'BTC', spendable: '0.01000000' },
      { currency: 'USDT', spendable: '15.000000' },
    ]);
    expect(p.totalMinor).toBe('1500');
    expect(p.unpriced).toEqual(['BTC']);
    expect(p.rows.find((r) => r.asset === 'BTC')?.valueMinor).toBeUndefined();
  });

  it('shows every asset, an empty one valued at zero rather than unpriced', () => {
    const p = cryptoPortfolio({ lines: [] }, []);
    expect(p.rows.map((r) => r.asset)).toEqual(['BTC', 'USDT', 'USDC']);
    expect(p.rows.every((r) => r.empty && r.valueMinor === '0')).toBe(true);
    expect(p.unpriced).toEqual([]);
    expect(p.largest).toBeUndefined();
  });

  it('degrades on an API older than the lines', () => {
    const p = cryptoPortfolio({}, [{ currency: 'USDT', spendable: '1.000000' }]);
    expect(p.totalMinor).toBe('0');
    expect(p.unpriced).toEqual(['USDT']);
  });
});
