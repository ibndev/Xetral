import { NextResponse } from 'next/server';
import { apiBaseUrl, REFRESH_COOKIE } from '@/lib/config';

export async function POST(request: Request): Promise<NextResponse> {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REFRESH_COOKIE}=`));
  const token = cookie?.slice(REFRESH_COOKIE.length + 1);

  // The cookie goes regardless of what the API says. A customer who pressed
  // sign out must end up signed out on this device even if the network call
  // fails — the same ordering the client library uses.
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(REFRESH_COOKIE);

  if (token !== undefined && token !== '') {
    const authorization = request.headers.get('authorization');
    await fetch(`${apiBaseUrl()}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify({ refresh_token: decodeURIComponent(token) }),
    }).catch(() => undefined);
  }

  return response;
}
