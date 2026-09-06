import { z } from 'zod';
import { fromMajor, isCurrency, toMajor, money } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type { CheckoutOutcome, CheckoutPort, CheckoutRequest, CheckoutSession } from '../ports/checkout.js';
import { FLUTTERWAVE_ENDPOINTS, type FlutterwaveClient } from './client.js';

const PROVIDER = 'flutterwave';

/**
 * WHICH METHODS A PAYER IS OFFERED, per currency.
 *
 * Flutterwave calls this `payment_options` where Paystack calls it
 * `channels`, and in BOTH the list is resolved against the currency on the
 * provider's side — so sending a method the currency cannot use is not an
 * error, it is a checkout page with nothing on it. The two fields therefore
 * travel together or not at all.
 *
 * WHY NAME THEM AT ALL rather than let the provider decide. Left to itself
 * their page leads with card, which in Accra and Nairobi is the method
 * fewest payers have and the one with the worst completion rate. Mobile money
 * is how money moves in both places; putting it first is not a preference,
 * it is the difference between a link that gets paid and one that does not.
 *
 * AN UNLISTED CURRENCY GETS THE PROVIDER'S OWN DEFAULT, deliberately. A
 * hardcoded fallback list would be a guess about a corridor nobody has opened
 * yet, and a wrong guess there is an empty page rather than a loud refusal.
 */
export const FLUTTERWAVE_PAYMENT_OPTIONS: Readonly<Record<string, string>> = {
  /* Ghana: MTN, Vodafone/Telecel and AirtelTigo all sit behind this one
   * option — Flutterwave renders the network picker itself, which is why
   * this platform does not carry a Ghanaian network list of its own. */
  GHS: 'mobilemoneyghana',
  /* Kenya: M-Pesa, plus a bank transfer for the payer who has no wallet. */
  KES: 'mpesa,banktransfer',
  /* Dollars belong to no country and have no wallet rail, so a card is the
   * only thing a stranger can pay one with. */
  USD: 'card',
};

const paymentsResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: z.object({ link: z.string().min(1) }).optional(),
});

const verifyResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: z
    .object({
      /** `successful`, `failed`, `pending` — and NOT `success`, which is
       *  what the ENVELOPE says. Two fields named status, two vocabularies. */
      status: z.string().min(1),
      tx_ref: z.string().min(1),
      /**
       * MAJOR UNITS, and left `unknown` on purpose.
       *
       * A `z.number()` would accept a value `JSON.parse` has already rounded,
       * which for money is a loss that no care downstream recovers. It is
       * narrowed from its TEXT below.
       */
      amount: z.unknown(),
      charged_amount: z.unknown().optional(),
      currency: z.string().min(1),
      payment_type: z.string().nullish(),
      created_at: z.string().nullish(),
    })
    .optional(),
});

/**
 * A FLUTTERWAVE-HOSTED CHECKOUT.
 *
 * THE UNIT IS THE THING TO GET RIGHT HERE, and it is the opposite of
 * Paystack's. `/v3/payments` takes MAJOR units — `50.00`, not `5000` — while
 * `/transaction/initialize` one directory away takes minor. Copying the
 * Paystack adapter's `amountMinor.toString()` into this file charges a payer
 * ONE HUNDRED TIMES the amount, in the direction that takes their money, and
 * nothing in either API would refuse it: 5000 cedis is a perfectly valid
 * charge. So the conversion happens once, through `toMajor`, which is the
 * only code in this repo that knows an exponent is per currency — JPY is 0
 * and USDT is 6, and a hardcoded ÷100 is wrong for both.
 *
 * The read converts back the same way, from the DECIMAL TEXT rather than
 * from the JSON number.
 */
export class FlutterwaveCheckoutAdapter implements CheckoutPort {
  readonly provider = PROVIDER;
  readonly #client: FlutterwaveClient;

  constructor(client: FlutterwaveClient) {
    this.#client = client;
  }

