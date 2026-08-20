import { ApiError } from '@xetral/client';

/**
 * The same mapping the web app uses, and for the same reason: `pin_locked` is
 * precise and unreadable. Note what is absent — any attempt to say how much
 * the customer has. The API deliberately sends no figure with
 * `insufficient_funds`, and filling one in here would undo that.
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
