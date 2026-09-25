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
 * personal data, and `legal-content.test.ts` checks the claim in both
 * directions: every adapter-backed name here must have an adapter directory,
 * and every adapter directory must appear in one of these lists.
 *
 * AND THEN A RECIPIENT TURNED UP THAT THE CODE CANNOT SEE AT ALL.
 *
 * DOJAH IS USED FOR IDENTITY VERIFICATION AND NOTHING IN THIS REPOSITORY
 * CALLS IT. `026_provider_credentials.seed.sql` holds three Dojah slots, every
 * one `in_use = FALSE`; there is no adapter directory, no client and no call
 * site. So verification happens the only way it can today — a reviewer reading
 * the submitted details and checking them at Dojah's own dashboard — and that
 * is a disclosure of a name, a date of birth and a BVN that NO AMOUNT OF
 * READING THE SEND PATH WOULD EVER HAVE FOUND. A notice derived only from code
 * is exactly as complete as the code, and a person typing a BVN into somebody
 * else's web page is outside it.
 *
 * THAT IS WHY `via` EXISTS RATHER THAN A NULLABLE `adapter`. A null would read
 * as an omission somebody forgot to fill in; `via: 'operator'` is a decision
 * with a reason attached, and the guard holds it to the OPPOSITE requirement —
 * an operator-backed entry must have NO adapter directory. The day a Dojah
 * adapter lands, that check goes red and the entry has to be reclassified,
 * which is the moment the notice would otherwise quietly stop describing how
 * the data gets there.
 *
 * AND THEN A BVN STARTED LEAVING THROUGH THE CODE, deliberately. Naira
 * account numbers moved to Flutterwave in 076, and Flutterwave will not open a
 * PERMANENT account without the customer's BVN. `FundingCustomer.bvn` is a
 * function so it is unsealed only when that adapter asks, and only from an
 * APPROVED submission. The page says so in the same sentence that names Dojah,
 * because a bold claim that one company receives it is the absolute-denial
 * shape 075 retired, one company wider.
 *
 * AND A SECOND ACCOUNT RAIL DOES THE SAME. Bitnob can be chosen for naira
 * account numbers too, and their documentation puts the BVN and a date of
 * birth that matches the registry on the Bitnob CUSTOMER — so for a verified
 * customer both are sent when that rail opens the account, and never for an
 * unverified one, whose account opens on a rail that needs neither.
 *
 * WHAT NOBODY ELSE RECEIVES IS STILL THE PART WORTH READING. Outside
 * verification and account opening at Flutterwave or Bitnob, no date of
 * birth, address or BVN reaches any provider.
 * `kyc.service.ts` mints `provider_customers.provider_customer_id` as
 * `xetral-<uuid>` — a string we invent — and makes no provider call at all;
 * Paystack's `/customer/:code/identification`, which is where a BVN would go,
 * is declared in the endpoint table and CALLED FROM NOWHERE.
 */

/** What a company does for a customer, and what of theirs reaches it. */
interface Disclosure {
  /** The company, as it trades. */
  readonly name: string;
  /** What they do for a customer, in the customer's terms. */
  readonly purpose: string;
  /** Exactly what is sent. Written from the request body, not from memory. */
  readonly receives: string;
}

/**
 * A company this platform's own code sends to.
 *
 * `adapter` is the directory under `packages/providers/src/`, and the guard
 * requires it to exist — `Resend` was named here for months and has never been
 * in this repository.
 */
export interface AdapterDisclosure extends Disclosure {
  readonly via: 'adapter';
  readonly adapter: string;
}

/**
 * A company a PERSON sends to, through that company's own dashboard.
 *
 * There is no code path, so there is nothing for the send-path derivation to
 * find — which is precisely why it has to be written down by hand, with the
 * reason, rather than left out because a grep came back empty.
 */
