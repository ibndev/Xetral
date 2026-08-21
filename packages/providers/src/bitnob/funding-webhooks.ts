import { assertBalanced, posting } from '@xetral/ledger';
import type { LedgerIntent } from '@xetral/ledger';
import { money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import { BITNOB_FUNDING_EVENTS, bitnobDepositEnvelope } from './events.js';
import type { BitnobDepositEnvelope } from './events.js';
import { assertWithinCeiling, depositToKobo } from './ngn-amounts.js';
import type { NgnAmountUnit } from './ngn-amounts.js';

const PROVIDER = 'bitnob';

/**
 * Turning a deposit webhook into a request for a journal entry.
 *
 * THE MOST CONSEQUENTIAL TRANSLATION IN THE PLATFORM. Every other adapter
 * moves money that is already ours to move; this one creates a customer
 * balance on the strength of a provider saying money arrived. Three things
 * follow, and all three are here rather than in the service:
 *
 *   1. The amount goes through ONE conversion (`depositToKobo`) and then
 *      through the ceiling. A deposit that blows the ceiling is not credited.
 *   2. An unattributable deposit becomes a posting to SUSPENSE, never a
 *      discarded event. The money arrived whatever we can work out about it.
 *   3. The idempotency key is the provider's own event id, so a redelivery is
 *      a replay the ledger already knows how to refuse.
 */

export interface DepositResolution {
  /** Our user id, or undefined when no account matched. */
  readonly ownerId: string | undefined;
  /** Why it could not be attributed. Required when ownerId is undefined. */
  readonly reason?: string;
}

export interface DepositContext {
  readonly amountUnit: NgnAmountUnit;
  /** Refuse to credit anything above this, in kobo. */
  readonly ceilingKobo: bigint;
  /**
   * Resolves the account the money landed on to one of our users.
   *
   * A callback rather than a lookup here, because mapping a provider account
   * to a Xetral customer is the platform's business and not the adapter's —
   * the same separation that keeps `WebhookContext.ownerId` out of the card
   * adapter.
   */
  readonly resolve: (event: BitnobDepositEnvelope) => Promise<DepositResolution>;
}

export interface DepositOutcome {
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

export function parseDepositWebhook(rawBody: string): BitnobDepositEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch (cause) {
    throw new ProviderContractError(PROVIDER, 'webhook body is not valid JSON', cause);
  }

  const parsed = bitnobDepositEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new ProviderContractError(
      PROVIDER,
      `deposit payload does not match the expected shape: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
      parsed.error,
    );
  }
  return parsed.data;
}

export async function handleDepositWebhook(
  event: BitnobDepositEnvelope,
  context: DepositContext,
): Promise<DepositOutcome> {
  if (event.event !== BITNOB_FUNDING_EVENTS.depositReceived) {
    // Unrecognised events THROW rather than being acknowledged. The caller
    // returns a non-2xx, Bitnob retries, and a wrong event name is a loud
    // repeating failure instead of a deposit that quietly never happened.
    throw new ProviderContractError(PROVIDER, `unhandled deposit event '${event.event}'`);
  }

  if (event.data.currency.toUpperCase() !== 'NGN') {
    throw new ProviderContractError(
      PROVIDER,
      `this rail is NGN; got a deposit in ${event.data.currency}`,
    );
  }

  const amountKobo = depositToKobo(event.data.amount, context.amountUnit);
  // Throws on breach. Deliberately NOT caught here: the caller decides that a
  // ceiling breach goes to suspense, because that is a policy about money and
  // not a parsing concern.
  assertWithinCeiling(amountKobo, context.ceilingKobo);

  const resolution = await context.resolve(event);
  const currency: Currency = 'NGN';
  const amount = money(amountKobo, currency);

  // Money arrived at Bitnob and is now owed to somebody: either the customer
  // whose account it landed on, or suspense until a human says whose it is.
  // Either way the float leg is identical, because the money is equally real.
  const credit =
    resolution.ownerId === undefined
      ? posting({ kind: 'suspense', currency }, amount)
      : posting(
          { kind: 'customer_wallet', ownerId: resolution.ownerId, currency },
          amount,
        );

  const intent: LedgerIntent = {
    idempotencyKey: `${PROVIDER}:${event.event_id}`,
    kind: 'wallet_funding',
    occurredAt: new Date(event.created_at),
    description:
      resolution.ownerId === undefined
        ? 'unattributed NGN deposit'
        : 'NGN deposit to dedicated account',
    metadata: {
      provider_reference: event.data.id,
      // The sender's NAME is deliberately absent from ledger metadata. It is
      // personal data belonging in `deposits`, where access is deliberate,
      // rather than in an append-only entry nobody can ever redact.
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
    suspenseReason: resolution.ownerId === undefined ? (resolution.reason ?? 'unattributed') : undefined,
    providerReference: event.data.id,
    sender: {
      name: event.data.sender_name,
      bank: event.data.sender_bank,
      account: event.data.sender_account_number,
    },
  };
}
