import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';
import { testApiConfig } from '../test-support/api-config.js';
import { acceptsTestOtp, isTestEmail, isTestPhone } from './test-accounts.js';

/**
 * The test-account whitelist, and the fixed code it unlocks.
 *
 * The whole safety argument is that both are the OPERATOR'S list and nothing
 * else: an account not on it is reset by nobody and signs up with the emailed
 * code like every other customer.
 */

const KEY = `v1:${randomBytes(32).toString('base64')}`;
const env = (extra: Record<string, string>): Record<string, string> => ({
  XETRAL_ENVIRONMENT: 'production',
  DATABASE_URL: 'postgres://localhost/xetral',
  ACCESS_TOKEN_KEYS: KEY,
  ACCESS_TOKEN_CURRENT_VERSION: 'v1',
  ...extra,
});

const config = testApiConfig('postgres://localhost/xetral', {
  testAccounts: {
    emails: ['qa@xetral.test'],
    phones: ['+2348012345678'],
    otp: '424242',
  },
});

describe('reading the lists from the environment', () => {
  it('lower-cases emails and writes phones as E.164, as the rows are stored', () => {
    const loaded = loadConfig(
      env({
        TEST_ACCOUNT_EMAILS: ' QA@Xetral.test , second@xetral.test ',
        TEST_ACCOUNT_PHONES: '2348012345678, +233 50 123 4567',
        TEST_OTP: '424242',
      }),
    );
    expect(loaded.testAccounts).toEqual({
      emails: ['qa@xetral.test', 'second@xetral.test'],
      phones: ['+2348012345678', '+233501234567'],
      otp: '424242',
    });
  });

  it('is empty when unset — nobody can be reset and no fixed code works', () => {
    expect(loadConfig(env({})).testAccounts).toEqual({ emails: [], phones: [], otp: undefined });
  });

  it('refuses to boot on an entry it cannot read, rather than dropping it', () => {
    expect(() => loadConfig(env({ TEST_ACCOUNT_EMAILS: 'not-an-address' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ TEST_ACCOUNT_PHONES: '0801234' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ TEST_OTP: '12345' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ TEST_OTP: 'abcdef' }))).toThrow(ConfigError);
  });
});

describe('who is a test account', () => {
  it('matches an email whatever its case, and a phone exactly', () => {
    expect(isTestEmail(config, 'QA@xetral.test')).toBe(true);
    expect(isTestEmail(config, 'customer@example.ng')).toBe(false);
    expect(isTestPhone(config, '+2348012345678')).toBe(true);
    expect(isTestPhone(config, '+2348099999999')).toBe(false);
  });
});

describe('the fixed signup code', () => {
  it('is accepted for a whitelisted email or phone', () => {
    expect(acceptsTestOtp(config, '424242', { email: 'qa@xetral.test' })).toBe(true);
    expect(
      acceptsTestOtp(config, '424242', { email: 'new@example.ng', phone: '+2348012345678' }),
    ).toBe(true);
  });

  it('opens nothing for anybody else, even with the right code', () => {
    expect(
      acceptsTestOtp(config, '424242', { email: 'customer@example.ng', phone: '+2348099999999' }),
    ).toBe(false);
  });

  it('refuses a wrong code on a whitelisted account', () => {
    expect(acceptsTestOtp(config, '000000', { email: 'qa@xetral.test' })).toBe(false);
  });

  it('accepts nothing at all when TEST_OTP is unset', () => {
    const off = testApiConfig('postgres://localhost/xetral', {
      testAccounts: { emails: ['qa@xetral.test'], phones: [], otp: undefined },
    });
    expect(acceptsTestOtp(off, '424242', { email: 'qa@xetral.test' })).toBe(false);
  });
});
