import { describe, expect, it } from 'vitest';
import { parseFlutterwaveEvent, verifyFlutterwaveWebhook } from './webhooks.js';

/**
 * Verifying a Flutterwave event, which is NOT a signature.
 *
 * They return, verbatim, the secret an operator set on their own dashboard.
 * Nothing about the body is covered by it — so these tests exist to pin two
 * things the adapters either side of this file would lead somebody to write
 * wrongly: that the check is an EQUALITY, and that an unset secret refuses.
 */
describe('the verif-hash header', () => {
  it('accepts the exact secret and nothing else', () => {
    expect(verifyFlutterwaveWebhook({ header: 's3cret', secretHash: 's3cret' })).toBe(true);
    expect(verifyFlutterwaveWebhook({ header: 's3crev', secretHash: 's3cret' })).toBe(false);
  });

  it('REFUSES when no secret is configured, rather than treating it as off', () => {
    /*
     * The alternative is an endpoint that credits wallets on anybody's say-so,
     * on the one deployment where somebody forgot a box. Failing closed costs
     * a support call; failing open costs the float.
     */
    expect(verifyFlutterwaveWebhook({ header: 'anything', secretHash: undefined })).toBe(false);
    expect(verifyFlutterwaveWebhook({ header: 'anything', secretHash: '' })).toBe(false);
  });

  it('refuses a missing header', () => {
    expect(verifyFlutterwaveWebhook({ header: undefined, secretHash: 's3cret' })).toBe(false);
    expect(verifyFlutterwaveWebhook({ header: '', secretHash: 's3cret' })).toBe(false);
  });

  it('refuses a length mismatch without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, and an escaping throw would
    // itself be a length oracle — as well as a 500 where a 401 belongs.
    expect(verifyFlutterwaveWebhook({ header: 'short', secretHash: 'muchlonger' })).toBe(false);
  });
});

describe('reading an event', () => {
  it('takes the reference from tx_ref on a charge', () => {
    const event = parseFlutterwaveEvent({
      event: 'charge.completed',
      data: { id: 1, tx_ref: 'xetpay-1', status: 'successful' },
    });
    expect(event?.reference).toBe('xetpay-1');
    expect(event?.kind).toBe('charge.completed');
  });

  it('takes it from `reference` on a transfer', () => {
    /*
     * A CHARGE NAMES IT `tx_ref` AND A TRANSFER NAMES IT `reference`, and both
     * are the string WE minted. Reading only one makes half the events
     * unresolvable — and an unresolvable event is not a loud failure, it is a
     * payment that silently never lands.
     */
    const event = parseFlutterwaveEvent({
      'event.type': 'Transfer',
      data: { id: 2, reference: 'xetpay-out-1', status: 'SUCCESSFUL' },
    });
    expect(event?.reference).toBe('xetpay-out-1');
  });

  it('answers undefined for a body that is not an event', () => {
    expect(parseFlutterwaveEvent('nope')).toBeUndefined();
    expect(parseFlutterwaveEvent(42)).toBeUndefined();
  });

  it('reads no amount at all', () => {
    /*
     * DELIBERATELY NARROW. Everything that decides money is read back from
     * `verify` rather than from an unsigned body, so this schema must not
     * carry an amount — a schema that parsed one is a schema somebody later
     * trusted.
     */
    const event = parseFlutterwaveEvent({
      event: 'charge.completed',
      data: { id: 1, tx_ref: 'x', amount: 999999, currency: 'GHS' },
    });
    expect(Object.keys(event ?? {}).sort()).toEqual(['kind', 'reference', 'status']);
  });
});
