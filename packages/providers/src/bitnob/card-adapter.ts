import { z } from 'zod';
import { microToUsd, parseMicro, usdToMicro } from './amounts.js';
import { BITNOB_ENDPOINTS, BitnobClient } from './client.js';
import { ProviderContractError } from '../ports/errors.js';
import type {
  CardPort,
  CardSecrets,
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

    // ------------------------------------------------------------------
    // TWO SHAPES, BOTH OPTIONAL, AND THAT IS DELIBERATE.
    //
    // This schema originally required `last4`, `expiry_month` and
    // `expiry_year`. Bitnob's own Node SDK reads NONE of those three from a
    // card response — it reads `cardNumber`, `cvv2` and a single `expiry`
    // (`lib/virtual_card.ts`, `generateVirtualCardObject`). Feeding this
    // adapter the SDK-shaped object throws `unexpected card shape`, which
    // means that if the SDK is right, issuing a card failed on the FIRST REAL
    // CALL and every test passed because the tests were written from the same
    // assumption as the schema.
    //
    // That is the failure this provider already produced once, recorded in
    // Phase 3: a table of plausible constants, tests agreeing with it because
    // the same person wrote both, and every path wrong.
    //
    // Which shape is correct cannot be settled from here — the SDK is 1.0.4,
    // its card model has visible copy-paste bugs, and Bitnob's documentation
    // is not reachable. So this READ accepts either. Being tolerant on a read
    // costs nothing; being wrong costs every card. `toCard` below refuses only
    // when NEITHER shape is present, which is the honest failure.
    // ------------------------------------------------------------------
    last4: z.string().length(4).optional(),
    expiry_month: z.union([z.number(), z.string()]).optional(),
    expiry_year: z.union([z.number(), z.string()]).optional(),

    /** The SDK's names for the same information. */
    cardNumber: z.string().min(4).optional(),
    cvv2: z.string().min(3).optional(),
    /** A single field — "11/30", "2030-11", "11/2030". */
    expiry: z.string().min(4).optional(),
    cardName: z.string().optional(),

    /** Micro-units, like every other amount they send. */
    balance: z.unknown(),
  }),
});

type CardBody = z.infer<typeof cardResponse>['data'];

/**
 * The last four digits, from whichever field carries them.
 *
 * When only the full number is present it is TRUNCATED HERE and the rest
 * discarded. This is the one place in the adapter where a PAN exists on the
 * ordinary read path, and it exists for the length of this expression — the
 * value returned is four characters, so nothing downstream can leak what it
 * never received.
 */
function readLast4(card: CardBody): string | undefined {
  if (card.last4 !== undefined) return card.last4;
  if (card.cardNumber !== undefined) return card.cardNumber.slice(-4);
  return undefined;
}

/**
 * Month and year, from either the split fields or the combined one.
 *
 * The combined form is ambiguous about order and about century, so each
 * accepted layout is matched explicitly rather than guessed at with a split.
 * A two-digit year is read as 20xx: these are cards, not history.
 */
function readExpiry(card: CardBody): { month: number; year: number } | undefined {
  if (card.expiry_month !== undefined && card.expiry_year !== undefined) {
    return {
      month: toInt(card.expiry_month, 'expiry_month'),
      year: toInt(card.expiry_year, 'expiry_year'),
    };
  }

  if (card.expiry === undefined) return undefined;
  const raw = card.expiry.trim();

  // MM/YY or MM/YYYY
  const slash = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(raw);
  if (slash !== null) {
    const month = Number(slash[1]);
    const yearPart = slash[2] as string;
    return { month, year: yearPart.length === 2 ? 2000 + Number(yearPart) : Number(yearPart) };
  }

  // YYYY-MM
  const dashed = /^(\d{4})-(\d{1,2})$/.exec(raw);
  if (dashed !== null) return { month: Number(dashed[2]), year: Number(dashed[1]) };

  return undefined;
}

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

    const last4 = readLast4(card);
    const expiry = readExpiry(card);
    if (last4 === undefined || expiry === undefined) {
      // Neither shape. Loud, and it names both, so whoever reads this can see
      // that two field sets were tried rather than wondering which one we
      // expected.
      throw new ProviderContractError(
        PROVIDER,
        'a card response carried neither last4/expiry_month/expiry_year nor ' +
          'cardNumber/expiry; the response shape has changed again',
      );
    }

    return {
      providerCardId: card.id,
      status: toCardStatus(card.status),
      last4,
      expiryMonth: expiry.month,
      expiryYear: expiry.year,
      balance: amount,
    };
  }

  /**
   * The number, the CVV and the expiry — fetched, returned, never kept.
   *
   * The SAME endpoint as `get`, because that is what Bitnob offers: their SDK
   * has no separate reveal call, and `fetchCard` is where `cardNumber` and
   * `cvv2` appear. The two are kept apart at the PORT anyway, so that
   * reconciliation and card listings — which call `get` constantly — never
   * handle a PAN they did not ask for.
   *
   * Throws when the fields are absent rather than returning a partial. A
   * customer shown half a card number has no idea whether the problem is
   * theirs, and would try again; an error tells the truth and pages somebody.
   */
  async reveal(providerCardId: string): Promise<CardSecrets> {
    const payload = await this.client.request(
      'GET',
      BITNOB_ENDPOINTS.getCard(providerCardId),
    );

    const parsed = cardResponse.safeParse(payload);
    if (!parsed.success) {
      // Deliberately does NOT echo the payload. Every other parse failure in
      // this adapter names the offending fields, and doing that here would put
      // a card number in a log line the moment the shape shifted.
      throw new ProviderContractError(
        PROVIDER,
        `unexpected card shape while revealing card ${providerCardId}`,
      );
    }

    const card = parsed.data.data;
    const expiry = readExpiry(card);

    if (card.cardNumber === undefined || card.cvv2 === undefined || expiry === undefined) {
      throw new ProviderContractError(
        PROVIDER,
        'the provider returned a card without a number, a CVV or an expiry, so ' +
          'there is nothing to reveal',
      );
    }

    return {
      pan: card.cardNumber,
      cvv: card.cvv2,
      expiryMonth: expiry.month,
      expiryYear: expiry.year,
      ...(card.cardName === undefined ? {} : { nameOnCard: card.cardName }),
    };
  }
}
