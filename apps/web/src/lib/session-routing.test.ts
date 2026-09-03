import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY SESSION CALL REACHES SOMETHING THAT ANSWERS IT.
 *
 * `/api/x-auth` is a SENTINEL rather than a route — nothing on disk serves it,
 * and `rewrite()` in `session.ts` is the only reason a request to it ever
 * arrives anywhere. So a session call the rewrite does not account for is a
 * silent 404, and it has been one twice:
 *
 *   `Session.countries()` requests `/v1/countries`. The old rewrite only
 *   matched `/v1/auth/`, so this went out as `/api/x-auth/v1/countries` and
 *   404'd — THE COUNTRY LIST NEVER LOADED ON THE WEB. The signup form's
 *   country picker was permanently empty and the dialling code permanently
 *   showed its placeholder, which reads as a broken control and is a routing
 *   fault. Nothing failed: an empty list renders as an empty list.
 *
 *   Password reset is under `/v1/auth/` and would have gone to
 *   `/api/auth/password/forgot`, which this app does not serve either — the
 *   prefix matched, and only four auth routes exist here.
 *
 * The same shape as the `/pay` bug and the reset link: a path built in one
 * place against a directory that lives in another, with no compiler between
 * them.
 */

const HERE = new URL('.', import.meta.url).pathname;
const SESSION = join(HERE, 'session.ts');
const API_DIR = join(HERE, '..', 'app', 'api');
const CLIENT = join(HERE, '..', '..', '..', '..', 'packages', 'client', 'src', 'session.ts');

/** The `/api/auth/*` handlers this app actually has on disk. */
function handlers(): readonly string[] {
  return readdirSync(join(API_DIR, 'auth'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** The routes `session.ts` claims to answer itself. */
function claimed(): readonly string[] {
  const block = /const COOKIE_ROUTES[^=]*=\s*\[([^\]]*)\]/.exec(readFileSync(SESSION, 'utf8'));
  if (block === null) throw new Error('COOKIE_ROUTES is not in session.ts');
  return Array.from((block[1] ?? '').matchAll(/'([a-z-]+)'/g), (m) => m[1] as string).sort();
}

describe('where a session call goes', () => {
  it('answers exactly the auth routes this app has handlers for', () => {
    // BOTH DIRECTIONS. A handler with no entry is a route nothing reaches; an
    // entry with no handler is a call rewritten to a 404 — which is the bug.
    expect(claimed()).toEqual(handlers());
  });

  it('sends every OTHER session call to the proxy rather than nowhere', () => {
    /*
     * The default has to be "serve it", because a method added to `Session`
     * later gets whatever this function does with a path it has never seen. It
     * used to be "leave it alone", which meant a 404, which meant nobody
     * noticed until a customer could not pick their country.
     */
    const source = readFileSync(SESSION, 'utf8');
    expect(
      /replace\('\/api\/x-auth\/', '\/api\/x\/'\)/.test(source),
      'the fallback must rewrite to the proxy — anything else is a silent 404',
    ).toBe(true);
  });

  it('covers every path Session actually requests', () => {
    /*
     * Read off `Session` itself rather than a list here: a method added there
     * is the thing this test exists to catch, and a hand-written list would
     * simply not mention it.
     *
     * Each path is put through the SAME rule `rewrite()` applies, and the
     * question asked is where it LANDS. Two answers are acceptable — one of
     * this app's four handlers, or the proxy — and one is not: still carrying
     * `x-auth`, which is a prefix nothing serves. That third case is exactly
     * what `countries()` did.
     */
    const paths = Array.from(
      readFileSync(CLIENT, 'utf8').matchAll(/\$\{this\.#baseUrl\}(\/v1\/[a-z0-9/_-]+)/g),
      (m) => m[1] as string,
    );
    expect(paths.length, 'no session paths found — the pattern has drifted').toBeGreaterThan(3);

    const cookie = claimed();
    const stranded: string[] = [];
    for (const path of paths) {
      const url = `/api/x-auth${path}`;
      const auth = /^\/api\/x-auth\/v1\/auth\/([a-z-]+)/.exec(url);
      const landed =
        auth !== null && cookie.includes(auth[1] ?? '')
          ? url.replace('/api/x-auth/v1/auth/', '/api/auth/')
          : url.replace('/api/x-auth/', '/api/x/');

      if (landed.includes('x-auth')) stranded.push(`${path} → ${landed} (nothing serves this)`);
      if (landed.startsWith('/api/auth/')) {
        const handler = landed.slice('/api/auth/'.length).split('/')[0] ?? '';
        if (!handlers().includes(handler)) {
          stranded.push(`${path} → ${landed} (no such handler)`);
        }
      }
    }

    expect(
      stranded,
      `these session calls reach nothing:\n${stranded.join('\n')}`,
    ).toEqual([]);
  });
});
