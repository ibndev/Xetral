/**
 * Who actually receives customer data, and exactly what reaches them.
 *
 * THE OLD LIST WAS WRONG IN BOTH DIRECTIONS, and that is worse than a vague
 * one. It named Bitnob, VTpass, Airalo, Twilio and Resend. Read against the
 * adapters:
 *
 *   - `Resend` IS NOT IN THIS CODEBASE. `packages/providers/src/brevo/` is the
 *     live notification adapter and has been since 048. The notice named a
 *     company that receives nothing because it is not called.
 *   - `Airalo` and `Twilio` RECEIVE NO PERSONAL DATA. Read the bodies:
 *     Airalo gets `{ package_id, quantity, description: "xetral:<ref>" }` and
 *     Twilio gets `{ PhoneNumber: <the number being bought>, FriendlyName:
 *     "xetral:<ref>" }`. The reference is ours and opaque. Naming them as data
 *     recipients overstates what leaves.
 *   - `Paystack` WAS ABSENT, and it is the DEFAULT funding rail — the one
 *     provider almost every Nigerian customer's name, email and phone number
 *     actually goes to. The recipient most customers had was the one the
 *     notice did not mention.
 *   - `Flutterwave` and `Expo` were absent too.
 *
 * SO THIS IS DERIVED FROM THE SEND PATH, NOT FROM THE PROVIDER LIST. A
 * provider this platform integrates with is not automatically a recipient of
 * personal data, and `legal-processors.test.ts` checks the claim in both
 * directions: every name here must have an adapter directory, and every
 * adapter that is not listed here must be listed as sending nothing.
 *
 * WHAT NOBODY RECEIVES IS THE PART WORTH READING. No identity document, date
 * of birth or BVN reaches any provider. `kyc.service.ts` mints
 * `provider_customers.provider_customer_id` as `xetral-<uuid>` — a string we
 * invent — and makes no provider call at all; Paystack's
 * `/customer/:code/identification`, which is where a BVN would go, is declared
 * in the endpoint table and CALLED FROM NOWHERE. Verification happens here,
 * against documents sealed here, reviewed by people here.
 */
export interface Processor {
  /** The company, as it trades. */
  readonly name: string;
  /** The adapter directory under `packages/providers/src/`, for the guard. */
  readonly adapter: string;
  /** What they do for a customer, in the customer's terms. */
  readonly purpose: string;
  /** Exactly what is sent. Written from the request body, not from memory. */
  readonly receives: string;
}

/** Providers that receive something identifying about a customer. */
export const PROCESSORS: readonly Processor[] = [
  {
    name: 'Paystack',
    adapter: 'paystack',
    purpose:
      'Naira account numbers, card and bank checkouts, and transfers out to a Nigerian bank',
    receives:
      'Your name, email address and phone number, so an account number can be ' +
      'opened in your name. For a transfer out, the destination account number ' +
      'and the name the receiving bank returns for it.',
  },
  {
    name: 'Flutterwave',
    adapter: 'flutterwave',
    purpose: 'Mobile money in Ghana and Kenya — money in and money out',
    receives:
      'The wallet number money is going to, and a label naming the network. ' +
      'For a payment to Kenya, cross-border rules require the sender to be ' +
      'named, so your name, country and phone number are sent with it. When ' +
      'somebody pays you through a payment link, their own email address.',
  },
  {
    name: 'Bitnob',
    adapter: 'bitnob',
    purpose: 'Virtual dollar cards, crypto, stablecoins and currency conversion',
    receives:
      'A reference that identifies you to them and means nothing outside their ' +
      'system, plus the amount and currency of each instruction. Card details ' +
      'are fetched from them when you ask to see your card; they are not sent ' +
      'to them by us and not stored by us.',
  },
  {
    name: 'VTpass',
    adapter: 'vtpass',
    purpose: 'Airtime, data, electricity and TV subscriptions',
    receives:
      'The phone number, meter number or smartcard number you are paying for, ' +
      'and the amount. That is the number being topped up, which may be yours ' +
      'or somebody else’s — it is not otherwise linked to your account.',
  },
  {
    name: 'Brevo',
    adapter: 'brevo',
    purpose: 'The emails we send you',
    receives:
      'Your email address and the message itself — a receipt, a security ' +
      'alert or a password reset code.',
  },
  {
    name: 'Expo',
    adapter: 'expo',
    purpose: 'Push notifications to your phone',
    receives:
      'The notification address your handset generates, and the words of the ' +
      'notification. A notification is read off a lock screen, so we never put ' +
      'an amount or a balance in one.',
  },
] as const;

/**
 * Providers we integrate with that receive nothing that identifies anybody.
 *
 * LISTED RATHER THAN OMITTED, because "who do you share data with" and "whose
 * software is in the path" are different questions and a reader cannot tell
 * which one a short list answered. Each of these is named in the app — a
 * customer who buys an eSIM knows Airalo is involved — so silence here reads
 * as an omission rather than as a statement.
 */
export const NON_PROCESSORS: readonly Processor[] = [
  {
    name: 'Airalo',
    adapter: 'airalo',
    purpose: 'eSIM data packages',
    receives:
      'A product code and an order reference of ours. No name, no email, no ' +
      'phone number.',
  },
  {
    name: 'Twilio',
    adapter: 'twilio',
    purpose: 'Virtual phone numbers',
    receives:
      'The number being purchased and an order reference of ours. Not your ' +
      'own number, and nothing that names you.',
  },
  {
    name: 'ExchangeRate-API',
    adapter: 'exchangerate',
    purpose: 'Reference exchange rates',
    receives: 'Currency codes. Nothing about any customer, ever.',
  },
] as const;
