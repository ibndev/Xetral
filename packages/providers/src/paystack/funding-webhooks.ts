import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { assertBalanced, posting } from '@xetral/ledger';
import type { LedgerIntent } from '@xetral/ledger';
import { money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import { assertWithinCeiling, depositToKobo } from '../bitnob/ngn-amounts.js';

const PROVIDER = 'paystack';

/**
 * Money arriving in a Paystack dedicated account.
 *
 * THE MOST CONSEQUENTIAL TRANSLATION IN THE PLATFORM, in its second copy.
 * Every other adapter moves money already ours to move; this one creates a
 * customer balance on the strength of a provider saying money arrived. The
 * rules are the ones `bitnob/funding-webhooks.ts` records, and they are
 * restated here rather than shared because the payloads have nothing in
 * common — what is shared is the ceiling, the suspense posting and the
 * idempotency discipline, and those ARE imported.
 */

/**
 * The event, and it is the ONLY one this rail acts on.
 *
 * Paystack sends `charge.success` for a dedicated-account credit alongside
 * every other kind of successful charge, so the event name is necessary and
 * not sufficient: `data.channel` must be `dedicated_nuban`. Without that
 * check a card payment on some other Paystack product would credit a wallet.
 */
export const PAYSTACK_EVENTS = {
  chargeSuccess: 'charge.success',
} as const;

/** The channel a dedicated virtual account credit arrives on. */
export const DEDICATED_ACCOUNT_CHANNEL = 'dedicated_nuban';

export const paystackChargeEnvelope = z.object({
  event: z.string().min(1),
  data: z.object({
    id: z.union([z.string(), z.number()]),
    /** THEIRS, and stable across a redelivery and a reconciliation read. */
    reference: z.string().min(1),
    /** Left `unknown` and narrowed by `depositToKobo`. A `z.number()` would
     *  accept a value JSON.parse has already rounded. */
    amount: z.unknown(),
    currency: z.string().min(1),
    channel: z.string().nullish(),
    status: z.string().nullish(),
    paid_at: z.string().nullish(),
    created_at: z.string().nullish(),
    /** Where it landed. This is what maps the money to one of our customers. */
    metadata: z.unknown().optional(),
    authorization: z
      .object({
        sender_bank: z.string().nullish(),
        account_name: z.string().nullish(),
        sender_bank_account_number: z.string().nullish(),
        receiver_bank_account_number: z.string().nullish(),
      })
      .nullish(),
    customer: z
      .object({
        customer_code: z.string().nullish(),
        email: z.string().nullish(),
      })
      .nullish(),
  }),
});

export type PaystackChargeEnvelope = z.infer<typeof paystackChargeEnvelope>;

/**
 * Is this really from Paystack?
 *
 * HMAC-SHA512, hex, over the RAW body, keyed by the SECRET KEY — not a
 * separate webhook secret. That is Paystack's documented scheme and it is
 * worth naming the difference from Bitnob, which uses a webhook secret of its
 * own: one credential here, two there, and configuring either the other way
 * round rejects every event.
 *
 * Verified BEFORE a single byte is parsed, and compared in constant time. A
 * forged event on this rail is an invented balance.
 */
export function verifyPaystackSignature(
  rawBody: string,
  signature: string | undefined,
  secretKey: string,
): boolean {
  if (signature === undefined || signature === '') return false;
  const expected = createHmac('sha512', secretKey).update(rawBody, 'utf8').digest('hex');
  const given = Buffer.from(signature, 'utf8');
  const ours = Buffer.from(expected, 'utf8');
  // Length-checked first: `timingSafeEqual` throws on a mismatch rather than
  // returning false, and a thrown comparison is a 500 where a 401 belongs.
  if (given.length !== ours.length) return false;
  return timingSafeEqual(given, ours);
}

export function parsePaystackWebhook(rawBody: string): PaystackChargeEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch (cause) {
    throw new ProviderContractError(PROVIDER, 'webhook body is not valid JSON', cause);
  }

  const parsed = paystackChargeEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new ProviderContractError(
      PROVIDER,
      `charge payload does not match the expected shape: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
      parsed.error,
    );
  }
  return parsed.data;
}

export interface PaystackDepositResolution {
  readonly ownerId: string | undefined;
  readonly reason?: string;
}

export interface PaystackDepositContext {
  /** Refuse to credit anything above this, in kobo. */
  readonly ceilingKobo: bigint;
  /**
   * Maps the credited account to one of our customers.
   *
   * A callback, because that mapping is the platform's business rather than
   * the adapter's — the same separation the Bitnob deposit path keeps.
   */
  readonly resolve: (event: PaystackChargeEnvelope) => Promise<PaystackDepositResolution>;
}

export interface PaystackDepositOutcome {
  readonly intent: LedgerIntent;
  readonly amountKobo: bigint;
  readonly ownerId: string | undefined;
  readonly suspenseReason: string | undefined;
  readonly providerReference: string;
  readonly sender: {
    readonly name: string | undefined;
    readonly bank: string | undefined;
    readonly account: string | undefined;
  };
}

export async function handlePaystackDeposit(
  event: PaystackChargeEnvelope,
  context: PaystackDepositContext,
): Promise<PaystackDepositOutcome> {
  if (event.event !== PAYSTACK_EVENTS.chargeSuccess) {
    // Unrecognised events THROW rather than being acknowledged. The caller
    // answers non-2xx, Paystack retries, and a wrong assumption is a loud
    // repeating failure instead of a deposit that quietly never happened.
    throw new ProviderContractError(PROVIDER, `unhandled event '${event.event}'`);
  }

  /*
   * THE CHANNEL CHECK IS NOT OPTIONAL.
   *
   * `charge.success` is Paystack's event for EVERY successful charge — a card
   * payment, a USSD collection, a transfer into a dedicated account. Only the
   * last is money arriving in a customer's own naira account. Crediting on
   * the event name alone would turn any other Paystack product on the same
   * integration into a way to create wallet balances.
   */
  if (event.data.channel !== DEDICATED_ACCOUNT_CHANNEL) {
    throw new ProviderContractError(
      PROVIDER,
      `charge.success on channel '${String(event.data.channel)}' is not a dedicated ` +
        `account credit; this rail only credits '${DEDICATED_ACCOUNT_CHANNEL}'`,
    );
  }

  if (event.data.currency.toUpperCase() !== 'NGN') {
    throw new ProviderContractError(
      PROVIDER,
      `this rail is NGN; got a deposit in ${event.data.currency}`,
    );
  }

  /*
   * PAYSTACK IS KOBO, and there is no deployment switch for it.
   *
   * The Bitnob rail has `BITNOB_NGN_AMOUNT_UNIT` because its unit could not
   * be verified before go-live, and being wrong there was made recoverable
   * rather than avoided. Paystack's unit is unambiguous in their own client
   * and their own examples, so a switch here would be a way to configure a
   * known answer wrongly. The CEILING still applies, because a ceiling
   * catches more than a misread unit.
   */
  const amountKobo = depositToKobo(event.data.amount, 'kobo');
  assertWithinCeiling(amountKobo, context.ceilingKobo);

  const resolution = await context.resolve(event);
  const currency: Currency = 'NGN';
  const amount = money(amountKobo, currency);

  // The money arrived and is owed to somebody: the customer whose account it
  // landed on, or suspense until a person says whose it is. The float leg is
  // identical either way, because the money is equally real.
  const credit =
    resolution.ownerId === undefined
      ? posting({ kind: 'suspense', currency }, amount)
      : posting({ kind: 'customer_wallet', ownerId: resolution.ownerId, currency }, amount);

  const intent: LedgerIntent = {
    /*
     * KEYED ON PAYSTACK'S REFERENCE, WHICH IS WHAT BOTH PATHS SEE.
     *
     * The webhook carries it and so does `GET /transaction`, so a lost
     * webhook resolved by the reconciliation sweep and a late redelivery of
     * that same webhook produce the SAME key — and the second is a replay the
     * ledger already refuses. Keying on `data.id` instead would work here and
     * is avoided anyway, because 013's finding 4 was exactly a delivery id
     * and a money id being different fields on the one rail that creates
     * money.
     */
    idempotencyKey: `${PROVIDER}:${event.data.reference}`,
    kind: 'wallet_funding',
    occurredAt: new Date(event.data.paid_at ?? event.data.created_at ?? Date.now()),
    description:
      resolution.ownerId === undefined
        ? 'unattributed NGN deposit'
        : 'NGN deposit to dedicated account',
    metadata: {
      provider_reference: event.data.reference,
      // The sender's NAME is deliberately absent. It is personal data
      // belonging in `deposits`, where access is deliberate, rather than in
      // an append-only entry nobody can ever redact.
      ...(resolution.ownerId === undefined ? { suspense_reason: resolution.reason ?? '' } : {}),
    },
    postings: [credit, posting({ kind: 'provider_float', currency }, money(-amountKobo, currency))],
  };

  // Checked before it leaves the adapter, so an unbalanced entry names the
  // event that built it rather than surfacing as a COMMIT-time abort.
  assertBalanced(intent);

  return {
    intent,
    amountKobo,
    ownerId: resolution.ownerId,
    suspenseReason:
      resolution.ownerId === undefined ? (resolution.reason ?? 'unattributed') : undefined,
    providerReference: event.data.reference,
    sender: {
      name: event.data.authorization?.account_name ?? undefined,
      bank: event.data.authorization?.sender_bank ?? undefined,
      account: event.data.authorization?.sender_bank_account_number ?? undefined,
    },
  };
}
