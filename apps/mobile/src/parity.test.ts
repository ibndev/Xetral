import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PHONE REACHES EVERY DESTINATION THE WEB DOES.
 *
 * The two apps drifted badly and quietly: the web grew thirteen customer
 * screens while the phone stayed at seven, so cards, bills, conversion,
 * crypto, activity, identity and settings existed on a laptop and simply did
 * not on Android. Nothing failed — each app compiled, each app's tests passed,
 * and the gap was only visible to somebody holding both.
 *
 * This is the same shape as `route-coverage.test.ts` on the API and
 * `nav-coverage.test.ts` on the operations dashboard, and it exists for the
 * reason those do: a list somebody maintains by hand stops matching, and the
 * mismatch is invisible from inside either half.
 *
 * It compares ROUTES, not implementations. The two apps are allowed to render
 * a screen differently — a phone is not a browser — and are not allowed to be
 * missing one.
 */

const HERE = new URL('.', import.meta.url).pathname;
const MOBILE_APP = join(HERE, '..', 'app');
const WEB_APP = join(HERE, '..', '..', 'web', 'src', 'app');

/** Customer-facing routes in the Next app, from the filesystem. */
function webRoutes(dir: string, prefix = ''): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const name = entry.name;
    // Not customer surfaces: the operations dashboard, the BFF route
    // handlers, the legal pages (which are deliberately reachable without an
    // account, from a browser), and dynamic segments.
    if (['admin', 'api', 'legal'].includes(name) || name.startsWith('[')) return [];
    const here = join(dir, name);
    const isPage = readdirSync(here).includes('page.tsx');
    return [...(isPage ? [`${prefix}/${name}`] : []), ...webRoutes(here, `${prefix}/${name}`)];
  });
}

/** Screens in the Expo app. */
function mobileRoutes(): readonly string[] {
  return readdirSync(MOBILE_APP)
    .filter((entry) => entry.endsWith('.tsx') && !entry.startsWith('_'))
    .map((entry) => `/${entry.replace(/\.tsx$/, '')}`);
}

/**
 * Web routes with no phone screen, and why that is acceptable.
 *
 * An entry here is a hole in the check, so it has to be cheaper to justify one
 * than to add a screen.
 */
const WEB_ONLY: Readonly<Record<string, string>> = {
  // The web's `/` immediately redirects to `/wallet`; the phone's entry point
  // is `index.tsx`, which decides between the wallet and sign-in. Same job,
  // different filename.
  '/signin': 'present as signin.tsx',
  '/signup': 'present as signup.tsx',
};

describe('web and mobile reach the same places', () => {
  const web = [...webRoutes(WEB_APP)].sort();
  const mobile = new Set(mobileRoutes());

  it('every customer screen on the web exists on the phone', () => {
    const missing = web
      .filter((route) => !mobile.has(route) && WEB_ONLY[route] === undefined)
      .sort();

    expect(
      missing,
      'screens a customer can reach on the web and not on the phone:\n' + missing.join('\n'),
    ).toEqual([]);
  });

  it('every phone screen is wired into the navigator', () => {
    // A file under `app/` that no `<Stack.Screen>` names still routes, but it
    // gets the navigator's default header on top of the one `Shell` draws —
    // two headers, which is how you find out.
    const layout = readFileSync(join(MOBILE_APP, '_layout.tsx'), 'utf8');
    const declared = new Set(
      Array.from(layout.matchAll(/<Stack\.Screen name="([a-z-]+)"/g), (m) => `/${m[1] as string}`),
    );
    const undeclared = [...mobile].filter((route) => !declared.has(route)).sort();
    expect(undeclared, `screens with no <Stack.Screen>:\n${undeclared.join('\n')}`).toEqual([]);
  });

  it('every tab in the bar points at a screen that exists', () => {
    const shell = readFileSync(join(HERE, 'shell.tsx'), 'utf8');
    const tabs = Array.from(shell.matchAll(/href: '(\/[a-z-]+)'/g), (m) => m[1] as string);
    expect(tabs.length).toBeGreaterThan(0);
    const dangling = tabs.filter((href) => !mobile.has(href)).sort();
    expect(dangling, `tab bar entries with no screen:\n${dangling.join('\n')}`).toEqual([]);
  });
});
