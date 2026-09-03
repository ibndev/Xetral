import { describe, expect, it } from 'vitest';

import { nonce, sign, signedHeaders, stringToSign, unixSeconds } from './signing.js';

/*
 * The two digests below were computed with OpenSSL, NOT with this module:
 *
 *   printf '%s' 'client_abc:1700000000:0123…cdef:{"currency":"NGN"}' \
 *     | openssl dgst -sha256 -hmac 'sekret' -hex
 *
 * That independence is the whole value of the test. A vector produced by the
 * code under test proves the code agrees with itself, which is precisely how
 * Phase 3 shipped a table of Bitnob endpoints that passed every test and was
 * wrong in every entry.
 */
const CLIENT_ID = 'client_abc';
const CLIENT_SECRET = 'sekret';
const TIMESTAMP = '1700000000';
const NONCE = '0123456789abcdef0123456789abcdef';

const POST_DIGEST = '1b0754a141a977e931b1b7884361e371e8e867d4a88fe5268d980c3d74df7217';
const GET_DIGEST = '56cd72635ae47776717fa3e47f68090099382cc1d38bae2b6210b97c73b90f49';

describe('the string a Bitnob signature covers', () => {
  it('joins the four parts with colons, in their documented order', () => {
    expect(stringToSign(CLIENT_ID, TIMESTAMP, NONCE, '{"currency":"NGN"}')).toBe(
      'client_abc:1700000000:0123456789abcdef0123456789abcdef:{"currency":"NGN"}',
    );
  });

  it('leaves the payload empty for a request that sends no body', () => {
    // Their docs: "For a GET request the payload is an empty string." The
    // trailing colon is still there — the separator is not conditional.
    expect(stringToSign(CLIENT_ID, TIMESTAMP, NONCE, '')).toBe(
      'client_abc:1700000000:0123456789abcdef0123456789abcdef:',
    );
  });
});

describe('the signature itself', () => {
  it('matches a digest computed outside this codebase', () => {
    expect(sign(CLIENT_SECRET, stringToSign(CLIENT_ID, TIMESTAMP, NONCE, '{"currency":"NGN"}'))).toBe(
      POST_DIGEST,
    );
  });

  it('matches the empty-payload digest too', () => {
    expect(sign(CLIENT_SECRET, stringToSign(CLIENT_ID, TIMESTAMP, NONCE, ''))).toBe(GET_DIGEST);
  });

  it('is hex, and SHA-256 long', () => {
    // Not decoration: a base64 digest of the right bytes is the other
    // plausible encoding, is the same length in characters as nothing here,
    // and would be refused with the same 401 as a wrong key.
    expect(sign(CLIENT_SECRET, 'anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the body changes by one character', () => {
    const a = sign(CLIENT_SECRET, stringToSign(CLIENT_ID, TIMESTAMP, NONCE, '{"amount":"100"}'));
    const b = sign(CLIENT_SECRET, stringToSign(CLIENT_ID, TIMESTAMP, NONCE, '{"amount":"1000"}'));
    expect(a).not.toBe(b);
  });
});

describe('the timestamp', () => {
  it('is seconds, not milliseconds', () => {
    // The mistake JavaScript makes by default, and one of the three causes
    // their docs list for a 401. `Date.now()` here would be 1_700_000_000_000.
    expect(unixSeconds(() => 1_700_000_000_123)).toBe('1700000000');
  });

  it('carries no decimal part', () => {
    expect(unixSeconds(() => 1_700_000_000_999)).toBe('1700000000');
  });
});

describe('the nonce', () => {
  it('is sixteen bytes, hex-encoded', () => {
    expect(nonce()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat', () => {
    // A weak nonce makes the anti-replay guarantee decorative. 512 draws from
    // a CSPRNG collide with probability far below anything that could flake;
    // 512 draws from a 32-bit source would not.
    const seen = new Set(Array.from({ length: 512 }, () => nonce()));
    expect(seen.size).toBe(512);
  });
});

describe('the four headers', () => {
  it('carries the client id in the clear and the secret nowhere', () => {
    const headers = signedHeaders(CLIENT_ID, CLIENT_SECRET, '', () => 1_700_000_000_000);
    expect(headers['x-auth-client']).toBe(CLIENT_ID);
    expect(Object.values(headers).join(' ')).not.toContain(CLIENT_SECRET);
  });

  it('signs the payload it was handed, with the nonce it generated', () => {
    const headers = signedHeaders(
      CLIENT_ID,
      CLIENT_SECRET,
      '{"currency":"NGN"}',
      () => 1_700_000_000_000,
    );
    expect(headers['x-auth-timestamp']).toBe(TIMESTAMP);
    expect(headers['x-auth-signature']).toBe(
      sign(
        CLIENT_SECRET,
        stringToSign(CLIENT_ID, TIMESTAMP, headers['x-auth-nonce'], '{"currency":"NGN"}'),
      ),
    );
  });

  it('signs differently on every call, for the same body', () => {
    const one = signedHeaders(CLIENT_ID, CLIENT_SECRET, '{}');
    const two = signedHeaders(CLIENT_ID, CLIENT_SECRET, '{}');
    expect(one['x-auth-signature']).not.toBe(two['x-auth-signature']);
  });
});
