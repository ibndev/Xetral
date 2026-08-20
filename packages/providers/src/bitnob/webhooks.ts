import { createHmac, timingSafeEqual } from 'node:crypto';
import { money, subtract } from '@xetral/shared';
import type { Money } from '@xetral/shared';
import { microToUsd, microToUsdExact, parseMicro } from './amounts.js';
import { BITNOB_EVENTS, bitnobWebhookEnvelope } from './events.js';
import type { BitnobWebhookEnvelope } from './events.js';
import { ProviderContractError } from '../ports/errors.js';
import { assertBalanced, posting } from '@xetral/ledger';
import type { LedgerIntent, PostingIntent } from '@xetral/ledger';

const PROVIDER = 'bitnob';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Verifies a webhook signature against the RAW request body.
 *
 * THE RAW BODY, not a re-serialised object. `JSON.parse` followed by
 * `JSON.stringify` reorders nothing in practice but does normalise whitespace,
 * unicode escapes and number formatting — and the signature covers the exact
 * bytes Bitnob sent. Verifying a round-tripped body produces failures that look
 * like a wrong secret and are not, which is a long afternoon.
 *
 * Verification happens BEFORE parsing, so no attacker-controlled bytes reach
 * the JSON parser or the schema until they are proven to come from Bitnob.
 *
 * CONFIRM BEFORE GO-LIVE: the header name and digest encoding below are the
 * common convention and are NOT verified against Bitnob's dashboard. They are
 * parameters rather than hardcoded constants for exactly that reason — check
 * the live docs and set them once, in one place.
 */
export interface WebhookVerifierOptions {
  readonly secret: string;
  /** Header carrying the signature. Confirm against Bitnob's docs. */
  readonly signatureHeader?: string;
  /** How the digest is encoded in that header. Confirm against Bitnob's docs. */
  readonly encoding?: 'hex' | 'base64';
}

export function verifyWebhookSignature(
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  options: WebhookVerifierOptions,
): void {
  const headerName = (options.signatureHeader ?? 'x-bitnob-signature').toLowerCase();
  const encoding = options.encoding ?? 'hex';

  // Header lookup is case-insensitive because HTTP header names are, and
  // whether they arrive lowercased depends on the server. A case-sensitive
  // lookup here fails closed, which is safe but presents as "every webhook is
  // forged".
  const presented = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === headerName,
  )?.[1];

  if (presented === undefined || presented === '') {
    throw new WebhookVerificationError(`missing ${headerName} header`);
  }

  const expected = createHmac('sha256', options.secret).update(rawBody, 'utf8').digest(encoding);

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak timing
  // and crash on malformed input. Compare lengths first, treat any difference
  // as a plain failure.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookVerificationError('signature does not match');
  }
}

/**
 * Parses a verified body. Never call this on an unverified one — the argument
 * order of `handleWebhook` exists so that is hard to do by accident.
 */
