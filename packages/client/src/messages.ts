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

  return withReference(sentenceFor(error), error);
}

/**
 * A REPORT THAT CAN BE ACTED ON, rather than one that can only be repeated.
 *
 * "Something went wrong. Please try again." is a true sentence about every
 * 500 there has ever been, which makes it useless in exactly the moment it
 * appears: two unrelated endpoints failing for two unrelated reasons say the
 * identical thing, so nobody reading a screenshot can tell whether they are
 * looking at one bug or two, and the only available next step is guessing.
 *
 * The reference is minted by the API for every 5xx and written into the same
 * log line as the exception. It names nothing — not a table, not a provider,
 * not a credential — so it is safe on a customer's screen, and it turns an
 * unsearchable sentence into one grep. Appended only when the API sent one,
 * so no wording changes for the refusals that already explain themselves.
 */
function withReference(sentence: string, error: ApiError): string {
  return error.reference === undefined ? sentence : `${sentence} (reference ${error.reference})`;
}

function sentenceFor(error: ApiError): string {
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
    /*
     * OPENING A NAIRA ACCOUNT, and the three answers are deliberately
     * different. `account_issue_pending` is "we do not know yet"; the other
     * two are ours to fix and say so, rather than telling a customer to try
     * again at something that will keep failing until an operator acts.
     */
    case 'account_issue_pending':
      return 'Your account is being opened. Check back in a moment.';
    case 'account_issue_refused':
    case 'account_issue_unavailable':
      return 'We could not open your account number just now. We are on it — try again shortly.';
    case 'funding_provider_not_configured':
      return 'Adding money is not available yet.';
    /* ------------------------------------------------------------------ *
     * SEVENTY-EIGHT CODES THAT SAID NOTHING.
     *
     * Every one of these was in the union, typechecked everywhere, and fell
     * through the `default` to "Something went wrong. Please try again." — a
     * sentence that is grammatical, reassuring and completely uninformative,
     * and which therefore also hides every OTHER failure behind itself.
     *
     * The instance that found them: an administrator pressed Approve on an
     * identity submission holding a correct PIN and a correct authenticator
     * code, and was told something had gone wrong. The API was answering
     * `cannot_review_own_submission` — a correct refusal, enforced by a CHECK
     * on the table, because nobody may approve their own documents. That code
     * had no words, so the one sentence that would have ended it in a second
     * was replaced by the one sentence that sends somebody hunting a bug.
     *
     * `message-coverage.test.ts` fails the build on a code with no case, and
     * on a case that returns the generic sentence anyway.
     * ------------------------------------------------------------------ */

    /* session and credentials */
    case 'invalid_token':
    case 'invalid_grant':
      // Both mean the session is over. A customer does not need to know which
      // — and `invalid_grant` in particular is what a REPLAYED refresh token
      // answers, which is a security event we do not narrate to whoever
      // triggered it.
      return 'Your session has ended. Sign in again.';
    case 'weak_password':
      return error.detail ?? 'That password is too easy to guess. Use at least eight characters with a mix of letters and numbers.';
    case 'email_taken':
      return 'An account already exists for that email address. Sign in, or reset your password.';
    case 'registration_closed':
      return 'New accounts are not being accepted at the moment.';
    case 'too_many_requests':
      // "You are going too fast", NOT "we have blocked this account". Showing
      // the same words for both tells a customer whose app retried eagerly
      // that their sign-in has been stopped.
      return 'You are going a bit fast. Wait a moment and try again.';
    case 'too_many_attempts':
      // Distinct from `too_many_requests` on purpose: this one means "we have
      // stopped accepting guesses at this account", which is a different fact
      // and needs different words.
      return 'Too many attempts. Wait fifteen minutes and try again.';
    case 'password_reset_unavailable':
      // NOT user-fixable, and the words must not send somebody round a loop
      // that cannot end. Nothing they type changes this. It now means one
      // thing only — no email provider is configured — because a reset is a
      // CODE and no longer needs this deployment to know its own address.
      return 'Password resets are unavailable right now. Contact support.';
    case 'reset_code_attempts':
      // Names the way out. "Invalid code" would be true and would leave
      // somebody retyping a code that can never work again.
      return 'Too many incorrect codes. Ask for a new one and try again.';
    case 'current_pin_required':
      return 'Enter your current PIN to change it.';
    case 'account_closed':
      return 'This account is closed. Contact support.';
    case 'internal_error':
      // The one place the generic sentence is the whole truth: something threw
      // that nothing expected, so there is nothing more specific to say. The
      // reference appended below is what makes it reportable.
      return 'Something went wrong on our side.';

    /* identity */
    case 'already_verified':
      return 'Your identity is already verified.';
    case 'review_in_progress':
      return 'Your identity is being reviewed. We will let you know when it is done.';
    case 'below_minimum_age':
      return 'You must be at least eighteen to open an account.';
    case 'submission_not_found':
      return 'That identity submission no longer exists.';
    case 'already_reviewed':
      return 'Somebody has already reviewed this one.';
    case 'cannot_review_own_submission':
      // THE ONE THAT FOUND THIS WHOLE CLASS. A reviewer may not approve their
      // own documents — a CHECK on the table, not a preference — and an
      // administrator who is also the platform's first customer meets it on
      // their own submission. Saying so ends it; "something went wrong" sends
      // them looking for a bug that is not there.
      return 'You cannot review your own submission. Another member of staff has to approve it.';
    case 'bvn_already_verified':
      return 'That BVN is already verified on another account. Open the collisions list before deciding.';
    case 'tier_skips_evidence':
      return 'A tier rests on the one below it. Verify their identity before granting enhanced limits.';

    /* moving money */
    case 'below_minimum':
      return error.detail ?? 'That amount is below the minimum.';
    case 'unsupported_currency':
      return 'That currency is not supported here.';
    case 'cannot_transfer_to_self':
    case 'recipient_is_sender':
      return 'You cannot send money to yourself.';
    case 'recipient_not_found':
      // The API answers this for an unknown handle AND an unknown email, and
      // deliberately does not distinguish them — a different answer would say
      // which handles exist.
      return 'We could not find that person. Check the handle or email address.';
    case 'recipient_not_active':
      return 'That account cannot receive money at the moment.';
    case 'daily_limit_exceeded':
      return 'That would take you past your daily limit. Verifying your identity raises it.';
    case 'too_many_new_recipients':
      // Worded so a customer who did NOT do this is told what it means. This
      // rule fires on an account takeover as often as on a busy day.
      return 'You have paid a lot of new people today. If that was not you, change your password now.';
    case 'too_many_transfers':
      return 'Too many transfers in a short time. Wait an hour and try again.';
    case 'profile_incomplete':
      return error.fields.length > 0
        ? `Add your ${error.fields.join(', ')} before continuing.`
        : 'Some details are missing from your profile.';
    case 'account_not_found':
    case 'not_found':
      return 'We could not find that.';
    case 'recovery_unavailable':
      return 'Recovery is not available on this deployment yet — migration 049 has not been applied.';
    case 'not_recoverable':
      return 'That is no longer waiting to be recovered. Reload the queue.';

    /* purchases */
    case 'purchase_failed':
      return 'That purchase did not go through. You have not been charged.';
    case 'purchase_not_found':
      return 'We could not find that purchase.';
    case 'verification_not_supported':
      return 'This one cannot be checked before you buy.';

    /* cards */
    case 'card_frozen':
      return 'This card is frozen. Unfreeze it to spend.';
    case 'card_not_found':
      return 'We could not find that card.';
    case 'card_terminated':
      return 'This card has been closed and cannot be used again.';
    case 'card_provider_not_configured':
      return 'Cards are not available yet.';
    case 'too_many_reveals':
      return 'You have looked at card details too many times. Try again later.';

    /* crypto */
    case 'deposit_not_found':
      return 'We could not find that deposit.';
    case 'withdrawal_not_found':
      return 'We could not find that withdrawal.';
    case 'unsupported_transport':
      return 'That network is not supported for this asset.';
    case 'fee_moved':
      // Part of CONSENT: the fee changed between the quote and the request, so
      // the customer has not agreed to what they would now pay.
      return 'The network fee changed. Check the new one and try again.';
    case 'crypto_provider_not_configured':
      return 'Crypto is not available yet.';

    /* exchange */
    case 'pair_not_supported':
      return 'We do not exchange between those two currencies.';
    case 'same_currency':
      return 'Those are the same currency.';
    case 'rate_moved':
      return 'The rate changed. Check the new one and try again.';
    case 'fx_failed':
      return 'That exchange did not go through. Nothing has been taken.';
    case 'fx_outcome_unknown':
      // The one honest answer to a timeout on a swap: we do not know, and
      // saying either "done" or "failed" would be a guess about money.
      return 'We are still confirming that exchange. Check your balance in a moment before retrying.';
    case 'trade_not_found':
      return 'We could not find that exchange.';
    case 'fx_provider_not_configured':
      return 'Currency exchange is not available yet.';

    /* payouts */
    case 'payout_provider_not_configured':
      return 'Bank transfers are not available yet.';
    case 'payouts_disabled':
      return 'Bank transfers are switched off at the moment.';

    /* gift cards */
    case 'no_rate_for_card':
      return 'We are not buying that card at the moment.';
    case 'not_clawable':
      return 'This payment has already been released and cannot be reversed.';
    case 'not_convertible':
      return 'That cannot be converted.';
    case 'payout_would_be_zero':
      return 'That value is too small to pay out at the current rate.';

    /* disputes */
    case 'entry_not_found':
      // Deliberately the same answer for "not yours" and "does not exist" —
      // distinguishing them turns the complaints form into a way to enumerate
      // other people's transactions.
      return 'We could not find that transaction.';
    case 'dispute_already_open':
      return 'You already have an open dispute for that transaction.';
    case 'dispute_window_closed':
      // The deadline is the database's clock and cannot be moved, so the words
      // must not imply that asking will help.
      return 'It is too late to dispute that transaction. Contact support.';
    case 'dispute_not_found':
      return 'We could not find that dispute.';
    case 'dispute_not_open':
      return 'That dispute has already been decided.';

    /* operations */
    case 'credential_not_found':
      return 'There is no such credential slot.';
    case 'setting_not_found':
      return 'There is no such setting.';
    case 'invalid_setting':
      return error.detail ?? 'That value is outside what this setting allows. Check the units.';
    case 'invalid_role':
      return 'There is no such role.';
    case 'already_granted':
      return 'They already have that role.';
    case 'grant_not_found':
      return 'They do not have that role.';
    case 'cannot_grant_to_self':
      return 'You cannot grant a role to yourself.';
    case 'already_in_status':
      return 'This account is already in that state.';
    case 'user_not_found':
      return 'We could not find that customer.';
    case 'not_in_suspense':
      return 'That deposit is not in suspense.';
    case 'signal_not_found':
      return 'We could not find that signal.';
    case 'case_not_found':
      return 'We could not find that case.';
    case 'case_already_open':
      return 'There is already an open case for this customer. Add to that one.';
    case 'case_closed':
      return 'That case is closed. New information opens a new case.';
    case 'report_reference_required':
      return 'A report needs its reference. A filing nobody can point at is one nobody can prove was made.';
    case 'signal_not_this_customer':
      return 'That signal belongs to a different customer.';
    case 'not_an_erasure_request':
      return 'That request is not an erasure request.';

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
