import type { NextResponse } from 'next/server';
import { exchangeForCookie } from '@/lib/auth-exchange';

/**
 * Sign in, and keep the refresh token out of the browser.
 *
 * The page posts credentials here; the exchange calls the API, puts the
 * REFRESH token in an httpOnly cookie, and returns only the short-lived access
 * token — so the long-lived credential never exists anywhere the page's
 * JavaScript can read it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => undefined);
  return exchangeForCookie('/v1/auth/login', body, request);
}
