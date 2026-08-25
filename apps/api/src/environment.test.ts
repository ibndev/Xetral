import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

/**
 * The guards that make a staging environment worth having.
 *
 * A staging environment whose only protection is "we set different variables"
 * is one variable away from test traffic moving real money — and the person
 * who makes that mistake will be copying a production `.env` to get a box
 * working quickly, which is precisely when nobody is reading carefully.
 *
 * So the protection is a REFUSAL TO BOOT. Failing at startup costs a deploy;
 * failing on the first card issue costs a real customer's money and presents
 * as a bug in staging.
 */

const KEY = `v1:${randomBytes(32).toString('base64')}`;

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    XETRAL_ENVIRONMENT: 'production',
    DATABASE_URL: 'postgres://localhost/xetral',
    ACCESS_TOKEN_KEYS: KEY,
    ACCESS_TOKEN_CURRENT_VERSION: 'v1',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}

describe('naming the environment', () => {
  it('is required, with no default', () => {
    // Neither default is safe enough to be worth having. A staging box falling
    // back to `production` would merely be strict; a production box falling
    // back to `staging` would relax the guards protecting real customers.
    expect(() => loadConfig(env({ XETRAL_ENVIRONMENT: undefined }))).toThrow(ConfigError);
  });

  it('refuses a value that is not one of the three', () => {
    expect(() => loadConfig(env({ XETRAL_ENVIRONMENT: 'prod' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ XETRAL_ENVIRONMENT: 'stg' }))).toThrow(ConfigError);
  });

  it('accepts the three, however they are cased', () => {
    expect(loadConfig(env({ XETRAL_ENVIRONMENT: 'PRODUCTION' })).environment).toBe('production');
    expect(loadConfig(env({ XETRAL_ENVIRONMENT: ' staging ' })).environment).toBe('staging');
    expect(loadConfig(env({ XETRAL_ENVIRONMENT: 'development' })).environment).toBe('development');
  });
});

describe('staging cannot reach a live provider', () => {
  it('refuses to boot pointed at live Bitnob', () => {
    // The failure this exists to prevent: a staging box issuing REAL cards
    // and spending REAL money, discovered when somebody reconciles.
    expect(() =>
      loadConfig(
        env({
          XETRAL_ENVIRONMENT: 'staging',
          BITNOB_BASE_URL: 'https://api.bitnob.co/api/v1',
        }),
      ),
    ).toThrow(/LIVE provider/);
  });

  it('refuses to boot pointed at live VTpass', () => {
    expect(() =>
      loadConfig(
        env({ XETRAL_ENVIRONMENT: 'staging', VTPASS_BASE_URL: 'https://vtpass.com' }),
      ),
    ).toThrow(/LIVE provider/);
  });

  it('names every offending variable at once', () => {
    // One at a time would mean three deploys to find three mistakes, and the
    // person hitting this is already in a hurry.
    const error = (() => {
      try {
        loadConfig(
          env({
            XETRAL_ENVIRONMENT: 'staging',
            BITNOB_BASE_URL: 'https://api.bitnob.co/api/v1',
            VTPASS_BASE_URL: 'https://vtpass.com',
          }),
        );
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain('BITNOB_BASE_URL');
    expect(error?.message).toContain('VTPASS_BASE_URL');
  });

  it('accepts the sandbox hosts', () => {
    const config = loadConfig(
      env({
        XETRAL_ENVIRONMENT: 'staging',
        BITNOB_BASE_URL: 'https://sandboxapi.bitnob.co/api/v1',
        VTPASS_BASE_URL: 'https://sandbox.vtpass.com',
      }),
    );
    expect(config.environment).toBe('staging');
  });

  it('accepts a staging instance with no provider configured at all', () => {
    // Absent is not dangerous — those routes refuse. It is a SET, live one
    // that is refused.
    expect(loadConfig(env({ XETRAL_ENVIRONMENT: 'staging' })).environment).toBe('staging');
  });

  it('does NOT apply the guard in production', () => {
    // Obvious, and worth pinning: a guard that fired in production would stop
    // the real deployment from reaching the real provider.
    const config = loadConfig(
      env({
        XETRAL_ENVIRONMENT: 'production',
        BITNOB_BASE_URL: 'https://api.bitnob.co/api/v1',
      }),
    );
    expect(config.bitnobBaseUrl).toBe('https://api.bitnob.co/api/v1');
  });
});

describe('who staging may email', () => {
  it('defaults to NOBODY', () => {
    // The safe direction. A staging database is usually restored from a
    // production backup, and the moment it is, the notification worker is
    // holding every real customer's address and a queue of messages about
    // transfers that never happened.
    expect(loadConfig(env({ XETRAL_ENVIRONMENT: 'staging' })).notificationAllowlist).toEqual([]);
  });

  it('reads a comma-separated list, normalised', () => {
    const config = loadConfig(
      env({
        XETRAL_ENVIRONMENT: 'staging',
        NOTIFICATION_ALLOWLIST: '@xetral.com, Ops@Example.NG ,,  ',
      }),
    );
    expect(config.notificationAllowlist).toEqual(['@xetral.com', 'ops@example.ng']);
  });
});
