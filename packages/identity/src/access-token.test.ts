import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  type AccessTokenKeyring,
  signAccessToken,
  verifyAccessToken,
} from './access-token.js';

const v1 = { version: 'v1', secret: randomBytes(32) };
const v2 = { version: 'v2', secret: randomBytes(32) };

const keyring: AccessTokenKeyring = { current: v1, accepted: [v1] };
const subject = { sub: 'user-uuid', sid: 'session-uuid', did: 'device-uuid' };

const NOW = 1_700_000_000;

describe('signing and verifying', () => {
  it('round-trips the claims', () => {
    const token = signAccessToken(subject, keyring, NOW, 900);
    const result = verifyAccessToken(token, keyring, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('user-uuid');
    expect(result.claims.sid).toBe('session-uuid');
    expect(result.claims.did).toBe('device-uuid');
    expect(result.claims.exp).toBe(NOW + 900);
  });

  it('rejects a token whose payload was edited', () => {
    // The attack this whole format exists to make boring: rewrite `sub` to
    // somebody else's user id and present it.
    const token = signAccessToken(subject, keyring, NOW, 900);
    const [format, version, , signature] = token.split('.');

    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', sid: 'x', did: 'y', iat: NOW, exp: NOW + 900 }),
      'utf8',
    ).toString('base64url');

    const result = verifyAccessToken(`${format}.${version}.${forged}.${signature}`, keyring, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token signed with a different key', () => {
    const other: AccessTokenKeyring = { current: { ...v1, secret: randomBytes(32) }, accepted: [] };
    const token = signAccessToken(subject, other, NOW, 900);
    expect(verifyAccessToken(token, keyring, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('expires', () => {
    const token = signAccessToken(subject, keyring, NOW, 900);
    expect(verifyAccessToken(token, keyring, NOW + 899).ok).toBe(true);
    expect(verifyAccessToken(token, keyring, NOW + 900)).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports expiry only for tokens that are otherwise authentic', () => {
    // Order matters: an expired token with a broken signature is a forgery,
    // not a lapsed session, and must not be reported as one.
    const token = signAccessToken(subject, keyring, NOW, 900);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyAccessToken(tampered, keyring, NOW + 5000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('key rotation', () => {
  it('accepts a token signed by a retired key that is still in the keyring', () => {
    const during: AccessTokenKeyring = { current: v2, accepted: [v2, v1] };
    const oldToken = signAccessToken(subject, { current: v1, accepted: [v1] }, NOW, 900);
    expect(verifyAccessToken(oldToken, during, NOW).ok).toBe(true);
  });

  it('rejects a token once its key is dropped', () => {
    const after: AccessTokenKeyring = { current: v2, accepted: [v2] };
    const oldToken = signAccessToken(subject, { current: v1, accepted: [v1] }, NOW, 900);
    expect(verifyAccessToken(oldToken, after, NOW)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('will not verify a token that names a key the keyring does not have', () => {
    // The `kid`-as-instruction class of JWT bug: an unknown version must fail
    // closed, never fall back to any available key.
    const token = signAccessToken(subject, keyring, NOW, 900);
    const parts = token.split('.');
    const relabelled = `${parts[0]}.v99.${parts[2]}.${parts[3]}`;
    expect(verifyAccessToken(relabelled, keyring, NOW)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });
});

describe('malformed input', () => {
  it('rejects junk without throwing', () => {
    // This function is reachable by anyone with the URL. Every one of these
    // must be a 401, never a 500 and never a stack trace.
    for (const bad of ['', '.', 'v1', 'v1.v1', 'v1.v1.payload', 'a.b.c.d.e', '....']) {
      expect(() => verifyAccessToken(bad, keyring, NOW)).not.toThrow();
      expect(verifyAccessToken(bad, keyring, NOW).ok).toBe(false);
    }
  });

  it('rejects a token whose algorithm prefix was changed', () => {
    // There is no `alg` field to attack, but the format tag must still be
    // pinned rather than parsed permissively.
    const token = signAccessToken(subject, keyring, NOW, 900);
    expect(verifyAccessToken(token.replace(/^v1\./, 'v0.'), keyring, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses to issue a token with a nonsensical lifetime', () => {
    expect(() => signAccessToken(subject, keyring, NOW, 0)).toThrow(RangeError);
    expect(() => signAccessToken(subject, keyring, NOW, -60)).toThrow(RangeError);
    expect(() => signAccessToken(subject, keyring, NOW, 1.5)).toThrow(RangeError);
  });
});
