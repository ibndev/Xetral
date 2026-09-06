import { ProviderContractError } from '../ports/errors.js';
import type { CheckoutOutcome, CheckoutPort, CheckoutRequest, CheckoutSession } from '../ports/checkout.js';
import type { PaystackClient } from './client.js';
import { initializeCheckout, verifyCheckout } from './checkout.js';

const PROVIDER = 'paystack';

/**
 * The Paystack checkout, behind the port.
 *
 * The two functions this wraps were written when there was one rail, and one
 * implementation does not need an interface. There are two now, and the whole
 * point of the port is that `PaymentLinkService` cannot tell which answered —
 * so the wrapping is the change, and the wire calls underneath are untouched.
 *
 * PAYSTACK'S UNIT IS ALREADY THE LEDGER'S. `amount` is kobo, pesewa or cent
 * in both directions, so this adapter converts nothing — which is worth
 * saying out loud beside `flutterwave/checkout-adapter.ts`, where the same
 * field is in MAJOR units and the conversion is the most dangerous line in
 * the file.
 */
export class PaystackCheckoutAdapter implements CheckoutPort {
  readonly provider = PROVIDER;
  readonly #client: PaystackClient;

  constructor(client: PaystackClient) {
    this.#client = client;
  }

  async begin(request: CheckoutRequest): Promise<CheckoutSession> {
    return initializeCheckout(this.#client, {
      payerEmail: request.payerEmail,
      amountMinor: request.amountMinor,
      currency: request.currency,
      reference: request.reference,
      ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
      ...(request.payeeName === undefined ? {} : { payeeName: request.payeeName }),
      ...(request.note === undefined ? {} : { note: request.note }),
    });
  }

  async verify(reference: string): Promise<CheckoutOutcome> {
    const outcome = await verifyCheckout(this.#client, reference);
    return {
      status: outcome.status,
      reference: outcome.reference,
      amountMinor: minorOf(outcome.amount),
      currency: outcome.currency,
      channel: outcome.channel,
      paidAt: outcome.paidAt,
    };
  }
}

/**
 * Their minor-unit amount as a bigint.
 *
 * FROM THE TEXT, never from a float. A JSON number past 2^53 has already lost
 * precision by the time it is read, and `BigInt(1e21)` is not a rounding
 * error a caller can notice — so a non-integer is refused rather than
 * truncated. Same rule as `parseMicro`.
 */
function minorOf(amount: unknown): bigint {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'string' && /^-?\d+$/.test(amount.trim())) return BigInt(amount.trim());
  if (typeof amount === 'number' && Number.isSafeInteger(amount)) return BigInt(amount);
  throw new ProviderContractError(
    PROVIDER,
    `a verified transaction carried an unreadable amount: ${String(amount)}`,
  );
}
