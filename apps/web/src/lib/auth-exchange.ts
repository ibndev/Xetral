import { NextResponse } from 'next/server';
import { apiBaseUrl, COOKIE_OPTIONS, REFRESH_COOKIE } from '@/lib/config';
import { forwardedFor } from '@/lib/forwarded';

/**
 * Calls an API endpoint that mints a token pair, and keeps the refresh token
 * out of the browser.
 *
 * ONE function for sign-in and registration rather than two handlers that each
 * do it. They are the same operation — credentials in, a token pair back — and
 * the part that matters is the same in both: the REFRESH token goes into an
 * httpOnly cookie and only the short-lived access token is returned to the
 * page. That is the difference between an injected script stealing fifteen
 * minutes and stealing a month, and it is not a thing to have two copies of.
 *
 * It was two copies for one commit, and registration simply had no handler at
 * all — the page called an address that did not exist and reported "something
 * went wrong" to somebody trying to open an account. Found by driving the
 * built app in a browser, not by a type or a test.
 */
export async function exchangeForCookie(
  path: string,
  body: unknown,
  // REQUIRED, so the compiler refuses a call site that forgot it. An optional
  // one would let the address-forwarding this function depends on be dropped
  // silently, which is exactly how it came to be missing in the first place.
  request: Request,
): Promise<NextResponse> {
  /*
   * A failed fetch is an OUTAGE, not a bad request.
   *
   * Letting it throw hands the customer Next's own error page, complete with a
   * stack and the API's internal address — while the client, which is watching
   * for a JSON error code, falls through to "something went wrong". 502 with a
   * code the client already knows is both safer and more truthful.
   */
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // THE MOST IMPORTANT HEADER ON THIS PATH. Sign-in is the endpoint whose
        // per-IP bucket is tightest, so it is the one that lumps every web
        // customer together hardest. See `forwardedFor`.
        ...forwardedFor(request),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ error: 'unknown' }, { status: 502 });
  }

  const payload: unknown = await upstream.json().catch(() => undefined);
  if (!upstream.ok) {
    // Passed through unchanged. The API's codes are what the client switches
    // on, and rewriting one here would mean a customer with a weak password
    // being told something else.
    return NextResponse.json(payload ?? { error: 'unknown' }, { status: upstream.status });
  }

  const record = payload as Record<string, unknown>;
  const refresh = record['refresh_token'];
  if (typeof refresh !== 'string') {
    // 502 rather than passing the body along: the API answered success without
    // the credential that makes the session work, and handing the page a
    // half-session would fail later and somewhere less obvious.
    return NextResponse.json({ error: 'unknown' }, { status: 502 });
  }

  const response = NextResponse.json({
    access_token: record['access_token'],
    expires_in: record['expires_in'],
  });
  response.cookies.set(REFRESH_COOKIE, refresh, COOKIE_OPTIONS);
  return response;
}
