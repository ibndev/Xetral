import { assertBalanced, posting } from '@xetral/ledger';
import type { LedgerIntent } from '@xetral/ledger';
import { money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import { BITNOB_CRYPTO_EVENTS, bitnobCryptoEnvelope } from './events.js';
import type { BitnobCryptoEnvelope } from './events.js';
import { parseMinor } from './crypto-adapter.js';
import type { CryptoNetwork } from '../ports/crypto.js';

const PROVIDER = 'bitnob';

/**
 * On-chain deposit events into requests for journal entries.
 *
 * A DEPOSIT IS TWO EVENTS. `seen` records money that has arrived and is not
 * yet safe; `confirmed` makes it spendable. That is the same two-phase shape
 * as a card authorization and settlement, and it exists here for a sharper
 * reason: a transaction with one confirmation can be reorganised out of the
 * chain, and a customer who withdrew against it would have spent money that
 * stopped having happened.
 *
 *   Seen        provider_float   -> customer_pending
 *   Confirmed   customer_pending -> customer_wallet
 *
 * The two carry DIFFERENT idempotency keys derived from the same event, so a
 * redelivery of either is a replay and neither can stand in for the other.
 */

export type CryptoDepositPhase = 'seen' | 'confirmed';

export interface CryptoDepositResolution {
  /** Our user id for the address the money landed on. */
  readonly ownerId: string;
  readonly asset: Currency;
}

export interface CryptoDepositContext {
  /** Resolves an on-chain address to one of our customers. A callback, because
   *  mapping an address to a Xetral user is the platform's business. */
  readonly resolve: (event: BitnobCryptoEnvelope) => Promise<CryptoDepositResolution | undefined>;
}

export interface CryptoDepositOutcome {
  readonly phase: CryptoDepositPhase;
  readonly intent: LedgerIntent;
  readonly ownerId: string;
  readonly asset: Currency;
  readonly network: CryptoNetwork;
  readonly amountMinor: bigint;
  readonly txHash: string;
  readonly outputIndex: number;
  readonly confirmations: number;
  readonly providerReference: string;
}

export function parseCryptoWebhook(rawBody: string): BitnobCryptoEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch (cause) {
    throw new ProviderContractError(PROVIDER, 'webhook body is not valid JSON', cause);
  }

  const parsed = bitnobCryptoEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new ProviderContractError(
      PROVIDER,
      `crypto payload does not match the expected shape: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
      parsed.error,
    );
  }
  return parsed.data;
}

export async function handleCryptoDeposit(
  event: BitnobCryptoEnvelope,
  context: CryptoDepositContext,
): Promise<CryptoDepositOutcome> {
  const phase = phaseOf(event.event);
  const network = toNetwork(event.data.chain);
  const resolution = await context.resolve(event);

  if (resolution === undefined) {
    // Unlike a NAIRA deposit, this cannot go to suspense and be sorted out
    // later: an address we do not recognise is not ours, so the money is not
    // ours either and posting it would invent a liability. Throwing means the
    // provider retries and the event stays visible.
    throw new ProviderContractError(
      PROVIDER,
      `no customer owns ${network} address ${event.data.address}`,
    );
  }

  const amountMinor = parseMinor(event.data.amount);
  if (amountMinor <= 0n) {
    throw new ProviderContractError(PROVIDER, 'a deposit of zero is not a deposit');
  }

  const asset = resolution.asset;
  const amount = money(amountMinor, asset);

  // The asset the ADDRESS is for, not the string in the payload. An address is
  // issued for one asset on one chain; believing the event over the address
  // would let a mislabelled payload credit the wrong balance.
  if (event.data.currency.toUpperCase() !== asset) {
    throw new ProviderContractError(
      PROVIDER,
      `a ${event.data.currency} deposit landed on a ${asset} address`,
    );
  }

  const intent: LedgerIntent =
    phase === 'seen'
      ? {
          // Keyed on the DEPOSIT (`data.id`), not the delivery (`event_id`).
          // The reconciliation sweep only ever learns `data.id` — a webhook
          // that never arrived has no event id to know — so keying on the
          // delivery would let a sweep and a late redelivery credit the same
          // deposit twice. The NGN rail had exactly that bug.
          idempotencyKey: `${PROVIDER}:${event.data.id}:seen`,
          kind: 'crypto_deposit',
          occurredAt: new Date(event.created_at),
          description: `${asset} deposit seen on ${network}`,
          metadata: { tx_hash: event.data.tx_hash, chain: network, phase: 'seen' },
          postings: [
            // Into PENDING. Visible to the customer, not spendable.
            posting({ kind: 'customer_pending', ownerId: resolution.ownerId, currency: asset }, amount),
            posting({ kind: 'provider_float', currency: asset }, money(-amountMinor, asset)),
          ],
        }
      : {
          // A DIFFERENT key from the seen phase, derived from the same
          // DEPOSIT. Without the suffix the confirmation would replay the seen
          // entry and the money would never become spendable; keyed on the
          // deposit rather than the delivery, a sweep and a late webhook agree.
          idempotencyKey: `${PROVIDER}:${event.data.id}:confirmed`,
          kind: 'crypto_deposit',
          occurredAt: new Date(event.created_at),
          description: `${asset} deposit confirmed on ${network}`,
          metadata: { tx_hash: event.data.tx_hash, chain: network, phase: 'confirmed' },
          postings: [
            posting(
              { kind: 'customer_pending', ownerId: resolution.ownerId, currency: asset },
              money(-amountMinor, asset),
            ),
            posting({ kind: 'customer_wallet', ownerId: resolution.ownerId, currency: asset }, amount),
          ],
        };

  assertBalanced(intent);

  return {
    phase,
    intent,
    ownerId: resolution.ownerId,
    asset,
    network,
    amountMinor,
    txHash: event.data.tx_hash,
    outputIndex: event.data.output_index ?? 0,
    confirmations: event.data.confirmations,
    providerReference: event.data.id,
  };
}

function phaseOf(event: string): CryptoDepositPhase {
  if (event === BITNOB_CRYPTO_EVENTS.depositSeen) return 'seen';
  if (event === BITNOB_CRYPTO_EVENTS.depositConfirmed) return 'confirmed';
  // Throws rather than being acknowledged, so a wrong name is loud and
  // repeating instead of a deposit that quietly never happened.
  throw new ProviderContractError(PROVIDER, `unhandled crypto event '${event}'`);
}

function toNetwork(chain: string): CryptoNetwork {
  const lower = chain.toLowerCase();
  if (lower === 'bitcoin' || lower === 'btc') return 'bitcoin';
  if (lower === 'ethereum' || lower === 'eth' || lower === 'erc20') return 'ethereum';
  if (lower === 'tron' || lower === 'trx' || lower === 'trc20') return 'tron';
  if (lower === 'bsc' || lower === 'bep20') return 'bsc';
  // An unknown chain is not a routing detail to shrug at: the chain decides
  // where money can be sent and whether an address is valid at all.
  throw new ProviderContractError(PROVIDER, `unrecognised chain '${chain}'`);
}
