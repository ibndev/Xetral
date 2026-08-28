import { ApiError } from '@xetral/client';
import type { ApiErrorCode } from '@xetral/client';

/**
 * What to actually put on the screen.
 *
 * The API's codes are precise and unreadable, and a customer seeing
 * `insufficient_funds` learns less than one seeing a sentence. Note what is
 * NOT here: any attempt to say how much they have. The API deliberately does
 * not send a figure, and inventing one on the client would undo the reason.
 */
export function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';

  switch (error.code) {
    case 'invalid_credentials':
      return 'That email or password is not right.';
    case 'invalid_pin':
      return 'That PIN is not right.';
    case 'pin_locked':
      return 'Your PIN is locked after too many attempts. Try again in 15 minutes.';
    case 'pin_not_set':
      return 'Set a transaction PIN before moving money.';
    case 'weak_pin':
      // The server's detail names the rule that was broken — six digits, not
      // a repeated digit, not a run — and that is exactly what someone needs
      // in order to pick another. It describes the policy, never the PIN.
      return error.detail ?? 'That PIN is not allowed. Use six digits that are not a simple pattern.';
    case 'transaction_pin_required':
      return 'Enter your transaction PIN.';
    case 'consent_not_withdrawable':
      // The honest answer rather than a silent failure. Withdrawing the terms
      // is closing the account, which moves money and has its own path.
      return 'You cannot withdraw this while your account is open. Close the account instead.';
    case 'erasure_blocked':
      // ONE MESSAGE for two reasons, matching the API. The other reason is an
      // open investigation, and telling a customer that is an offence — so
      // the wording has to be true of a balance and say nothing about the
      // other case.
      return 'We cannot action this while your account still holds money or is under review. Empty the account and try again, or contact support.';
    case 'request_already_open':
      return 'You already have a request open. We will answer it by the date shown.';
    case 'request_not_found':
      return 'That request is no longer open.';
    case 'consent_document_missing':
      // An operator's problem, not the customer's — and saying so is better
      // than blaming them for a document nobody published.
      return 'We cannot record that right now. Please try again shortly.';
    case 'insufficient_funds':
      return 'Your balance will not cover this.';
    case 'invalid_amount':
      return 'That amount is not valid.';
    case 'invalid_address':
      return 'That address does not look right. Check every character.';
    case 'rate_limited':
      return 'Too many attempts. Wait a moment and try again.';
    case 'kyc_required':
      // The server's detail names the PRODUCT the customer was reaching for
      // — "Identity verification is required for a USD card." A bare "finish
      // verification first" is a dead end: it does not say why, for what, or
      // that most of the product works without it. Screens that can should
      // render <VerifyPrompt> instead of this string, because this one still
      // cannot offer a way forward.
      return error.detail ?? 'Verify your identity to use this.';
    case 'device_not_found':
      return 'That device is not on your account.';
    case 'account_not_active':
      return 'This account cannot make transactions right now.';
    case 'gift_cards_disabled':
      return 'Gift cards are not available yet.';
    // Paused by an operator, usually because a provider is having an incident.
    // Worth saying "right now" — this is temporary and retrying later works,
    // which is not true of the refusals around it.
    case 'crypto_disabled':
      return 'Crypto is paused right now. Your balance is safe — try again shortly.';
    case 'fx_disabled':
      return 'Currency conversion is paused right now. Try again shortly.';
    case 'cards_disabled':
      return 'New cards and card funding are paused right now. Your existing cards still work.';
    case 'bills_disabled':
      return 'Airtime and bill payments are paused right now. Try again shortly.';
    case 'service_not_configured':
      return 'That service is unavailable right now.';
    case 'forbidden':
      return 'You do not have access to that.';
    case 'network':
      return 'No connection. Check your network and try again.';
    case 'invalid_request':
      return error.fields.length > 0
        ? `Check these fields: ${error.fields.join(', ')}.`
        : 'Some details are missing or invalid.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * The API's code for an error, or undefined if it did not come from the API.
 *
 * Paired with `messageFor`: the sentence is what a customer reads, the code is
 * what a screen branches on. Some refusals are not a line of red text —
 * `kyc_required` wants a whole panel with a way forward — and without the code
 * a caller would have to match on the message it was just handed, which breaks
 * the moment anyone rewords it.
 */
export function codeOf(error: unknown): ApiErrorCode | undefined {
  return error instanceof ApiError ? error.code : undefined;
}
