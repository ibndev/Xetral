import { describe, expect, it } from 'vitest';
import { redactBvn, redactPan, redactPayload, redactSecret } from './redaction.js';

describe('identifiers keep a tail', () => {
  it('shows the last four of a card', () => {
    expect(redactPan('5399831234567890')).toBe('************7890');
    expect(redactPan('5399 8312 3456 7890')).toBe('************7890');
  });

  it('shows only three digits of a BVN', () => {
    // A BVN is a lifelong national identifier and cannot be reissued after a
    // leak the way a card can, so it gets less of a tail than a PAN.
    expect(redactBvn('22345678901')).toBe('********901');
  });

  it('masks entirely when the value is too short for a tail to be safe', () => {
    // A 5-digit value showing its last 4 is not redacted, it is printed.
    expect(redactPan('12345')).toBe('*****');
    expect(redactPan('')).toBe('*');
  });
});

describe('secrets are replaced whole', () => {
  it('never reveals a prefix', () => {
    // The mistake that looks identical to PAN redaction in review: eight
    // characters of a token are eight an attacker no longer has to guess, and
    // usually enough to correlate a log line with a session.
    const token = 'x7Qk2mN8pR4tV6wY0zB3cD5fG7hJ9kL1nP3qS5uW7yA';
    const redacted = redactSecret(token);

    expect(redacted).toBe('[redacted]');

    // Nothing recognisable from the token survives: no run of four characters
    // from anywhere in it appears in the output.
    for (let i = 0; i + 4 <= token.length; i++) {
      expect(redacted).not.toContain(token.slice(i, i + 4));
    }
  });
});

describe('payload scrubbing', () => {
  it('redacts secret-shaped keys anywhere in the structure', () => {
    const scrubbed = redactPayload({
      user: 'ada',
      password: 'hunter2',
      refresh_token: 'x7Qk2mN8pR4tV6wY',
      headers: { Authorization: 'Bearer abc.def.ghi' },
      provider: { apiKey: 'sk_live_123', webhook_secret: 'whsec_456' },
    }) as Record<string, unknown>;

    expect(scrubbed['user']).toBe('ada');
    expect(scrubbed['password']).toBe('[redacted]');
    expect(scrubbed['refresh_token']).toBe('[redacted]');
    expect(JSON.stringify(scrubbed)).not.toContain('hunter2');
    expect(JSON.stringify(scrubbed)).not.toContain('sk_live_123');
    expect(JSON.stringify(scrubbed)).not.toContain('Bearer');
  });

  it('matches keys regardless of casing or separator', () => {
    // Provider payloads are snake_case, our headers are kebab-case, our code is
    // camelCase. A matcher that only handles one of the three leaks the others.
    const scrubbed = redactPayload({
      'X-Refresh-Token': 'a',
      accessToken: 'b',
      CLIENT_SECRET: 'c',
    }) as Record<string, unknown>;

    expect(Object.values(scrubbed)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });

  it('keeps a tail on identifier-shaped keys, matching the named helpers', () => {
    const scrubbed = redactPayload({ pan: '5399831234567890', bvn: '22345678901' }) as Record<
      string,
      unknown
    >;
    // The scrubber and the named helpers must agree. Drift between them means
    // a BVN leaks an extra digit whenever it arrives inside a payload rather
    // than through redactBvn().
    expect(scrubbed['pan']).toBe(redactPan('5399831234567890'));
    expect(scrubbed['bvn']).toBe(redactBvn('22345678901'));
    expect(scrubbed['bvn']).toBe('********901');
  });

  it('prefers the stricter rule when a key matches both lists', () => {
    // `card_number_token` is a secret that happens to contain an identifier
    // word. Keeping a tail of it would be keeping a tail of a credential.
    const scrubbed = redactPayload({ card_number_token: 'tok_5399831234567890' }) as Record<
      string,
      unknown
    >;
    expect(scrubbed['card_number_token']).toBe('[redacted]');
  });

  it('scrubs inside arrays', () => {
    const scrubbed = redactPayload({
      cards: [{ pan: '5399831234567890', cvv: '123' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain('123"');
    expect(JSON.stringify(scrubbed)).toContain('7890');
  });

  it('survives a cycle rather than overflowing the stack', () => {
    // This runs on the error path, where the input is whatever a provider sent.
    // A crash inside the logger replaces a useful error with a useless one.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() => redactPayload(cyclic)).not.toThrow();
    expect(JSON.stringify(redactPayload(cyclic))).toContain('[circular]');
  });

  it('truncates rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(JSON.stringify(redactPayload(deep))).toContain('[truncated]');
  });

  it('leaves primitives and nulls alone', () => {
    expect(redactPayload(null)).toBe(null);
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload('plain')).toBe('plain');
  });
});
