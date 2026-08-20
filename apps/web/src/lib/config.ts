/**
 * Where the API is, read once on the server.
 *
 * Deliberately NOT exposed as `NEXT_PUBLIC_`. The browser never talks to the
 * API directly — it goes through this app's route handlers, which hold the
 * refresh token in an httpOnly cookie the page's own JavaScript cannot read.
 * Publishing the API's address would invite a future change that skips them.
 */
export function apiBaseUrl(): string {
  const url = process.env['XETRAL_API_URL'];
  if (url === undefined || url === '') {
    throw new Error('XETRAL_API_URL is not set');
  }
  return url.replace(/\/+$/, '');
}

/** The cookie carrying the refresh token. */
export const REFRESH_COOKIE = 'xetral_refresh';

/** Cookie settings, in one place so no route can accidentally weaken them. */
export const COOKIE_OPTIONS = {
  // The whole point: script on the page cannot read it, so an injected script
  // cannot steal a session that outlives the tab.
  httpOnly: true,
  // Never sent on a cross-site request, so a form on another origin cannot
  // ride it.
  sameSite: 'strict',
  secure: process.env['NODE_ENV'] === 'production',
  path: '/',
  /** Matches the server's refresh token lifetime. */
  maxAge: 60 * 60 * 24 * 30,
} as const;
