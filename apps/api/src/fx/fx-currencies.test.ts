import { describe, expect, it } from 'vitest';
import { CURRENCIES } from '@xetral/shared';
import { TRANSFER_CURRENCIES } from '@xetral/client';
import { fxQuoteSchema, convertSchema, remitSchema } from './dto.js';

/*
 * THE BUG THIS EXISTS FOR. `CONVERTIBLE` in `dto.ts` was a hand-written list
 * of five currencies and had been left behind by three migrations: GHS and
 * KES arrived with Ghana and Kenya, USDC with 038, CAD with 055. So a quote
 * for NGN→GHS was refused as `invalid_request` on the field `to` — before any
 * price was read — and the Send screen said "We cannot convert NGN to GHS
 * yet" however carefully an operator had published the spread and the rate.
 *
 * A list that has to be edited by hand when a currency is added is a list
 * that will be forgotten again, so it is now derived and this is what holds
 * it there.
 */
describe('the FX routes accept every currency this system knows', () => {
  const known = Object.keys(CURRENCIES).sort();

  it('found the registry at all', () => {
    // Guards the test. If this import stopped resolving, every assertion
    // below would compare two empty lists and pass.
    expect(known.length).toBeGreaterThan(5);
    expect(known).toContain('GHS');
    expect(known).toContain('KES');
  });

  it('parses a quote in EVERY registered currency, in both directions', () => {
    for (const currency of known) {
      const asSource = fxQuoteSchema.safeParse({ from: currency, to: 'NGN', amount: '1' });
      const asTarget = fxQuoteSchema.safeParse({ from: 'NGN', to: currency, amount: '1' });
      // Same currency both sides is refused by the SERVICE, not the schema —
      // so only a currency the schema does not know can fail here.
      if (currency !== 'NGN') {
        expect(asSource.success, `${currency} as the source`).toBe(true);
        expect(asTarget.success, `${currency} as the target`).toBe(true);
      }
    }
  });

  it('accepts NGN to GHS, which is the pair that was reported', () => {
    // Named on its own so a regression points at the report rather than at a
    // loop. This must be a SCHEMA pass: whether the pair is tradeable is
    // `fx_spread_policies`' answer and arrives as `pair_not_supported`.
    expect(fxQuoteSchema.safeParse({ from: 'NGN', to: 'GHS', amount: '5000' }).success).toBe(
      true,
    );
    expect(fxQuoteSchema.safeParse({ from: 'GHS', to: 'NGN', amount: '5000' }).success).toBe(
      true,
    );
  });

  it('accepts on convert and remit too, not only on the quote', () => {
    // Three schemas share one list. A quote that parses and a convert that
    // does not is a rate a customer can see and an action they cannot take.
    expect(
      convertSchema.safeParse({
        from: 'NGN',
        to: 'GHS',
        amount: '5000',
        idempotency_key: 'convert-ngn-ghs-1',
      }).success,
    ).toBe(true);
    expect(
      remitSchema.safeParse({
        from: 'NGN',
        to: 'GHS',
        amount: '5000',
        idempotency_key: 'remit-ngn-ghs-1',
        recipient: '+233244123456',
        transaction_pin: '482193',
      }).success,
    ).toBe(true);
  });

  it('still refuses something that is not a currency at all', () => {
    // The list widened; it did not stop being a list. A code the money
    // primitives do not know has no exponent, which is every amount in it
    // wrong by a power of ten.
    expect(fxQuoteSchema.safeParse({ from: 'NGN', to: 'XXX', amount: '1' }).success).toBe(false);
    expect(fxQuoteSchema.safeParse({ from: 'ngn', to: 'GHS', amount: '1' }).success).toBe(false);
  });

  it('accepts everything the client offers a customer to send', () => {
    /*
     * THE OTHER DIRECTION, and it is the one that produced the report. A
     * currency the client puts in a picker and the API refuses is a form that
     * 400s on a field the customer filled in correctly — the failure the
     * `TRON` casing bug produced, and the one this screen produced for GHS.
     */
    for (const currency of TRANSFER_CURRENCIES) {
      if (currency === 'NGN') continue;
      expect(
        fxQuoteSchema.safeParse({ from: 'NGN', to: currency, amount: '1' }).success,
        `the client offers ${currency}`,
      ).toBe(true);
    }
  });
});
