import { NextResponse } from 'next/server';
import { apiBaseUrl, COOKIE_OPTIONS, REFRESH_COOKIE } from '@/lib/config';

/**
 * Sign in, and keep the refresh token out of the browser.
 *
 * The page posts credentials here; this handler calls the API, puts the
 * REFRESH token in an httpOnly cookie, and returns only the short-lived access
 * token to the page. So the long-lived credential never exists anywhere the
 * page's JavaScript can read it — which is the difference between an injected
 * script stealing fifteen minutes and stealing a month.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => undefined);

  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload: unknown = await upstream.json().catch(() => undefined);
  if (!upstream.ok) {
    return NextResponse.json(payload ?? { error: 'unknown' }, { status: upstream.status });
  }

  const record = payload as Record<string, unknown>;
  const refresh = record['refresh_token'];
  if (typeof refresh !== 'string') {
    return NextResponse.json({ error: 'unknown' }, { status: 502 });
  }

  // The access token and expiry go to the page; the refresh token does not.
  const response = NextResponse.json({
    access_token: record['access_token'],
    expires_in: record['expires_in'],
  });
  response.cookies.set(REFRESH_COOKIE, refresh, COOKIE_OPTIONS);
  return response;
}
