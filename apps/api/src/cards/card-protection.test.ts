import { describe, expect, it } from 'vitest';
import { CardProtectionService, classifyDecline } from './card-protection.service.js';

/**
 * The two pure functions in the protection path, which are where the subtle
 * failures live: everything else is SQL and is tested by the invariant suite
 * against a real database.
 */

describe('merchantKey', () => {
  const key = CardProtectionService.merchantKey;

  it('folds the case and padding a card network varies between the two events', () => {
    // The SAME charge arrives once as an authorization and again as a
    // settlement, and descriptors routinely differ in case and trailing
    // spaces between the two. A comparison that treated these as different
    // merchants would never see a duplicate.
    expect(key('AMZN Mktp US*2H4KL')).toBe(key('AMZN MKTP US*2H4KL'));
    expect(key('  amzn  mktp us*2h4kl ')).toBe(key('AMZN MKTP US*2H4KL'));
  });

  it('does not merge two genuinely different merchants', () => {
    expect(key('NETFLIX.COM')).not.toBe(key('SPOTIFY.COM'));
  });

  it('treats an absent or blank descriptor as undecidable, not as a match', () => {
    // This is the difference between "we cannot tell" and "they are the same".
    // If a blank descriptor normalised to a shared empty string, every
    // same-amount charge on a card would match every other one and the first
    // customer to top up twice would have their card frozen.
    expect(key(undefined)).toBeUndefined();
    expect(key('')).toBeUndefined();
    expect(key('   ')).toBeUndefined();
  });
});

describe('classifyDecline', () => {
  it('recognises the wordings a provider uses for no money', () => {
    for (const text of [
      'Insufficient funds',
      'INSUFFICIENT_FUNDS',
      'Card balance too low',
      'not enough balance',
      'NSF',
    ]) {
      expect(classifyDecline(text), text).toBe('insufficient_funds');
    }
  });

  it('does not guess insufficient funds from an unfamiliar message', () => {
    // The freeze that hangs off this classification is a real cost to a
    // customer. Defaulting an unrecognised message to insufficient_funds
    // would freeze every card at once during a provider incident, which is
    // precisely when customers most need their cards to work.
    expect(classifyDecline('Do not honour')).toBe('provider_declined');
    expect(classifyDecline('issuer unavailable')).toBe('provider_declined');
    expect(classifyDecline(undefined)).toBe('provider_declined');
    expect(classifyDecline('')).toBe('provider_declined');
  });

  it('separates a dead card and a limit from a lack of funds', () => {
    // All three are declines and all three count toward the burst threshold,
    // but only one of them means "add money and try again" — and only one of
    // them should trigger the subscription-cascade freeze.
    expect(classifyDecline('Card is frozen')).toBe('card_not_active');
    expect(classifyDecline('card suspended')).toBe('card_not_active');
    expect(classifyDecline('Velocity limit exceeded')).toBe('limit_exceeded');
  });

  it('is decided by our words, not the provider chosen ordering', () => {
    // A message mentioning both must not depend on which regex happens to be
    // written first for the customer-facing outcome to change. Funds win:
    // it is the one the customer can act on.
    expect(classifyDecline('insufficient funds, daily limit also reached')).toBe(
      'insufficient_funds',
    );
  });
});