export interface OperatorDisclosure extends Disclosure {
  readonly via: 'operator';
  /**
   * The adapter directory that WOULD exist if this were integrated.
   *
   * Named rather than derived from `name`, so the guard watching for it is
   * reading a decision instead of guessing at a string. It is what turns "no
   * adapter" from an absence into an assertion the build can check.
   */
  readonly watchFor: string;
  /** Why no adapter, in a sentence a reviewer can check against the tree. */
  readonly why: string;
}

export type Processor = AdapterDisclosure | OperatorDisclosure;

/** Providers that receive something identifying about a customer. */
export const PROCESSORS: readonly Processor[] = [
  {
    via: 'operator',
    name: 'Dojah Inc.',
    purpose: 'Checking that you are who you say you are',
    receives:
      'Your name, date of birth and Bank Verification Number, so that they ' +
      'can be checked against the records they hold. Nothing about your ' +
      'balance, your transactions or anybody you pay.',
    watchFor: 'dojah',
    why:
      'No adapter: identity checks are run by our own reviewers at Dojah’s ' +
      'dashboard, so nothing in this codebase calls them. The credential ' +
      'slots in 026 are `in_use = FALSE` for that reason.',
  },
  {
    via: 'adapter',
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
    via: 'adapter',
    name: 'Flutterwave',
    adapter: 'flutterwave',
    purpose:
      'Naira account numbers, and mobile money in Ghana and Kenya — money in and money out',
    receives:
      'To open your naira account number: your name, email address, phone number ' +
      'and Bank Verification Number — a bank will not open a permanent account ' +
      'without one, so it is sent only once you are verified. ' +
      'For mobile money, the wallet number money is going to, and a label naming the network. ' +
      'For a payment to Kenya, cross-border rules require the sender to be ' +
      'named, so your name, country and phone number are sent with it. When ' +
      'somebody pays you through a payment link, their own email address.',
  },
  {
    via: 'adapter',
    name: 'Bitnob',
    adapter: 'bitnob',
    purpose:
      'Virtual dollar cards, crypto, stablecoins, currency conversion and, where it ' +
      'is the rail chosen, naira account numbers',
    receives:
      'For cards, crypto and conversion: a reference that identifies you to them ' +
      'and means nothing outside their system, plus the amount and currency of ' +
      'each instruction. To open your naira account number with them: your name, ' +
      'email address, phone number, date of birth and Bank Verification Number — ' +
      'they will not open a naira account without them, so this happens only once ' +
      'you are verified. Card details are fetched from them when you ask to see ' +
      'your card; they are not sent to them by us and not stored by us.',
  },
  {
    via: 'adapter',
    name: 'VTpass',
    adapter: 'vtpass',
    purpose: 'Airtime, data, electricity and TV subscriptions',
    receives:
      'The phone number, meter number or smartcard number you are paying for, ' +
      'and the amount. That is the number being topped up, which may be yours ' +
      'or somebody else’s — it is not otherwise linked to your account.',
  },
  {
    via: 'adapter',
    name: 'Brevo',
    adapter: 'brevo',
    purpose: 'The emails we send you',
    receives:
      'Your email address and the message itself — a receipt, a security ' +
      'alert or a password reset code.',
  },
  {
    via: 'adapter',
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
    via: 'adapter',
    name: 'Airalo',
    adapter: 'airalo',
    purpose: 'eSIM data packages',
    receives:
      'A product code and an order reference of ours. No name, no email, no ' +
      'phone number.',
  },
  {
    via: 'adapter',
    name: 'Twilio',
    adapter: 'twilio',
    purpose: 'Virtual phone numbers',
    receives:
      'The number being purchased and an order reference of ours. Not your ' +
      'own number, and nothing that names you.',
  },
  {
    via: 'adapter',
    name: 'ExchangeRate-API',
    adapter: 'exchangerate',
    purpose: 'Reference exchange rates',
    receives: 'Currency codes. Nothing about any customer, ever.',
  },
] as const;
