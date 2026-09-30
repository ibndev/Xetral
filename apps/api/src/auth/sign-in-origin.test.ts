import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROXY_HEADERS, signInOriginFrom } from './sign-in-events.service.js';

/**
 * Where a sign-in came from is the CUSTOMER'S, never the web server's.
 *
 * Every customer request reaches the API through the web app, and the
 * `CF-IPCountry` on the API's own request described that server — so a
 * customer signing in from Lagos was emailed "Sign-in from a new country: DE"
 * beside a Cloudflare address.
 */
const SECRET = 'shared-between-web-and-api';

describe('signInOriginFrom', () => {
  it("never reads the country Cloudflare stamped on the API's own request", () => {
    // Exactly the production email: DE, from the web server's trip.
    const origin = signInOriginFrom({ 'cf-ipcountry': 'DE' }, '172.71.131.61', SECRET);
    expect(origin.country).toBeUndefined();
  });

  it('reads the customer origin the proxy relays, when it carries the secret', () => {
    const origin = signInOriginFrom(
      {
        'cf-ipcountry': 'DE',
        [PROXY_HEADERS.secret]: SECRET,
        [PROXY_HEADERS.ip]: '102.89.40.7',
        [PROXY_HEADERS.country]: 'ng',
      },
      '172.71.131.61',
      SECRET,
    );
    expect(origin).toEqual({ ip: '102.89.40.7', country: 'NG' });
  });

  it('ignores a relayed origin with the wrong secret — a forged NG would silence the alert', () => {
    const origin = signInOriginFrom(
      {
        [PROXY_HEADERS.secret]: 'guessed',
        [PROXY_HEADERS.ip]: '102.89.40.7',
        [PROXY_HEADERS.country]: 'NG',
      },
      '203.0.113.9',
      SECRET,
    );
    expect(origin).toEqual({ ip: '203.0.113.9', country: undefined });
  });

  it('trusts nothing relayed when no secret is configured', () => {
    const origin = signInOriginFrom(
      { [PROXY_HEADERS.secret]: '', [PROXY_HEADERS.country]: 'NG' },
      '203.0.113.9',
      undefined,
    );
    expect(origin.country).toBeUndefined();
  });

  it('drops a relayed address or country that is not one', () => {
    const origin = signInOriginFrom(
      {
        [PROXY_HEADERS.secret]: SECRET,
        [PROXY_HEADERS.ip]: 'not-an-address',
        [PROXY_HEADERS.country]: 'Nigeria',
      },
      '203.0.113.9',
      SECRET,
    );
    expect(origin).toEqual({ ip: '203.0.113.9', country: undefined });
  });

  it('names the same three headers the web proxy sends', () => {
    // The web app imports nothing from the API, so the two lists are text in
    // two workspaces — the shape the `/pay` 404 was made of.
    const web = readFileSync(new URL('../../../web/src/lib/forwarded.ts', import.meta.url), 'utf8');
    for (const name of Object.values(PROXY_HEADERS)) expect(web).toContain(`'${name}'`);
  });
});
