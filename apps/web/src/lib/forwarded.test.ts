import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardedFor } from './forwarded';

/**
 * The header that decides whether the API's rate limiter protects our
 * customers or refuses them.
 *
 * Everything this app sends to the API goes over a fresh server-side `fetch`,
 * so without this header the address the API sees is this container's — and
 * every web customer shares one bucket. Demonstrated against the built bundle:
 * three logins carrying three different `x-forwarded-for` values each got their
 * own bucket, and three carrying none shared one, the third refused. At the
 * production default of thirty per fifteen minutes, that is the thirty-first
 * sign-in from the whole web app being turned away on the busiest morning.
 */
describe('forwarding the caller address', () => {
  it('passes the edge header through', () => {
    const request = new Request('https://xetral.com/api/x/v1/wallets', {
      headers: { 'x-forwarded-for': '41.58.1.1' },
    });
    expect(forwardedFor(request)).toEqual({ 'x-forwarded-for': '41.58.1.1' });
  });

  it('COPIES rather than appending', () => {
    // The API resolves the client address with Express's `trust proxy` HOP
    // COUNT. A header this app added an entry to would be one hop longer than
    // the identical request from the mobile app, and one number cannot be
    // right for both path lengths. Copying keeps the two shapes identical.
    const request = new Request('https://xetral.com/api/x/v1/wallets', {
      headers: { 'x-forwarded-for': '41.58.1.1, 172.16.0.9' },
    });
    expect(forwardedFor(request)['x-forwarded-for']).toBe('41.58.1.1, 172.16.0.9');
  });

  it('invents nothing when the edge sent none', () => {
    // A value this app made up would be laundered through a header the API
    // trusts. Absent is honest: the API then falls back to the socket address,
    // which is what it did before this existed.
    const request = new Request('https://xetral.com/api/x/v1/wallets');
    expect(forwardedFor(request)).toEqual({});
  });
});

/**
 * The customer's country, relayed — because the one on the API's own request
 * is this server's. A customer in Lagos was emailed "new country: DE".
 */
describe('relaying where the customer was', () => {
  afterEach(() => vi.unstubAllEnvs());

  const fromLagos = () =>
    new Request('https://xetral.com/api/x/v1/auth/login', {
      headers: { 'cf-connecting-ip': '102.89.40.7', 'cf-ipcountry': 'NG' },
    });

  it("sends Cloudflare's answer about the customer's request, vouched by the secret", () => {
    vi.stubEnv('WEB_PROXY_SECRET', 'shared-between-web-and-api');
    expect(forwardedFor(fromLagos())).toEqual({
      'x-xetral-proxy-secret': 'shared-between-web-and-api',
      'x-xetral-client-ip': '102.89.40.7',
      'x-xetral-client-country': 'NG',
    });
  });

  it('sends nothing without the secret, so the API records no country rather than a wrong one', () => {
    vi.stubEnv('WEB_PROXY_SECRET', '');
    expect(forwardedFor(fromLagos())).toEqual({});
  });

  it('invents no country the edge did not give', () => {
    vi.stubEnv('WEB_PROXY_SECRET', 'shared-between-web-and-api');
    const request = new Request('https://xetral.com/api/x/v1/auth/login');
    expect(forwardedFor(request)).toEqual({ 'x-xetral-proxy-secret': 'shared-between-web-and-api' });
  });
});
