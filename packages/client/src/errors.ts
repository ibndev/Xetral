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
  /* The general ceiling on request rate, distinct from `too_many_attempts` and
     deliberately so: one means "we have stopped accepting guesses at this
     account", the other means "you are going too fast". A client that showed
     the same words for both would tell a customer whose app retried eagerly
     that their sign-in had been blocked. */
  'too_many_requests',
  /* Password reset is refused as a whole when the deployment has no email
     provider. NOT user-fixable: nothing the customer types changes it, and
     telling them to try again would send them round a loop that cannot end. */
  'password_reset_unavailable',

  /* The staff second factor. `totp_required` and `invalid_totp` ARE
     user-fixable — the operator opens their authenticator and reads the
     current code — while the other three describe the state of the enrolment
     and are fixed by an administrator, not by retrying. */
  'totp_required',
  'invalid_totp',
  'totp_locked',
  'totp_not_enrolled',
  'totp_already_enrolled',

  /* What the global filter answers when something threw that nothing in the
     codebase expected. Not user-fixable: nothing the customer types changes
     it, and the honest thing to show is that it was our fault. */
  'internal_error',

  /* Reading a card number too often. User-fixable in the sense that waiting
     clears it — and the customer is told to wait rather than told nothing,
     because the alternative is somebody concluding their card is broken. */
  'too_many_reveals',

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
  /* identity review. The first two were reaching customers with no name here
     at all: they are chosen by a ternary, which the API-side scanner could not
     see until it was taught to read one. */
  'already_verified',
  'review_in_progress',
  /* Consent. `consent_not_withdrawable` is the honest refusal for the terms
     and the privacy notice: withdrawing them is closing the account, which
     moves money and has its own path — a screen that just failed silently
     would read as a bug. `consent_document_missing` means nothing is
     published to agree TO, which is an operator's problem and not the
     customer's, so it needs its own words rather than "something went
     wrong". */
  'consent_not_withdrawable',
  'consent_document_missing',
  /* Data rights. `erasure_blocked` is deliberately one code for two very
     different reasons — a balance, or an open investigation — because the API
     answers them identically: tipping off is an offence, and a
     distinguishable refusal is a way to learn you are under review. */
  'erasure_blocked',
  'request_already_open',
  'request_not_found',
  'not_an_erasure_request',
  /* One person, one account. Answered to a REVIEWER at approval, never to the
     customer at submission — a form that said "that BVN is already
     registered" would confirm to anybody holding a stolen BVN that its owner
     banks here. */
  'bvn_already_verified',
  /* An operator pasting a key into a slot this platform does not know about.
     Refused rather than stored, because a credential nothing reads is one
     somebody believes is live. */
  'credential_not_found',
  /* A monitoring signal that does not exist, or that a colleague resolved
     first. One answer for both, so nobody learns which signal ids are real. */
  'signal_not_found',
  /* Compliance cases. `case_not_found` answers both "no such case" and
     "already closed", so a reviewer racing a colleague learns it is handled
     and nobody learns which case ids exist. */
  'case_not_found',
  'case_already_open',
  'case_closed',
  'report_reference_required',
  'signal_not_this_customer',
  /* A tier granted without the evidence of the one below it. Each tier rests
     on the one under it, so enhanced due diligence cannot be given to somebody
     whose identity was never checked. */
  'tier_skips_evidence',
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
  /* The velocity rules, which are about COUNT rather than amount: how many
     people a customer is paying for the first time today, and how many
     transfers they have sent in the last hour. Distinct codes because they
     want different words — "you have paid a lot of new people today" is
     actionable, "you hit a limit" is not — and because a customer who caused
     neither needs to be told that somebody else may be signed in as them. */
  'too_many_new_recipients',
  'too_many_transfers',

  /* Disputes. `entry_not_found` is deliberately the answer BOTH when an entry
     does not exist and when it belongs to somebody else — distinguishing them
     would turn the complaints form into a way to discover which transactions
     are real. */
  'entry_not_found',
  'dispute_not_found',
  'dispute_already_open',
  'dispute_not_open',
  'dispute_window_closed',
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
  'too_many_new_recipients',
  'too_many_transfers',
  /* A customer can act on both: raise it against the right entry, or open a
     new dispute rather than a second one against the same entry. */
  'dispute_already_open',
  'dispute_window_closed',
  'fee_moved',
  'rate_moved',
  'totp_required',
  'invalid_totp',
  'too_many_reveals',
  /* Waiting clears it, and the screen says so. */
  'too_many_requests',
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
