import { describe, expect, it } from 'vitest';
import { sendableFor, TRANSFER_CURRENCIES } from './catalogues.js';

/**
 * What a customer is OFFERED when they send.
 *
 * This used to filter, and the filter was the feature: another country's
 * local currency is an option that answers `insufficient_funds`. What it also
 * did was make the ordinary cross-border case — a Nigerian sending somebody
 * cedis — unreachable from the Send screen, with no way to discover that
 * Convert comes first.
 *
 * So the list is complete now and the ORDER carries what the filter used to.
 * These assertions pin that, because "offers everything" is one edit away
 * from "offers everything in registry order", which puts a currency nobody
 * holds above the one their salary is in.
 */
describe('sendableFor', () => {
  it('offers every currency the API accepts, and nothing else', () => {
    expect([...sendableFor('NGN', ['NGN'])].sort()).toEqual([...TRANSFER_CURRENCIES].sort());
    // Including for somebody we cannot place, which is every account opened
    // before 040 added `users.country`.
    expect([...sendableFor(null)].sort()).toEqual([...TRANSFER_CURRENCIES].sort());
  });

  it('leads with the home currency', () => {
    expect(sendableFor('GHS', ['NGN'])[0]).toBe('GHS');
    expect(sendableFor('KES', [])[0]).toBe('KES');
  });

  it('puts a currency they hold above one they would have to convert into', () => {
    const offered = sendableFor('NGN', ['NGN', 'KES']);
    // KES is held; GHS is a local currency of a country they are not in and
    // hold none of, so it sorts below.
    expect(offered.indexOf('KES')).toBeLessThan(offered.indexOf('GHS'));
  });

  it('keeps the dollar and the stablecoins above an unheld local currency', () => {
    // They belong to no country and are what cross-border payment here is
    // made of, so they are never the bottom of the list.
    const offered = sendableFor('NGN', ['NGN']);
    for (const global of ['USD', 'USDT', 'USDC'] as const) {
      expect(offered.indexOf(global)).toBeLessThan(offered.indexOf('GHS'));
      expect(offered.indexOf(global)).toBeLessThan(offered.indexOf('KES'));
    }
  });

  it('is stable within a rank, so the picker does not reshuffle', () => {
    // Two currencies of equal rank keep the catalogue's own order. Without
    // this the list would depend on the sort's stability rather than on a
    // decision, and a customer would see it reorder between loads.
    expect(sendableFor('NGN', ['NGN'])).toEqual(sendableFor('NGN', ['NGN']));
    const offered = sendableFor('NGN', ['NGN']);
    expect(offered.indexOf('USD')).toBeLessThan(offered.indexOf('USDT'));
    expect(offered.indexOf('USDT')).toBeLessThan(offered.indexOf('USDC'));
  });
});