  async begin(request: CheckoutRequest): Promise<CheckoutSession> {
    const options = FLUTTERWAVE_PAYMENT_OPTIONS[request.currency];

    const body = await this.#client.request('POST', FLUTTERWAVE_ENDPOINTS.payments, {
      /* THEIRS IS `tx_ref`, OURS IS `reference`, and it is the same string.
       * It names a row written before the payer left — the security argument
       * 058 makes about the Paystack checkout, unchanged by the rail. */
      tx_ref: request.reference,
      amount: majorText(request.amountMinor, request.currency),
      currency: request.currency,
      ...(request.callbackUrl === undefined ? {} : { redirect_url: request.callbackUrl }),
      ...(options === undefined ? {} : { payment_options: options }),
      customer: {
        email: request.payerEmail,
        ...(request.payerName === undefined ? {} : { name: request.payerName }),
      },
      customizations: {
        /* What the payer sees at the top of the page. They are paying a
         * person, not a platform, so the person is the title. */
        title: request.payeeName ?? 'Xetral',
        ...(request.note === undefined ? {} : { description: request.note }),
      },
      meta: {
        xetral_reference: request.reference,
        ...(request.note === undefined ? {} : { xetral_note: request.note }),
      },
    });

    const parsed = paymentsResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      // A CONTRACT BREAK, not an outage. Waiting does not fix a response
      // shape, and a retry loop would hide it.
      throw new ProviderContractError(
        PROVIDER,
        `unexpected /v3/payments response: ${
          parsed.success ? (parsed.data.message ?? 'no data') : parsed.error.message
        }`,
      );
    }

    return { authorizationUrl: parsed.data.data.link, reference: request.reference };
  }

  async verify(reference: string): Promise<CheckoutOutcome> {
    const body = await this.#client.request(
      'GET',
      FLUTTERWAVE_ENDPOINTS.verifyByReference(reference),
    );

    const parsed = verifyResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      throw new ProviderRejectedError(
        PROVIDER,
        parsed.success ? (parsed.data.message ?? 'no such transaction') : parsed.error.message,
        'unknown_reference',
      );
    }

    const data = parsed.data.data;
    return {
      /*
       * `successful`, NOT `success`. The envelope says `success` and the
       * transaction says `successful`, one letter and one nesting level
       * apart, and treating either spelling as the other is the difference
       * between crediting an unpaid checkout and never crediting a paid one.
       *
       * Everything that is not plainly finished is PENDING rather than
       * failed: a payer who walked away from the page may still come back,
       * and the reference stays live until it expires.
       */
      status:
        data.status === 'successful' ? 'success' : data.status === 'failed' ? 'failed' : 'pending',
      reference: data.tx_ref,
      /*
       * WHAT THEY ACTUALLY TOOK, when they say so.
       *
       * `charged_amount` includes their fee and `amount` is what the payment
       * was for; the customer is credited what the payment was FOR, so
       * `amount` is what this returns. `charged_amount` is read only to be
       * ignored deliberately rather than by omission — an adapter that never
       * mentions a field is one nobody can tell was considered.
       */
      amountMinor: minorFromMajor(data.amount, data.currency),
      currency: data.currency,
      channel: data.payment_type ?? undefined,
      paidAt: data.created_at ?? undefined,
    };
  }
}

/**
 * Minor units out to the major-unit text this API wants.
 *
 * `toMajor` is the one place an exponent is read, so a currency whose
 * exponent is not two — and there are several — cannot be got wrong here by
 * a hardcoded divide.
 */
function majorText(amountMinor: bigint, currency: string): string {
  if (!isCurrency(currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
  }
  return toMajor(money(amountMinor, currency));
}

/**
 * Their major-unit amount back into the ledger's minor units.
 *
 * TAKEN FROM ITS TEXT, never from the parsed number. `JSON.parse` has already
 * rounded a JSON number by the time it reaches here, and for money that loss
 * is unrecoverable — the rule `parseMicro` records for Bitnob, one provider
 * on. `fromMajor` takes a string for exactly this reason.
 */
function minorFromMajor(amount: unknown, currency: string): bigint {
  if (!isCurrency(currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
  }
  const text =
    typeof amount === 'string'
      ? amount.trim()
      : typeof amount === 'number' && Number.isFinite(amount)
        ? String(amount)
        : undefined;
  if (text === undefined || text === '') {
    throw new ProviderContractError(PROVIDER, 'a verified transaction carried no amount');
  }
  try {
    return fromMajor(text, currency).amount;
  } catch (cause) {
    throw new ProviderContractError(PROVIDER, `unreadable amount ${text} ${currency}`, cause);
  }
}
