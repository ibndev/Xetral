import { describe, expect, it } from 'vitest';
import { ExchangeRateAdapter } from './exchangerate-adapter.js';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from '../ports/errors.js';

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SUCCESS = {
  result: 'success',
  base_code: 'USD',
  time_last_update_unix: 1_717_977_601,
  conversion_rates: { USD: 1, NGN: 1650.12, GHS: 15.4321987, KES: 129.5 },
};

describe('the ExchangeRate-API adapter', () => {
  it('puts the key in the PATH, because that is where this provider wants it', async () => {
    // Unlike every other adapter here, which bear a token or sign. Sending it
    // as a header would get an `invalid-key` that reads as a wrong key — the
    // exact misdiagnosis `bitnob/signing.ts` exists because of.
    let seen = '';
    const adapter = new ExchangeRateAdapter({
      apiKey: 'k-123',
      baseUrl: 'https://feed.test',
      fetch: async (url, init) => {
        seen = url;
        expect(init.headers).toBeUndefined();
        return respond(SUCCESS);
      },
    });

    await adapter.latest('USD');
    expect(seen).toBe('https://feed.test/v6/k-123/latest/USD');
  });

  it('reads rates as decimal strings at a fixed width', async () => {
    const adapter = new ExchangeRateAdapter({
      apiKey: 'k',
      fetch: async () => respond(SUCCESS),
    });

    const { rates, base, asOf } = await adapter.latest('USD');
    expect(base).toBe('USD');
    // Fixed at six places, which is what makes two syncs comparable as TEXT —
    // and comparing is what decides whether a rate is republished at all. A
    // varying width would make `1650.1` and `1650.100000` look like a change.
    expect(rates.get('NGN')).toBe('1650.120000');
    expect(rates.get('GHS')).toBe('15.432199');
    expect(asOf?.toISOString()).toBe('2024-06-10T00:00:01.000Z');
  });

  it('drops a rate that is not a rate rather than publishing it', async () => {
    // Zero, negative and absurd values are all things a feed can emit on a bad
    // day, and every one of them would become a published price that quotes a
    // customer nonsense. Skipping is right: the pair keeps its last good rate
    // and `stale_reference_rates` is what notices if it stays that way.
    const adapter = new ExchangeRateAdapter({
      apiKey: 'k',
      fetch: async () =>
        respond({
          ...SUCCESS,
          conversion_rates: { NGN: 1650.12, ZWL: 0, XXX: -3, YYY: 1e15, ZZZ: 'lots' },
        }),
    });

    const { rates } = await adapter.latest('USD');
    expect(rates.has('NGN')).toBe(true);
    expect(rates.has('ZWL')).toBe(false);
    expect(rates.has('XXX')).toBe(false);
    expect(rates.has('YYY')).toBe(false);
    expect(rates.has('ZZZ')).toBe(false);
  });

  it('names the cause from the BODY, not from the status', async () => {
    // An exhausted quota and a revoked key are both a 4xx here, and they need
    // different actions from an operator: one is waiting, the other is a new
    // key. Only the body distinguishes them.
    const quota = new ExchangeRateAdapter({
      apiKey: 'k',
      fetch: async () => respond({ result: 'error', 'error-type': 'quota-reached' }, 403),
    });
    await expect(quota.latest('USD')).rejects.toBeInstanceOf(ProviderUnavailableError);

    const revoked = new ExchangeRateAdapter({
      apiKey: 'k',
      fetch: async () => respond({ result: 'error', 'error-type': 'invalid-key' }, 403),
    });
    await expect(revoked.latest('USD')).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('refuses a 200 that carries no rates', async () => {
    // `result: success` with nothing in it is a contract break, not an
    // outage — waiting does not fix it and a retry loop would hide it.
    const adapter = new ExchangeRateAdapter({
      apiKey: 'k',
      fetch: async () => respond({ result: 'success', conversion_rates: {} }),
    });
    await expect(adapter.latest('USD')).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('refuses to call at all with no key, and says what to do', async () => {
    let called = false;
    const adapter = new ExchangeRateAdapter({
      apiKey: async () => undefined,
      fetch: async () => {
        called = true;
        return respond(SUCCESS);
      },
    });

    await expect(adapter.latest('USD')).rejects.toBeInstanceOf(ProviderRejectedError);
    expect(called).toBe(false);
  });

  it('resolves the key PER CALL, so a pasted one takes effect', async () => {
    // 026's rule from the other side: an adapter built once at boot can only
    // ever hold what the environment had, and an operator who pasted a key
    // would watch the dashboard report it as set while nothing used it.
    let current = 'old';
    const adapter = new ExchangeRateAdapter({
      apiKey: async () => current,
      baseUrl: 'https://feed.test',
      fetch: async (url) => {
        expect(url).toContain(`/v6/${current}/`);
        return respond(SUCCESS);
      },
    });

    await adapter.latest('USD');
    current = 'new';
    await adapter.latest('USD');
  });
});
