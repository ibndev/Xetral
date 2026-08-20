import { describe, expect, it } from 'vitest';
import { handleDepositWebhook, parseDepositWebhook } from './funding-webhooks.js';
import type { DepositContext } from './funding-webhooks.js';
import { DepositCeilingError } from './ngn-amounts.js';
import { ProviderContractError } from '../ports/errors.js';

const CEILING = 1_000_000_00n; // N1,000,000.00

const body = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
  JSON.stringify({
    event_id: 'evt_dep_1',
    event: 'virtualaccount.deposit.completed',
    created_at: '2026-08-20T10:00:00Z',
    data: {
      id: 'dep_9911',
      virtual_account_id: 'bva_1',
      account_number: '0123456789',
      amount: '5000000',
      currency: 'NGN',
      sender_name: 'ADEBAYO OLUWASEUN',
      sender_bank: 'GTBank',
      sender_account_number: '0987654321',
      ...data,
    },
    ...overrides,
  });

const context = (overrides: Partial<DepositContext> = {}): DepositContext => ({
  amountUnit: 'kobo',
  ceilingKobo: CEILING,
  resolve: async () => ({ ownerId: '42' }),
  ...overrides,
});

describe('a deposit that resolves to a customer', () => {
  it('credits the customer wallet and debits the float', async () => {
    const out = await handleDepositWebhook(parseDepositWebhook(body()), context());

    expect(out.amountKobo).toBe(5_000_000n);
    expect(out.ownerId).toBe('42');
    expect(out.intent.kind).toBe('wallet_funding');
    expect(out.intent.postings).toEqual([
      {
        account: { kind: 'customer_wallet', ownerId: '42', currency: 'NGN' },
        amountMinor: 5_000_000n,
        currency: 'NGN',
      },
      { account: { kind: 'provider_float', currency: 'NGN' }, amountMinor: -5_000_000n, currency: 'NGN' },
    ]);
  });

  it('keys the entry on the provider event id', async () => {
    // The replay guard. A redelivered webhook must reach the ledger with the
    // same key so the UNIQUE constraint refuses the second credit.
    const out = await handleDepositWebhook(parseDepositWebhook(body()), context());
    expect(out.intent.idempotencyKey).toBe('bitnob:evt_dep_1');
  });

  it('keeps the sender out of ledger metadata', async () => {
    // The sender's name is personal data. It belongs in `deposits`, where
    // access is deliberate, not in an append-only entry nobody can redact.
    const out = await handleDepositWebhook(parseDepositWebhook(body()), context());
    expect(JSON.stringify(out.intent.metadata)).not.toContain('ADEBAYO');
    // But it IS carried out for the caller to store.
    expect(out.sender.name).toBe('ADEBAYO OLUWASEUN');
  });
});

describe('a deposit that resolves to nobody', () => {
  it('posts to SUSPENSE rather than being dropped', async () => {
    // The money arrived whatever we can work out about it. Discarding the
    // event because it did not match a customer is how a real transfer
    // disappears from a real person's life.
    const out = await handleDepositWebhook(
      parseDepositWebhook(body()),
      context({ resolve: async () => ({ ownerId: undefined, reason: 'no account matched' }) }),
    );

    expect(out.ownerId).toBeUndefined();
    expect(out.suspenseReason).toBe('no account matched');
    expect(out.intent.postings[0]?.account).toEqual({ kind: 'suspense', currency: 'NGN' });
    // Still balanced, and still the same float leg — the money is equally real.
    expect(out.intent.postings[1]?.amountMinor).toBe(-5_000_000n);
  });
});

describe('the ceiling', () => {
  it('refuses a deposit above it rather than crediting', async () => {
    const huge = body({}, { amount: '200000000' }); // N2,000,000.00
    await expect(handleDepositWebhook(parseDepositWebhook(huge), context())).rejects.toThrow(
      DepositCeilingError,
    );
  });

  it('catches the OVER-crediting unit misconfiguration before anyone is paid', async () => {
    // The dangerous direction. Bitnob sends kobo ('5000000' = N50,000) and we
    // are configured for naira, so it reads as N5,000,000 — 100x too much, and
    // immediately spendable. The ceiling is what stops it reaching a balance.
    const misconfigured = context({ amountUnit: 'naira', ceilingKobo: 500_000_00n });
    await expect(
      handleDepositWebhook(parseDepositWebhook(body()), misconfigured),
    ).rejects.toThrow(DepositCeilingError);
  });

  it('does not pretend to catch the UNDER-crediting direction', async () => {
    // The mirror-image misconfiguration reads N50,000 as N500. No ceiling can
    // catch that, and none tries: under-crediting surfaces immediately as a
    // customer saying "I sent more than that", and is fully recoverable with a
    // correcting entry. Over-crediting is the one that is spent before anyone
    // notices, which is why the guard points that way only.
    const under = context({ amountUnit: 'kobo' });
    const asNaira = body({}, { amount: '50000' }); // provider meant naira
    const out = await handleDepositWebhook(parseDepositWebhook(asNaira), under);
    expect(out.amountKobo).toBe(50_000n); // N500, not N50,000
  });
});

describe('what it refuses', () => {
  it('throws on an unrecognised event rather than acknowledging it', async () => {
    // A wrong event name must be a loud, repeating failure. Acknowledging one
    // would drop a real deposit permanently to save some log noise.
    const other = body({ event: 'virtualaccount.deposit.SOMETHING_ELSE' });
    await expect(handleDepositWebhook(parseDepositWebhook(other), context())).rejects.toThrow(
      ProviderContractError,
    );
  });

  it('refuses a deposit in the wrong currency', async () => {
    const usd = body({}, { currency: 'USD' });
    await expect(handleDepositWebhook(parseDepositWebhook(usd), context())).rejects.toThrow(
      /NGN/,
    );
  });

  it('refuses a payload missing the amount', () => {
    const noAmount = JSON.stringify({
      event_id: 'e',
      event: 'virtualaccount.deposit.completed',
      created_at: '2026-08-20T10:00:00Z',
      data: { id: 'd', currency: 'NGN' },
    });
    // Refused at the schema, before any money reasoning happens. A deposit
    // with no amount is not a deposit we can guess at.
    expect(() => parseDepositWebhook(noAmount)).toThrow(ProviderContractError);
  });

  it('refuses a body that is not JSON', () => {
    expect(() => parseDepositWebhook('not json')).toThrow(ProviderContractError);
  });

  it('refuses a payload with no event id to key on', () => {
    const noId = JSON.stringify({
      event: 'virtualaccount.deposit.completed',
      created_at: '2026-08-20T10:00:00Z',
      data: { id: 'd', amount: '1', currency: 'NGN' },
    });
    expect(() => parseDepositWebhook(noId)).toThrow(ProviderContractError);
  });
});
