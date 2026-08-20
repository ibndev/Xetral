import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BITNOB_EVENTS } from './events.js';
import {
  WebhookVerificationError,
  idempotencyKeyFor,
  parseWebhook,
  toLedgerIntent,
  verifyWebhookSignature,
} from './webhooks.js';
import { ProviderContractError } from '../ports/errors.js';
import { assertBalanced } from '../ports/ledger-intent.js';
import type { LedgerIntent } from '../ports/ledger-intent.js';

const SECRET = 'whsec_test_secret';
const OWNER = 'user-42';

function body(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: 'evt_01HZY',
    event: BITNOB_EVENTS.cardAuthorization,
    created_at: '2026-08-19T10:30:00.000Z',
    ...overrides,
    data: {
      id: 'txn_998',
      card_id: 'card_77',
      customer_id: 'cus_5',
      amount: '25000000',
      currency: 'USD',
      merchant: 'Netflix',
      ...data,
    },
  });
}

const sign = (raw: string): string =>
  createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');

const intentFor = (raw: string): LedgerIntent => {
  const parsed = parseWebhook(raw);
  const intent = toLedgerIntent(parsed, { ownerId: OWNER });
  if (intent === undefined) throw new Error('expected an intent');
  return intent;
};

/** Legs keyed by account kind, for readable assertions. */
const byKind = (intent: LedgerIntent): Record<string, bigint> =>
  Object.fromEntries(intent.postings.map((p) => [p.account.kind, p.amountMinor]));

