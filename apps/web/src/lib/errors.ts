import { ApiError } from '@xetral/client';

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
    case 'transaction_pin_required':
      return 'Enter your transaction PIN.';
    case 'insufficient_funds':
      return 'Your balance will not cover this.';
    case 'invalid_amount':
      return 'That amount is not valid.';
    case 'invalid_address':
      return 'That address does not look right. Check every character.';
    case 'rate_limited':
      return 'Too many attempts. Wait a moment and try again.';
    case 'kyc_required':
      return 'Finish identity verification first.';
    case 'account_not_active':
      return 'This account cannot make transactions right now.';
    case 'gift_cards_disabled':
      return 'Gift cards are not available yet.';
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
