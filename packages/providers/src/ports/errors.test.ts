import { describe, expect, it } from 'vitest';
import {
  neverConnected,
  ProviderContractError,
  ProviderNotSentError,
  ProviderPendingError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  providerDidNothing,
} from './errors.js';

/** What undici's `fetch` throws: a TypeError whose cause carries the code. */
const fetchFailed = (code: string): TypeError => {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
};

describe('neverConnected', () => {
  it('is true only where no socket was ever established', () => {
    expect(neverConnected(fetchFailed('ECONNREFUSED'))).toBe(true);
    expect(neverConnected(fetchFailed('ENOTFOUND'))).toBe(true);
    expect(neverConnected(fetchFailed('EAI_AGAIN'))).toBe(true);
  });

  it('is false for a reset or anything it cannot name — those may follow a written body', () => {
    expect(neverConnected(fetchFailed('ECONNRESET'))).toBe(false);
    expect(neverConnected(fetchFailed('UND_ERR_SOCKET'))).toBe(false);
    expect(neverConnected(new Error('something else'))).toBe(false);
    expect(neverConnected(undefined)).toBe(false);
  });
});

describe('providerDidNothing — the one question before giving money back', () => {
  it('is true for a refusal and for a request that never left', () => {
    expect(providerDidNothing(new ProviderRejectedError('p', 'no', 'X'))).toBe(true);
    expect(providerDidNothing(new ProviderNotSentError('p', 'no key'))).toBe(true);
  });

  it('is false for every answer that leaves the outcome open', () => {
    expect(providerDidNothing(new ProviderTimeoutError('p', 'slow'))).toBe(false);
    expect(providerDidNothing(new ProviderUnavailableError('p', '502'))).toBe(false);
    expect(providerDidNothing(new ProviderContractError('p', 'html'))).toBe(false);
    expect(providerDidNothing(new ProviderPendingError('p', 'accepted'))).toBe(false);
    expect(providerDidNothing(new TypeError('our own bug'))).toBe(false);
  });

  it('a not-sent error is still an unavailable one to everything that already handles those', () => {
    expect(new ProviderNotSentError('p', 'x')).toBeInstanceOf(ProviderUnavailableError);
  });
});