describe('signature verification', () => {
  it('accepts a correctly signed body', () => {
    const raw = body();
    expect(() =>
      verifyWebhookSignature(raw, { 'x-bitnob-signature': sign(raw) }, { secret: SECRET }),
    ).not.toThrow();
  });

  it('rejects a body edited after signing', () => {
    // The attack: keep the signature, change the amount.
    const raw = body();
    const signature = sign(raw);
    const tampered = raw.replace('25000000', '2500000000');
    expect(() =>
      verifyWebhookSignature(tampered, { 'x-bitnob-signature': signature }, { secret: SECRET }),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a signature made with another secret', () => {
    const raw = body();
    const foreign = createHmac('sha256', 'not-our-secret').update(raw).digest('hex');
    expect(() =>
      verifyWebhookSignature(raw, { 'x-bitnob-signature': foreign }, { secret: SECRET }),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a missing or empty signature header', () => {
    const raw = body();
    expect(() => verifyWebhookSignature(raw, {}, { secret: SECRET })).toThrow(/missing/);
    expect(() =>
      verifyWebhookSignature(raw, { 'x-bitnob-signature': '' }, { secret: SECRET }),
    ).toThrow(/missing/);
  });

  it('finds the header whatever case the server presents it in', () => {
    // HTTP header names are case-insensitive and whether they arrive lowercased
    // depends on the server. A case-sensitive lookup fails closed, which
    // presents as "every webhook is forged".
    const raw = body();
    expect(() =>
      verifyWebhookSignature(raw, { 'X-Bitnob-Signature': sign(raw) }, { secret: SECRET }),
    ).not.toThrow();
  });

  it('verifies the raw bytes, not a re-serialised object', () => {
    // A body that is valid JSON but not what JSON.stringify would emit --
    // extra whitespace. The signature covers the bytes Bitnob sent, so
    // round-tripping through parse/stringify before verifying breaks it in a
    // way that looks exactly like a wrong secret.
    const raw = `{ "event_id": "evt_1",  "event": "${BITNOB_EVENTS.cardDeclined}",
      "created_at": "2026-08-19T10:30:00.000Z",
      "data": { "id": "t", "card_id": "c", "customer_id": "u", "amount": "1", "currency": "USD" } }`;

    expect(() =>
      verifyWebhookSignature(raw, { 'x-bitnob-signature': sign(raw) }, { secret: SECRET }),
    ).not.toThrow();

    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(() =>
      verifyWebhookSignature(reserialised, { 'x-bitnob-signature': sign(raw) }, { secret: SECRET }),
    ).toThrow(WebhookVerificationError);
  });
});

describe('event names and payload keys', () => {
  it('uses the .completed suffix, not .complete', () => {
    // A handler keyed on the wrong spelling receives nothing, which is
    // indistinguishable from a provider that is not sending events.
    for (const name of Object.values(BITNOB_EVENTS)) {
      expect(name).not.toMatch(/\.complete$/);
    }
    expect(BITNOB_EVENTS.cardAuthorization).toBe('card.authorization.completed');
    expect(BITNOB_EVENTS.cardSettlement).toBe('card.settlement.completed');
  });

  it('reads snake_case keys', () => {
    // Camel-casing them yields undefined amounts, and undefined in a money
    // path is how a posting of zero gets written.
    const parsed = parseWebhook(body());
    expect(parsed.event_id).toBe('evt_01HZY');
    expect(parsed.data.card_id).toBe('card_77');
    expect(parsed.data.customer_id).toBe('cus_5');
  });

  it('rejects a payload missing a required field', () => {
    const broken = JSON.stringify({ event_id: 'e', event: 'x', created_at: 'y' });
    expect(() => parseWebhook(broken)).toThrow(ProviderContractError);
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseWebhook('<html>gateway timeout</html>')).toThrow(ProviderContractError);
  });
});

describe('idempotency key', () => {
  it('is derived from the provider event id, namespaced by provider', () => {
    // The ledger's UNIQUE constraint on this column is the replay guard, and
    // the namespace is what stops two providers issuing the same opaque id
    // from colliding.
    expect(idempotencyKeyFor(parseWebhook(body()))).toBe('bitnob:evt_01HZY');
  });

  it('is identical for a redelivery of the same event', () => {
    // Bitnob retries. Two deliveries of one event must produce one journal
    // entry, and it is this key that makes the second insert fail.
    const first = idempotencyKeyFor(parseWebhook(body()));
    const second = idempotencyKeyFor(parseWebhook(body({ created_at: '2026-08-19T11:00:00Z' })));
    expect(second).toBe(first);
  });

  it('differs for a settlement of the same transaction', () => {
    // Authorization and settlement are two events about one card spend. They
    // must NOT share an idempotency key, or the second would be swallowed as a
    // replay and the money would never leave pending.
    const auth = idempotencyKeyFor(parseWebhook(body()));
    const settle = idempotencyKeyFor(
      parseWebhook(body({ event_id: 'evt_02SETTLE', event: BITNOB_EVENTS.cardSettlement })),
    );
    expect(settle).not.toBe(auth);
  });
});

describe('the two-phase card flow', () => {
  it('moves wallet -> pending on authorization', () => {
    // Spendable balance drops; the customer's total does not. The money is
    // committed but not yet spent.
    const intent = intentFor(body());
    expect(intent.kind).toBe('card_authorization');
    expect(byKind(intent)).toEqual({ customer_wallet: -2500n, customer_pending: 2500n });
    expect(intent.occurredAt.toISOString()).toBe('2026-08-19T10:30:00.000Z');
  });

  it('moves pending -> provider_float on settlement', () => {
    const intent = intentFor(
      body({ event_id: 'evt_2', event: BITNOB_EVENTS.cardSettlement }),
    );
    expect(intent.kind).toBe('card_settlement');
    expect(byKind(intent)).toEqual({ customer_pending: -2500n, provider_float: 2500n });
  });

  it('returns pending -> wallet when the hold lapses', () => {
    const intent = intentFor(
      body({ event_id: 'evt_3', event: BITNOB_EVENTS.cardAuthorizationExpired }),
    );
    expect(intent.kind).toBe('card_auth_expiry');
    expect(byKind(intent)).toEqual({ customer_pending: -2500n, customer_wallet: 2500n });
  });

  it('leaves the customer whole across authorize then expire', () => {
    // The property that matters: the pair nets to zero in every account.
    const auth = intentFor(body());
    const expiry = intentFor(
      body({ event_id: 'evt_3', event: BITNOB_EVENTS.cardAuthorizationExpired }),
    );

    const net = new Map<string, bigint>();
    for (const p of [...auth.postings, ...expiry.postings]) {
      net.set(p.account.kind, (net.get(p.account.kind) ?? 0n) + p.amountMinor);
    }
    expect([...net.values()].every((v) => v === 0n)).toBe(true);
  });

  it('produces no entry for a decline', () => {
    // Nothing moved. An entry would have fewer than two postings and the
    // ledger rejects it.
    const parsed = parseWebhook(body({ event_id: 'evt_4', event: BITNOB_EVENTS.cardDeclined }));
    expect(toLedgerIntent(parsed, { ownerId: OWNER })).toBeUndefined();
  });

  it('balances every entry it produces, per currency', () => {
    for (const event of [
      BITNOB_EVENTS.cardAuthorization,
      BITNOB_EVENTS.cardSettlement,
      BITNOB_EVENTS.cardAuthorizationExpired,
      BITNOB_EVENTS.cardRefund,
    ]) {
      const intent = intentFor(body({ event_id: `evt_${event}`, event }));
      expect(() => assertBalanced(intent)).not.toThrow();
    }
  });
});

describe('display_amount can never reach a posting', () => {
  it('ignores it even when it contradicts the real amount', () => {
    // display_amount is a float and is for display only. Sending a wildly
    // wrong one must change nothing: the ledger amount comes from `amount`, in
    // micro-units, through the one conversion boundary.
    const intent = intentFor(body({}, { display_amount: 999999.99 }));
    expect(byKind(intent)).toEqual({ customer_wallet: -2500n, customer_pending: 2500n });
  });

  it('does not carry it into the domain event at all', () => {
    const parsed = parseWebhook(body({}, { display_amount: 25.0 }));
    expect('display_amount' in parsed.data).toBe(false);
  });
});

describe('amounts arriving badly', () => {
  it('refuses a settlement that is not a whole number of cents', () => {
    expect(() =>
      intentFor(body({ event_id: 'e', event: BITNOB_EVENTS.cardSettlement }, { amount: '1234567' })),
    ).toThrow(/whole number of cents/);
  });

  it('records a refund remainder rather than inventing a cent', () => {
    // A cent is the smallest thing the ledger can hold, so 0.4567 of one
    // cannot be posted. Truncating and recording the exact leftover keeps the
    // entry true; posting a whole cent would invent the other 0.5433.
    const intent = intentFor(
      body({ event_id: 'e', event: BITNOB_EVENTS.cardRefund }, { amount: '1234567' }),
    );
    expect(byKind(intent)).toEqual({ provider_float: -123n, customer_wallet: 123n });
    expect(intent.metadata['remainder_micro']).toBe('4567');
  });

  it('refuses a non-USD card event instead of guessing', () => {
    expect(() => intentFor(body({}, { currency: 'NGN' }))).toThrow(ProviderContractError);
  });

  it('refuses an unparseable timestamp', () => {
    expect(() => intentFor(body({ created_at: 'not a date' }))).toThrow(ProviderContractError);
  });

  it('refuses an event it does not handle', () => {
    expect(() => intentFor(body({ event: 'card.something.new' }))).toThrow(ProviderContractError);
  });
});
