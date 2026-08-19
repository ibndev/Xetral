import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
  isSecurityIncident,
  issueRefreshToken,
} from './tokens.js';

describe('refresh tokens', () => {
  it('produces a hash the database will accept', () => {
    // The `^[0-9a-f]{64}$` CHECK on refresh_tokens.token_hash is what stops a
    // raw token from being stored. If this format ever drifts, every refresh
    // fails at the constraint rather than silently storing a secret.
    expect(issueRefreshToken().hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a token the database will REJECT as a hash', () => {
    // The other half of the same guarantee: the raw token must not accidentally
    // satisfy the column's constraint, or the mistake becomes storable.
    expect(issueRefreshToken().token).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(issueRefreshToken().token);
    expect(seen.size).toBe(1000);
  });

  it('hashes deterministically, so a presented token finds its row', () => {
    const { token, hash } = issueRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
  });

  it('gives a different hash for a token differing by one character', () => {
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });

  it('keeps the access token window short', () => {
    // This is not a style preference. An access token cannot be revoked
    // mid-life, so this number is the exact duration a stolen one keeps
    // working. A change here is a security decision.
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});

describe('rotation outcomes', () => {
  it('treats only reuse as a security incident', () => {
    // An expired or unknown token is routine. Conflating them would bury the
    // one outcome that means somebody may be holding a stolen credential.
    expect(isSecurityIncident('reuse_detected')).toBe(true);
    expect(isSecurityIncident('expired')).toBe(false);
    expect(isSecurityIncident('unknown_token')).toBe(false);
    expect(isSecurityIncident('session_revoked')).toBe(false);
    expect(isSecurityIncident('rotated')).toBe(false);
  });
});
