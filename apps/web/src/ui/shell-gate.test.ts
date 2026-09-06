import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NOBODY SEES THE DASHBOARD BEFORE THEY ARE SIGNED IN.
 *
 * Every customer screen rendered its chrome immediately — the tab bar, the
 * sidebar, a balance card's skeleton — and only then did a hook call the API,
 * get a 401 and push to /signin. So opening the site while signed out flashed
 * the shape of somebody's dashboard before the sign in page arrived. Nothing
 * leaked, because no data had loaded; what it looked like was the product
 * briefly letting a stranger in and then changing its mind.
 *
 * The gate lives in `Shell` so it cannot be forgotten. This test is what keeps
 * it there: a screen that draws customer chrome WITHOUT going through `Shell`
 * would reintroduce the flash on exactly one page, which is the hardest kind
 * of regression to notice.
 */
const APP = new URL('../app', import.meta.url).pathname;
const SHELL = new URL('./shell.tsx', import.meta.url).pathname;

/**
 * Routes that are deliberately NOT behind the shell, each with the reason.
 *
 * Being on this list is a claim: it says the page is reachable by somebody who
 * is not signed in, and therefore must not be gated.
 */
const UNGATED: Readonly<Record<string, string>> = {
  signin: 'the sign in page itself',
  signup: 'registering, which by definition has no session',
  forgot: 'the way back in — and the reset code screen it leads to',
  pay: 'the PUBLIC checkout — a stranger with no account pays on it',
  legal: 'the terms and the privacy notice, which must be readable by anyone',
  admin: 'the operations surface, which has its own gate and its own shell',
  api: 'route handlers, not pages',
  more: 'a menu, and it renders Shell itself',
};

function pageFiles(dir: string, prefix = ''): { route: string; path: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return pageFiles(path, prefix === '' ? name : prefix);
    }
    return name === 'page.tsx' && prefix !== '' ? [{ route: prefix, path }] : [];
  });
}

describe('the customer surface is gated where it cannot be forgotten', () => {
  it('renders every signed-in screen through Shell', () => {
    const ungated = pageFiles(APP)
      .filter(({ route }) => UNGATED[route] === undefined)
      .filter(({ path }) => !readFileSync(path, 'utf8').includes('<Shell'))
      .map(({ route }) => route);

    expect(
      ungated,
      'these draw customer chrome without the session gate, so a signed-out ' +
        'visitor sees them for a frame before being sent to sign in:\n' +
        ungated.join('\n'),
    ).toEqual([]);
  });

  it('Shell refuses to paint until the session is known', () => {
    const source = readFileSync(SHELL, 'utf8');
    // The three halves of the gate. Asserted as text because there is no way
    // to render this component without a browser, and a gate that compiled and
    // did nothing is exactly the failure being guarded against.
    expect(source).toContain('hasSession()');
    expect(source).toContain("router.replace('/signin')");
    expect(source).toMatch(/if \(allowed !== true\) return/);
  });
});