export function parseWebhook(rawBody: string): BitnobWebhookEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch (cause) {
    throw new ProviderContractError(PROVIDER, 'webhook body is not valid JSON', cause);
  }

  const parsed = bitnobWebhookEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new ProviderContractError(
      PROVIDER,
      `webhook payload does not match the expected shape: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/** `bitnob:<event_id>`. Composite so two providers cannot collide on the
 *  ledger's UNIQUE constraint. */
export function idempotencyKeyFor(envelope: BitnobWebhookEnvelope): string {
  return `${PROVIDER}:${envelope.event_id}`;
}

export interface WebhookContext {
  /** Our user id for the Bitnob customer on the event. Resolved by the caller,
   *  because mapping a provider customer to a Xetral user is not the adapter's
   *  business. */
  readonly ownerId: string;
}

/**
 * Translates a verified, parsed webhook into a request for a journal entry.
 *
 * THE TWO-PHASE CARD FLOW
 * -----------------------
 * Bitnob fires a webhook on Authorization AND again on Settlement, up to 7-14
 * business days later. Their own documentation warns that treating the pair as
 * one transaction produces an incorrect balance. The `customer_pending` account
 * from Phase 1 is what makes both representable:
 *
 *   Authorization  card    -> pending          card balance drops, total same
 *   Settlement     pending -> provider_float   the hold becomes a real spend
 *   Expiry         pending -> card             the hold lapsed; money returns
 *
 * An authorization draws on the CARD's own balance, not the wallet. A Bitnob
 * virtual card is topped up from the wallet and holds its own funds, so a
 * purchase is authorised against that. Drawing from the wallet instead — which
 * is what this adapter did before Phase 5 gave it a card table to know better —
 * would let a card funded with ten dollars authorise five hundred, because the
 * wallet happened to hold it. The overdraft guard already covers
 * `customer_card`, so getting the account right is the entire fix.
 *
 * Returns undefined for events that carry no money — a decline moves nothing,
 * and writing a journal entry for it would mean an entry that cannot balance.
 */
export function toLedgerIntent(
  envelope: BitnobWebhookEnvelope,
  context: WebhookContext,
): LedgerIntent | undefined {
  const { ownerId } = context;

  if (envelope.data.currency.toUpperCase() !== 'USD') {
    throw new ProviderContractError(
      PROVIDER,
      `card events are expected in USD, got '${envelope.data.currency}'`,
    );
  }

  const micro = parseMicro(envelope.data.amount);
  const occurredAt = new Date(envelope.created_at);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ProviderContractError(
      PROVIDER,
      `unparseable created_at '${envelope.created_at}'`,
    );
  }

  const base = {
    idempotencyKey: idempotencyKeyFor(envelope),
    occurredAt,
    metadata: {
      provider: PROVIDER,
      event: envelope.event,
      card_id: envelope.data.card_id,
      transaction_id: envelope.data.id,
      ...(envelope.data.merchant === undefined ? {} : { merchant: envelope.data.merchant }),
    },
  };

  const card = { kind: 'customer_card', ownerId, currency: 'USD' } as const;
  const pending = { kind: 'customer_pending', ownerId, currency: 'USD' } as const;
  const float = { kind: 'provider_float', currency: 'USD' } as const;

  let intent: LedgerIntent;

  switch (envelope.event) {
    case BITNOB_EVENTS.cardAuthorization: {
      // Exact: a card authorization is a real-world charge and holds a whole
      // number of cents. A fractional one means the contract changed.
      const amount = microToUsdExact(micro);
      intent = {
        ...base,
        kind: 'card_authorization',
        description: describe('authorization', envelope),
        postings: legs(amount, card, pending),
      };
      break;
    }

    case BITNOB_EVENTS.cardSettlement: {
      const amount = microToUsdExact(micro);
      intent = {
        ...base,
        kind: 'card_settlement',
        description: describe('settlement', envelope),
        postings: legs(amount, pending, float),
      };
      break;
    }

    case BITNOB_EVENTS.cardAuthorizationExpired: {
      // The hold lapsed and the money returns. An ordinary reversal of the
      // authorization's direction, which is why no special-casing is needed
      // anywhere else.
      const amount = microToUsdExact(micro);
      intent = {
        ...base,
        kind: 'card_auth_expiry',
        description: describe('authorization expiry', envelope),
        postings: legs(amount, pending, card),
      };
      break;
    }

    case BITNOB_EVENTS.cardRefund: {
      // A refund may carry a sub-cent remainder — an FX-derived refund is not
      // obliged to land on a whole cent — so this path does not use the exact
      // form.
      //
      // The remainder is RECORDED, not posted. A cent is the smallest thing the
      // ledger can represent, so 0.4567 of one cannot be written at all: posting
      // a whole cent to suspense would invent the other 0.5433 and make the
      // entry a statement about money that does not exist. Truncating and
      // carrying the exact leftover in metadata keeps the entry true and leaves
      // the discrepancy visible where it belongs, in reconciliation against
      // Bitnob's own balance.
      const { amount, remainderMicro } = microToUsd(micro);

      intent = {
        ...base,
        metadata:
          remainderMicro === 0n
            ? base.metadata
            : { ...base.metadata, remainder_micro: remainderMicro.toString() },
        kind: 'card_refund',
        description: describe('refund', envelope),
        postings: legs(amount, float, card),
      };
      break;
    }

    case BITNOB_EVENTS.cardDeclined:
      // No money moved. An entry for this would have nothing to balance
      // against, and the ledger rejects an entry with fewer than two postings.
      return undefined;

    default:
      throw new ProviderContractError(PROVIDER, `unhandled event '${envelope.event}'`);
  }

  // Checked before it leaves the adapter, so a bad mapping names the event that
  // produced it rather than surfacing as a deferred constraint at COMMIT.
  assertBalanced(intent);
  return intent;
}

function negateUsd(amount: Money<'USD'>): Money<'USD'> {
  return subtract(money(0n, 'USD'), amount);
}

/** One amount out of `from`, the same amount into `to`. Sums to zero by
 *  construction, which is the only way to build a two-legged entry here. */
function legs(
  amount: Money<'USD'>,
  from: Parameters<typeof posting>[0],
  to: Parameters<typeof posting>[0],
): readonly PostingIntent[] {
  return [posting(from, negateUsd(amount)), posting(to, amount)];
}

function describe(what: string, envelope: BitnobWebhookEnvelope): string {
  const merchant = envelope.data.merchant;
  return merchant === undefined ? `card ${what}` : `card ${what} at ${merchant}`;
}
