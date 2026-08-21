import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/config';

/**
 * A same-origin proxy to the API.
 *
 * Everything the page calls goes through here, which buys two things. The
 * browser never makes a cross-origin request, so there is no CORS policy to
 * get subtly wrong; and the API's address is never published to the page, so a
 * future change cannot quietly start calling it directly and skip the cookie
 * handling in the auth routes.
 *
 * The bearer token IS forwarded from the page — it is short-lived by design
 * and the page legitimately holds it. The refresh token never passes through
 * here.
 */
async function forward(request: Request, path: string[]): Promise<NextResponse> {
  const url = new URL(request.url);
  const target = `${apiBaseUrl()}/${path.join('/')}${url.search}`;

  const authorization = request.headers.get('authorization');
  const body = request.method === 'GET' ? undefined : await request.text();

  // An unreachable API is a 502 with a code the client understands, not Next's
  // error page with a stack and this deployment's internal address on it.
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: {
        'content-type': 'application/json',
        ...(authorization === null ? {} : { authorization }),
      },
      ...(body === undefined || body === '' ? {} : { body }),
    });
  } catch {
    return NextResponse.json({ error: 'unknown' }, { status: 502 });
  }

  /*
   * A 204 CARRIES NO BODY, and saying otherwise throws.
   *
   * `NextResponse.json(x, { status: 204 })` is a response with a body and a
   * status that forbids one, which fails inside the runtime and surfaces as a
   * 500 from this proxy — for a request the API answered perfectly.
   *
   * Three endpoints answer 204: sign-out, SET TRANSACTION PIN, and VERIFY
   * TRANSACTION PIN. So on the web app a customer could not set a PIN, and
   * without a PIN they cannot move any money at all. Every type checked and
   * every test passed; it took driving the built app in a browser to see it.
   */
  if (upstream.status === 204 || upstream.status === 205) {
    return new NextResponse(null, { status: upstream.status });
  }

  const payload: unknown = await upstream.json().catch(() => undefined);
  return NextResponse.json(payload ?? {}, { status: upstream.status });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return forward(request, (await context.params).path);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return forward(request, (await context.params).path);
}
