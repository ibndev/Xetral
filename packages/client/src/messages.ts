import { ApiError } from './errors.js';
import type { ApiErrorCode } from './errors.js';

/**
 * WHAT TO ACTUALLY PUT ON THE SCREEN, for every client.
 *
 * This lived twice — once in `apps/web` and once in `apps/mobile` — and the
 * copies had drifted to the point that TWENTY-FIVE codes the web explained
 * fell through to "Something went wrong. Please try again." on the phone.
 * Among them were `insufficient_funds`' neighbours, every kill switch, and all
 * five of the staff second factor: a customer on Android was told nothing had
 * gone wrong in particular while the same refusal on a laptop named itself.
 *
 * One list, in the package both apps already depend on. The same argument the
 * codebase makes about two rate-limit backends sharing one contract suite and
 * three fulfilment adapters sharing one: a second hand-written copy does not
 * stay a copy, and the one that drifts is the one nobody is looking at.
 *
 * Note what is NOT here: any attempt to say how much a customer has. The API
 * deliberately sends no figure with `insufficient_funds`, because returning
 * one turns a transfer endpoint into a balance oracle for a stolen session,
 * and inventing one on the client would undo that decision from the outside.
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
    case 'price_already_published':
      return 'A live price already exists for that. Retire it first — that is a separate step because it changes what customers are quoted.';
    case 'price_band_overlaps':
      return 'That band overlaps one that is already live. Retire the one it overlaps, or narrow this band.';
    case 'price_not_found':
      return 'That price is not live. It may already have been retired.';
    case 'invalid_price':
      return 'That price is outside what the platform allows. Check the units — spreads are basis points, amounts are minor units.';
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
    case 'feature_unavailable':
      // Names the product, not the schema. A customer cannot act on a missing
      // migration and should not be asked to try again at one.
      return 'That part of Xetral is not switched on yet. We are on it.';
    case 'country_not_supported':
      // One sentence for "no such country" and "not open there", because the
      // API answers the same for both.
      return 'Xetral is not open in that country yet.';
    case 'phone_taken':
      // NOT "that number is taken" alone: the likeliest reader typed their own
      // number correctly, so the sentence has to offer the way forward rather
      // than just refuse.
      return 'That phone number already has an account. Sign in instead.';
    case 'country_exists':
      return 'That country is already on the list.';
    case 'country_not_found':
      return 'No country with that code.';
    case 'country_not_covered':
      // The detail carries which ceiling or threshold is missing, and the
      // screen shows it — a generic refusal would send an operator to read
      // the migration.
      return 'That country cannot be opened until its currency has limits.';
    case 'currency_not_supported':
      return 'That currency needs a code change before a country can use it.';
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

    /*
     * THE STAFF SECOND FACTOR. All five fell through to "Something went wrong"
     * — including `totp_not_enrolled`, which every operations screen returns
     * until an operator confirms an authenticator. A newly granted operator
     * therefore saw a generic failure on every page of the dashboard, which is
     * indistinguishable from the dashboard being broken and is what it was
     * reported as.
     */
    case 'totp_not_enrolled':
      return 'Set up your authenticator app before using the operations dashboard.';
    case 'totp_required':
      return 'Enter the six-digit code from your authenticator app.';
    case 'invalid_totp':
      // Deliberately does not say whether the code was wrong or already used.
      // A code is single-use, and "already used" would tell somebody reading
      // it off a screen that they were a moment too late rather than wrong.
      return 'That code is not right. Codes change every 30 seconds and each one works once.';
    case 'totp_locked':
      return 'Too many wrong codes. Try again in 15 minutes.';
    case 'totp_already_enrolled':
      return 'An authenticator is already set up. Replacing it is an administrator action.';
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
