import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE ADDRESS BAKED INTO THE APK.
 *
 * A preview APK's API address is inlined when the JavaScript is bundled, so a
 * wrong one cannot be corrected on the handset — it is a rebuild, a release
 * and a reinstall. The first one shipped against `api.xetral.com`, which
 * nothing in the deployment publishes: the web app reaches the API over a
 * private `XETRAL_API_URL`. The web worked, the phone could not sign in at
 * all, and neither symptom pointed at the other.
 *
 * So the phone goes through the web app's same-origin proxy, and the two
 * things that would silently break that are asserted here rather than left to
 * be discovered by installing.
 */

const appJson: { expo: { extra?: { apiUrl?: unknown } } } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'app.json'), 'utf8'),
) as { expo: { extra?: { apiUrl?: unknown } } };

const apiUrl = appJson.expo.extra?.apiUrl;

describe('the API address the APK is built against', () => {
  it('is an absolute https URL', () => {
    // Cleartext would put a bearer token on a coffee shop's Wi-Fi. The
    // `with-lan-cleartext` plugin exists to permit exactly one exception, a
    // LAN address during development, and it reads EXPO_PUBLIC_API_URL rather
    // than this.
    expect(typeof apiUrl).toBe('string');
    expect(String(apiUrl)).toMatch(/^https:\/\//);
  });

  it('KEEPS THE PROXY PATH, which is the whole address and not a decoration', () => {
    /*
     * `https://app.xetral.com` and `https://app.xetral.com/api/x` differ by a
     * suffix that reads like a detail and is the difference between a working
     * app and one where every request 404s into Next's page router. Tidying
     * the "redundant" path off this value is an obvious thing for somebody to
     * do and there is nothing else that would object.
     */
    const url = new URL(String(apiUrl));
    expect(url.pathname).toBe('/api/x');
  });

  it('has no trailing slash to be doubled', () => {
    // `apiUrl()` strips one, so this is belt and braces — but a value ending
    // in a slash also reads as though the path were optional, which is the
    // reading the test above exists to refuse.
    expect(String(apiUrl).endsWith('/')).toBe(false);
  });

  it('is not a host only the phone would ever notice the loss of', () => {
    /*
     * The failure this whole file is about: a hostname reachable by nothing
     * else in the system. If the phone is ever pointed at its own dedicated
     * origin again, that origin needs a monitor, a certificate and somebody
     * who would notice it going down — none of which existed for
     * `api.xetral.com`. Until then, share the address the browser proves is up
     * every time anybody opens the web app.
     */
    expect(new URL(String(apiUrl)).hostname).not.toMatch(/^api\./);
  });
});
