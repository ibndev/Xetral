import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * The Content-Security-Policy, with a per-request nonce.
 *
 * IT IS HERE AND NOT IN `next.config.mjs`, and the reason is worth recording
 * because the config version looked correct and shipped a dead application.
 *
 * A static `script-src 'self'` blocks Next's own inline bootstrap — the
 * `self.__next_f.push([...])` blocks carrying the server-rendered payload. The
 * page then renders its HTML, the browser refuses the scripts, and NOTHING
 * hydrates: every button inert, every form doing nothing, and a screenshot
 * that looks perfect. Found by serving the built bundle and reading the HTML,
 * which is the same reason CI boots the API rather than trusting a green test
 * run.
 *
 * A nonce has to be generated per request, so it cannot come from a build-time
 * config. Setting it on the REQUEST headers is what makes Next put the same
 * nonce on the scripts it emits; setting it on the response is what makes the
 * browser enforce it.
 *
 * The cost is that every page is now rendered per request rather than
 * prerendered. That is a real trade and it is the right one here: these pages
 * are all behind a sign-in and all show live money, so there was very little
 * to prerender beyond an empty shell.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    "default-src 'self'",
    // `strict-dynamic` says: trust what the nonce'd script loads, and ignore
    // the host list. That is what lets Next's bootstrap pull its own chunks
    // while an injected `<script>` — which has no nonce and was not loaded by
    // one — still cannot run.
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https: http:`,
    // `unsafe-inline` for STYLE and not for script, deliberately. Next inlines
    // a small style block, a nonce for which would buy nothing: an injected
    // stylesheet cannot read a token or make a request. Script is where the
    // session lives, so script gets no such latitude.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // Same-origin only. The API is proxied through this app, so the page has
    // no business talking to anything else — and this is the line that stops
    // an injected script posting a balance somewhere.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  // `unsafe-inline` and the `https:`/`http:` sources above are IGNORED by any
  // browser that understands `strict-dynamic`, and are there only so a browser
  // too old to understand it degrades to a host allowlist rather than to
  // nothing. A modern browser enforces the nonce.

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  // Read by Next itself to stamp the nonce onto the scripts it renders. Set on
  // the REQUEST, which is the part that is easy to leave out and which makes
  // the difference between a working page and a blank one.
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output and the favicon. Those are
     * immutable build artifacts served from this origin; running a nonce
     * generator for each one would cost a request's worth of work to protect
     * a file with no script in it.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
