/**
 * What the API said went wrong, as a type a caller can switch on.
 *
 * The API answers `{ "error": "insufficient_funds" }` and nothing else — no
 * balance, no limit, no "you have ₦4,300". That is deliberate on the server
 * side and it constrains the client: there is no figure to show, so a screen
 * that wants one has to fetch the balance separately and openly, rather than
 * reading it out of an error a stolen session could farm.
 */

export type ApiErrorCode =
  | 'invalid_credentials'
  | 'invalid_token'
  | 'invalid_grant'
  | 'invalid_pin'
  | 'pin_locked'
  | 'pin_not_set'
  | 'transaction_pin_required'
  | 'insufficient_funds'
  | 'invalid_request'
  | 'invalid_amount'
  | 'invalid_address'
  | 'rate_limited'
  | 'kyc_required'
  | 'forbidden'
  | 'account_not_active'
  | 'gift_cards_disabled'
  | 'service_not_configured'
  | 'network'
  | 'unknown';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    /** Field paths only, never values — the API never echoes a body back,
     *  because those bodies carry PINs and card codes. */
    readonly fields: readonly string[] = [],
    readonly detail?: string,
  ) {
    super(`${code}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'ApiError';
  }

  /**
   * Is this worth showing a customer as their own mistake?
   *
   * Used to decide between "check what you typed" and "something went wrong on
   * our side" — a distinction customers notice and which changes whether they
   * retry or give up.
   */
  get isUserFixable(): boolean {
    return (
      this.code === 'invalid_pin' ||
      this.code === 'insufficient_funds' ||
      this.code === 'invalid_amount' ||
      this.code === 'invalid_address' ||
      this.code === 'invalid_request' ||
      this.code === 'invalid_credentials'
    );
  }
}

/** The session is gone and the customer must sign in again. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super('invalid_token', 401);
    this.name = 'SessionExpiredError';
  }
}

const KNOWN = new Set<string>([
  'invalid_credentials', 'invalid_token', 'invalid_grant', 'invalid_pin',
  'pin_locked', 'pin_not_set', 'transaction_pin_required', 'insufficient_funds',
  'invalid_request', 'invalid_amount', 'invalid_address', 'rate_limited',
  'kyc_required', 'forbidden', 'account_not_active', 'gift_cards_disabled',
  'service_not_configured',
]);

/**
 * Reads an error body without trusting its shape.
 *
 * An unrecognised code becomes `unknown` rather than being passed through, so
 * a caller's switch cannot be widened by whatever a proxy or an error page
 * happened to return.
 */
export function toApiError(status: number, body: unknown): ApiError {
  if (typeof body !== 'object' || body === null) {
    return new ApiError(status === 429 ? 'rate_limited' : 'unknown', status);
  }

  const record = body as Record<string, unknown>;
  const raw = typeof record['error'] === 'string' ? record['error'] : undefined;
  const code: ApiErrorCode =
    raw !== undefined && KNOWN.has(raw)
      ? (raw as ApiErrorCode)
      : status === 429
        ? 'rate_limited'
        : 'unknown';

  const fields = Array.isArray(record['fields'])
    ? record['fields'].filter((f): f is string => typeof f === 'string')
    : [];
  const detail = typeof record['detail'] === 'string' ? record['detail'] : undefined;

  return new ApiError(code, status, fields, detail);
}
