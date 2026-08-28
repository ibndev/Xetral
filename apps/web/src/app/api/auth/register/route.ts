import type { NextResponse } from 'next/server';
import { exchangeForCookie } from '@/lib/auth-exchange';

/**
 * Open an account, and end up signed in.
 *
 * The same exchange as sign-in, for the same reason: registration returns a
 * token pair, and the refresh half of it must not reach the page. Sending a
 * customer to a sign-in form immediately after they chose a password would
 * also be the wrong product, but that is the smaller of the two reasons this
 * handler exists.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => undefined);
  return exchangeForCookie('/v1/auth/register', body, request);
}
