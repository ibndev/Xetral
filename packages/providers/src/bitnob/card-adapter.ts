import { z } from 'zod';
import { microToUsd, parseMicro, usdToMicro } from './amounts.js';
import { BITNOB_ENDPOINTS, BitnobClient } from './client.js';
import { ProviderContractError } from '../ports/errors.js';
import type {
  CardPort,
  CardStatus,
  FundCardRequest,
  IssueCardRequest,
  OperationOutcome,
  VirtualCard,
} from '../ports/card.js';

const PROVIDER = 'bitnob';

/**
 * Bitnob's card responses, parsed at the boundary.
 *
 * Nothing below this schema leaves the adapter: callers receive `VirtualCard`
 * from the port. That is what lets a second issuer be added without touching
 * anything but its own adapter.
 */
const cardResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    last4: z.string().length(4),
    expiry_month: z.union([z.number(), z.string()]),
    expiry_year: z.union([z.number(), z.string()]),
    /** Micro-units, like every other amount they send. */
    balance: z.unknown(),
  }),
});

const fundResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    balance_before: z.unknown(),
    balance_after: z.unknown(),
  }),
});

/**
 * Bitnob's status vocabulary mapped onto ours.
 *
 * An unrecognised status throws rather than defaulting. Defaulting to 'active'
 * would let a card Bitnob has frozen keep being treated as spendable, and
 * defaulting to 'frozen' would strand a working card — neither is a safe guess,
 * so the adapter refuses to make one.
 */
function toCardStatus(raw: string): CardStatus {
  switch (raw.toLowerCase()) {
    case 'active':
      return 'active';
    case 'frozen':
    case 'inactive':
    case 'disabled':
      return 'frozen';
    case 'terminated':
    case 'closed':
      return 'terminated';
    default:
      throw new ProviderContractError(PROVIDER, `unrecognised card status '${raw}'`);
  }
}

function toInt(raw: number | string, field: string): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value)) {
    throw new ProviderContractError(PROVIDER, `${field} is not an integer: '${String(raw)}'`);
  }
  return value;
}

/**
 * The Bitnob implementation of CardPort.
 *
 * OPERATIONAL: card issuing requires approval from Bitnob before it can be used
 * at all. That approval has a lead time and blocks Phase 5, so it needs
 * requesting well before the code is ready.
 */
export class BitnobCardAdapter implements CardPort {
  constructor(private readonly client: BitnobClient) {}

  async issue(request: IssueCardRequest): Promise<VirtualCard> {
    // camelCase, and `customerEmail` rather than an id: Bitnob keys a card user
    // by the email registered through /virtualcards/registercarduser. Verified
    // against their Node SDK, which is also where the casing comes from — their
    // request bodies are camelCase even though webhook payloads are not.
    const payload = await this.client.request('POST', BITNOB_ENDPOINTS.issueCard, {
      customerEmail: request.providerCustomerId,
      // Converted at the one boundary, never inline.
      amount: usdToMicro(request.initialFunding).toString(),
    });
    return this.#toVirtualCard(payload);
  }

  /**
   * Funding does NOT return `settled` just because the call succeeded.
   *
   * Bitnob answers immediately with `status: "pending"` and
   * `balance_before === balance_after`. Reading that as success is the
   * documented trap: the money has not moved yet, and the final state arrives
   * by webhook or by polling. The port models the difference so a caller cannot
   * collapse it into a boolean.
   */
  async fund(request: FundCardRequest): Promise<OperationOutcome> {
    const payload = await this.client.request(
      'POST',
      BITNOB_ENDPOINTS.fundCard,
      {
        cardId: request.providerCardId,
        amount: usdToMicro(request.amount).toString(),
      },
      request.idempotencyKey,
    );

    const parsed = fundResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected shape from card funding', parsed.error);
    }

    const { id, status, balance_before, balance_after } = parsed.data.data;
    const unchanged = parseMicro(balance_before) === parseMicro(balance_after);

    if (status.toLowerCase() === 'success' && !unchanged) {
      return { state: 'settled' };
    }

    // Covers both the explicit 'pending' and the case where they claim success
    // while the balance has not moved. The second is the one that would
    // otherwise be believed.
    return { state: 'pending', providerReference: id };
  }

  async freeze(providerCardId: string): Promise<VirtualCard> {
    return this.#toVirtualCard(
      await this.client.request('POST', BITNOB_ENDPOINTS.freezeCard, { cardId: providerCardId }),
    );
  }

  async unfreeze(providerCardId: string): Promise<VirtualCard> {
    return this.#toVirtualCard(
      await this.client.request('POST', BITNOB_ENDPOINTS.unfreezeCard, { cardId: providerCardId }),
    );
  }

  async terminate(providerCardId: string): Promise<VirtualCard> {
    return this.#toVirtualCard(
      await this.client.request('POST', BITNOB_ENDPOINTS.terminateCard, { cardId: providerCardId }),
    );
  }

  async get(providerCardId: string): Promise<VirtualCard> {
    return this.#toVirtualCard(
      await this.client.request('GET', BITNOB_ENDPOINTS.getCard(providerCardId)),
    );
  }

  #toVirtualCard(payload: unknown): VirtualCard {
    const parsed = cardResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `unexpected card shape: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        parsed.error,
      );
    }

    const card = parsed.data.data;
    // A card balance may legitimately carry a sub-cent remainder, so the
    // tolerant conversion is used and the remainder discarded -- this is a
    // DISPLAY figure, not a posting. Nothing derived from it reaches the
    // ledger; the ledger's balance comes from postings.
    const { amount } = microToUsd(parseMicro(card.balance));

    return {
      providerCardId: card.id,
      status: toCardStatus(card.status),
      last4: card.last4,
      expiryMonth: toInt(card.expiry_month, 'expiry_month'),
      expiryYear: toInt(card.expiry_year, 'expiry_year'),
      balance: amount,
    };
  }
}
