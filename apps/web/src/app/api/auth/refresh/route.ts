import { NextResponse } from 'next/server';
import { apiBaseUrl, COOKIE_OPTIONS, REFRESH_COOKIE } from '@/lib/config';

/**
 * Rotate.
 *
 * The refresh token is read from the cookie and never travels through the
 * page, and the ROTATED one replaces it here. Note what happens on failure:
 * the cookie is cleared. A refresh that fails is a session that is over —
 * often because the device family was revoked after somebody replayed a stolen
 * token — and leaving a dead cookie in place only produces a retry loop.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REFRESH_COOKIE}=`));

  const token = cookie?.slice(REFRESH_COOKIE.length + 1);
  if (token === undefined || token === '') {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 401 });
  }

  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: decodeURIComponent(token) }),
  });

  const payload: unknown = await upstream.json().catch(() => undefined);

  if (!upstream.ok) {
    const dead = NextResponse.json(payload ?? { error: 'invalid_grant' }, {
      status: upstream.status,
    });
    dead.cookies.delete(REFRESH_COOKIE);
    return dead;
  }

  const record = payload as Record<string, unknown>;
  const rotated = record['refresh_token'];
  if (typeof rotated !== 'string') {
    return NextResponse.json({ error: 'unknown' }, { status: 502 });
  }

  const response = NextResponse.json({
    access_token: record['access_token'],
    expires_in: record['expires_in'],
  });
  response.cookies.set(REFRESH_COOKIE, rotated, COOKIE_OPTIONS);
  return response;
}
