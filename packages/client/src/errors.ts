/**
 * What the API said went wrong, as a type a caller can switch on.
 *
 * The API answers `{ "error": "insufficient_funds" }` and nothing else — no
 * balance, no limit, no "you have ₦4,300". That is deliberate on the server
 * side and it constrains the client: there is no figure to show, so a screen
 * that wants one has to fetch the balance separately and openly, rather than
 * reading it out of an error a stolen session could farm.
 */

/**
 * The codes, ONCE.
 *
 * The union and the recognition set are derived from this array rather than
 * written twice. They were two hand-maintained lists and had already drifted:
 * the API emits seventy codes and the union named eighteen, so a customer who
 * chose a weak password, or sent to themselves, or hit a frozen card, saw
 * "Something went wrong. Please try again." — a sentence that is never true
 * and never actionable. Adding a code in one place now adds it in both.
 *
 * `network`, `rate_limited` and `unknown` are deliberately NOT here. All three
 * are OURS: `network` is raised when the fetch itself fails, `rate_limited` is
 * synthesised from a 429 whose body we did not recognise, and `unknown` is the
 * floor everything else falls to. Putting any of them in this list would let a
 * server — or a proxy, or an error page — claim one. The API's own limiter
 * answers `too_many_attempts`, which IS here.
 */
const API_ERROR_CODES = [
  /* session and credentials */
  'invalid_credentials',
  'invalid_token',
  'invalid_grant',
  'weak_password',
  'email_taken',
  'registration_closed',
  'too_many_attempts',

  /* the transaction PIN */
  'invalid_pin',
  'pin_locked',
  'pin_not_set',
  'weak_pin',
  'transaction_pin_required',
  'current_pin_required',

  /* the account itself */
  'account_not_active',
  'account_closed',
  'kyc_required',
  'device_not_found',
  'below_minimum_age',
  'forbidden',

  /* money */
  'insufficient_funds',
  'invalid_amount',
  'invalid_address',
  'invalid_request',
  'below_minimum',
  'unsupported_currency',

  /* transfers */
  'cannot_transfer_to_self',
  'recipient_is_sender',
  'recipient_not_found',
  'recipient_not_active',

  /* purchases */
  'purchase_failed',
  'purchase_not_found',
  'verification_not_supported',

  /* cards */
  'card_frozen',
  'card_not_found',
  'card_terminated',
  'card_provider_not_configured',

  /* funding */
  'account_issue_pending',
  'deposit_not_found',
  'funding_provider_not_configured',

  /* crypto */
  'withdrawal_not_found',
  'unsupported_transport',
  'fee_moved',
  'crypto_provider_not_configured',

  /* fx */
  'pair_not_supported',
  'same_currency',
  'rate_moved',
  'fx_failed',
  'fx_outcome_unknown',
  'trade_not_found',
  'fx_provider_not_configured',

  /* gift cards */
  'gift_cards_disabled',
  // The kill switches. Each names its service so a screen can say which part
  // of the product is paused rather than showing one generic message.
  'crypto_disabled',
  'fx_disabled',
  'cards_disabled',
  'bills_disabled',
  'no_rate_for_card',
  'not_clawable',
  'not_convertible',
  'payout_would_be_zero',
  'submission_not_found',
  'already_reviewed',
  'cannot_review_own_submission',

  /* operations */
  'service_not_configured',
  'setting_not_found',
  'invalid_setting',
  'invalid_role',
  'already_granted',
  'grant_not_found',
  'cannot_grant_to_self',
  'already_in_status',
  'user_not_found',
  'not_in_suspense',
  'daily_limit_exceeded',
] as const;

export type ApiErrorCode =
  | (typeof API_ERROR_CODES)[number]
  | 'network'
  | 'rate_limited'
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
    return USER_FIXABLE.has(this.code);
  }
}

const USER_FIXABLE: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'invalid_pin',
  'insufficient_funds',
  'invalid_amount',
  'invalid_address',
  'invalid_request',
  'invalid_credentials',
  'weak_password',
  'weak_pin',
  'email_taken',
  'cannot_transfer_to_self',
  'recipient_is_sender',
  'recipient_not_found',
  'below_minimum',
  'daily_limit_exceeded',
  'fee_moved',
  'rate_moved',
]);

/** The session is gone and the customer must sign in again. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super('invalid_token', 401);
    this.name = 'SessionExpiredError';
  }
}

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

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

/** The codes, for a test that checks the API cannot emit one the client
 *  silently flattens to `unknown`. Not for switching on — use the type. */
export function knownErrorCodes(): readonly string[] {
  return API_ERROR_CODES;
}
