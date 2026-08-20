import { z } from 'zod';
import { money } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import type { BitnobClient } from './client.js';
import type {
  CreateAddressRequest,
  CryptoAddress,
  CryptoNetwork,
  CryptoPort,
  SendRequest,
  WithdrawalQuote,
  WithdrawalReceipt,
  WithdrawalState,
} from '../ports/crypto.js';
import { assertValidAddress } from '../crypto/address.js';

const PROVIDER = 'bitnob';

/**
 * Bitnob for on-chain assets.
 *
 * CONFIRM BEFORE GO-LIVE, and it resolves with the same approval that gates
 * cards and the funding rail. The paths follow the conventions verified for
 * the card endpoints in Phase 3 — flat verb paths under a base URL that
 * already contains `/api/v1`, camelCase request bodies, snake_case responses —
 * but the crypto routes themselves could not be verified from this repository.
 *
 * Every path is in this one table and every response goes through a schema, so
 * a wrong one fails loudly on the first call rather than returning something
 * plausible.
 */
export const BITNOB_CRYPTO_ENDPOINTS = {
  createAddress: '/addresses/generate',
  quoteSend: '/wallets/send/quote',
  send: '/wallets/send',
  transaction: (reference: string) => `/transactions/${reference}`,
} as const;

const addressResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    address: z.string().min(1),
    memo: z.string().nullish(),
  }),
});

const quoteResponse = z.object({
  data: z.object({
    /** Left `unknown` and narrowed by `parseMinor` — a `z.number()` here would
     *  accept a value JSON.parse had already rounded and hand it over looking
     *  valid, which for a fee means the customer is charged the wrong amount. */
    fee: z.unknown(),
    expires_at: z.string().nullish(),
  }),
});

const sendResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    tx_hash: z.string().nullish(),
    reason: z.string().nullish(),
  }),
});

export interface BitnobCryptoOptions {
  readonly client: BitnobClient;
  /** How long a fee quote stays good for when the provider does not say. Short
   *  by default: a stale quote either fails to broadcast or quietly costs the
   *  customer more than the number they approved. */
  readonly quoteTtlSeconds?: number;
}

export class BitnobCryptoAdapter implements CryptoPort {
  readonly provider = PROVIDER;

  readonly #client: BitnobClient;
  readonly #quoteTtlSeconds: number;

  constructor(options: BitnobCryptoOptions) {
    this.#client = options.client;
    this.#quoteTtlSeconds = options.quoteTtlSeconds ?? 60;
  }

  async createDepositAddress(request: CreateAddressRequest): Promise<CryptoAddress> {
    const payload = await this.#client.request('POST', BITNOB_CRYPTO_ENDPOINTS.createAddress, {
      customerId: request.providerCustomerId,
      currency: request.asset,
      chain: request.network,
      reference: request.idempotencyKey,
    });

    const parsed = addressResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `address response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    // Validated HERE, at the boundary, before it is ever shown to a customer.
    // A malformed deposit address printed in an app is money sent nowhere, and
    // the customer has no way to tell before they send it.
    assertValidAddress(parsed.data.data.address, request.network);

    return {
      providerAddressId: parsed.data.data.id,
      address: parsed.data.data.address,
      memo: parsed.data.data.memo ?? undefined,
      asset: request.asset,
      network: request.network,
    };
  }

  async quoteWithdrawal(
    asset: Currency,
    network: CryptoNetwork,
    amount: Money<Currency>,
  ): Promise<WithdrawalQuote> {
    const payload = await this.#client.request('POST', BITNOB_CRYPTO_ENDPOINTS.quoteSend, {
      currency: asset,
      chain: network,
      amount: amount.amount.toString(),
    });

    const parsed = quoteResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `quote response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    const expiresAt = parsed.data.data.expires_at;
    return {
      feeMinor: parseMinor(parsed.data.data.fee),
      expiresAt:
        expiresAt === null || expiresAt === undefined
          ? new Date(Date.now() + this.#quoteTtlSeconds * 1000)
          : new Date(expiresAt),
    };
  }

  async send(request: SendRequest): Promise<WithdrawalReceipt> {
    // Checked again immediately before the irreversible call, even though the
    // caller has already validated it. This is the last line of code that runs
    // before the money is unrecoverable, and the cost of the second check is
    // nothing.
    assertValidAddress(request.destination, request.network);

    const payload = await this.#client.request('POST', BITNOB_CRYPTO_ENDPOINTS.send, {
      currency: request.asset,
      chain: request.network,
      address: request.destination,
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      amount: request.amount.amount.toString(),
      // Their de-duplication and ours agree on what "the same withdrawal"
      // means. On this one operation a duplicate cannot be undone.
      reference: request.reference,
    });

    return this.#toReceipt(payload);
  }

  async withdrawalStatus(reference: string): Promise<WithdrawalReceipt> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_CRYPTO_ENDPOINTS.transaction(reference),
    );
    return this.#toReceipt(payload);
  }

  #toReceipt(payload: unknown): WithdrawalReceipt {
    const parsed = sendResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `send response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    const data = parsed.data.data;
    const state = toState(data.status);

    // A provider claiming success with no transaction hash is claiming
    // something it cannot substantiate. Distrusting the label and believing
    // the evidence is the same rule the card adapter applies to a "success"
    // whose balance did not move.
    if ((state === 'broadcast' || state === 'confirmed') && (data.tx_hash ?? '') === '') {
      throw new ProviderContractError(
        PROVIDER,
        `withdrawal ${data.id} is reported as '${data.status}' with no transaction hash`,
      );
    }

    return {
      providerReference: data.id,
      state,
      txHash: data.tx_hash ?? undefined,
      failureReason: state === 'failed' ? (data.reason ?? 'the provider gave no reason') : undefined,
    };
  }
}

/**
 * Their status vocabulary into ours.
 *
 * An UNRECOGNISED status throws rather than defaulting. Defaulting to 'failed'
 * would reverse a withdrawal that is on a chain; defaulting to 'broadcast'
 * would tell a customer money left when it did not. Neither is a safe guess,
 * so the adapter refuses to make one.
 */
function toState(status: string): WithdrawalState {
  switch (status.toLowerCase()) {
    case 'pending':
    case 'processing':
    case 'broadcast':
    case 'submitted':
      return 'broadcast';
    case 'success':
    case 'successful':
    case 'completed':
    case 'confirmed':
      return 'confirmed';
    case 'failed':
    case 'cancelled':
    case 'rejected':
      return 'failed';
    default:
      throw new ProviderContractError(PROVIDER, `unrecognised withdrawal status '${status}'`);
  }
}

/** Minor units, rejecting anything JSON.parse has already rounded. */
export function parseMinor(raw: unknown): bigint {
  if (typeof raw === 'string') {
    if (!/^[0-9]+$/.test(raw.trim())) {
      throw new ProviderContractError(PROVIDER, `'${raw}' is not a whole number of minor units`);
    }
    return BigInt(raw.trim());
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new ProviderContractError(
        PROVIDER,
        `${raw} is not a safe integer; ask the provider to send it as a string`,
      );
    }
    return BigInt(raw);
  }
  throw new ProviderContractError(PROVIDER, `expected a minor-unit amount, got ${typeof raw}`);
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.')).join(', ');
}

/** Re-exported so a caller can build the port's amount type without importing
 *  `@xetral/shared` twice. */
export { money };
