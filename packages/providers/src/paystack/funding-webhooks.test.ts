import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DEDICATED_ACCOUNT_CHANNEL,
  handlePaystackDeposit,
  parsePaystackWebhook,
  verifyPaystackSignature,
} from './funding-webhooks.js';
import { ProviderContractError } from '../ports/errors.js';
import { DepositCeilingError } from '../bitnob/ngn-amounts.js';

const SECRET = 'sk_test_a_secret_key';
const CEILING = 10_000_000n; // ₦100,000

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'charge.success',
    data: {
      id: 3021017,
      reference: 'ps_ref_001',
      amount: 500_000, // ₦5,000 in kobo
      currency: 'NGN',
      channel: DEDICATED_ACCOUNT_CHANNEL,
      status: 'success',
      paid_at: '2026-09-03T09:00:00.000Z',
      authorization: {
        sender_bank: 'Kuda Bank',
        account_name: 'ADA OBI',
        sender_bank_account_number: '0123456789',
      },
      customer: { customer_code: 'CUS_1', email: 'ada@example.ng' },
      ...overrides,
    },
  });
}

const owned = { resolve: async () => ({ ownerId: '42' }), ceilingKobo: CEILING };

describe('proving an event came from Paystack', () => {
  it('accepts a correct HMAC-SHA512 of the raw body', () => {
    const raw = body();
    const signature = createHmac('sha512', SECRET).update(raw, 'utf8').digest('hex');
    expect(verifyPaystackSignature(raw, signature, SECRET)).toBe(true);
  });

  it('refuses a body altered by one character', () => {
    // The whole point. A forged event on this rail is an invented balance.
    const raw = body();
    const signature = createHmac('sha512', SECRET).update(raw, 'utf8').digest('hex');
    expect(verifyPaystackSignature(raw.replace('500000', '900000'), signature, SECRET)).toBe(
      false,
    );
  });

  it('refuses a signature made with a different key', () => {
    const raw = body();
    const signature = createHmac('sha512', 'sk_test_someone_elses').update(raw).digest('hex');
    expect(verifyPaystackSignature(raw, signature, SECRET)).toBe(false);
  });

  it('refuses a missing signature without throwing', () => {
    // A thrown comparison is a 500 where a 401 belongs, and a 500 tells a
    // prober we are broken rather than that they are unauthorised.
    expect(verifyPaystackSignature(body(), undefined, SECRET)).toBe(false);
    expect(verifyPaystackSignature(body(), '', SECRET)).toBe(false);
  });

  it('refuses a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths rather than returning false.
    expect(verifyPaystackSignature(body(), 'abc123', SECRET)).toBe(false);
  });

  it('is SHA-512, not SHA-256', () => {
    // Worth pinning: "everyone uses SHA-256" put the wrong hash on the Bitnob
    // webhook once, and it would have rejected every event in production
    // while looking exactly like a bad secret.
    const raw = body();
    const sha256 = createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verifyPaystackSignature(raw, sha256, SECRET)).toBe(false);
  });
});

describe('crediting a customer', () => {
  it('credits the wallet and takes it off the float, in kobo', async () => {
    const outcome = await handlePaystackDeposit(parsePaystackWebhook(body()), owned);

    expect(outcome.amountKobo).toBe(500_000n);
    expect(outcome.ownerId).toBe('42');
    expect(outcome.intent.postings).toEqual([
      { account: { kind: 'customer_wallet', ownerId: '42', currency: 'NGN' }, amountMinor: 500_000n, currency: 'NGN' },
      { account: { kind: 'provider_float', currency: 'NGN' }, amountMinor: -500_000n, currency: 'NGN' },
    ]);
  });

  it('keys on THEIR reference, which the reconciliation sweep also sees', async () => {
    // A lost webhook resolved by the sweep and a late redelivery of that same
    // webhook must produce the same key, or the customer is credited twice on
    // the one flow in the system that creates money.
    const outcome = await handlePaystackDeposit(parsePaystackWebhook(body()), owned);
    expect(outcome.intent.idempotencyKey).toBe('paystack:ps_ref_001');
  });

  it('keeps the sender NAME out of ledger metadata', async () => {
    // Personal data belongs in `deposits`, where access is deliberate, not in
    // an append-only entry nobody can ever redact.
    const outcome = await handlePaystackDeposit(parsePaystackWebhook(body()), owned);
    expect(JSON.stringify(outcome.intent.metadata)).not.toContain('ADA OBI');
    // It still reaches the caller, which writes it to the deposit row.
    expect(outcome.sender.name).toBe('ADA OBI');
  });
});

describe('what must never credit a wallet', () => {
  it('REFUSES a charge on any channel but a dedicated account', async () => {
    /*
     * `charge.success` is Paystack's event for every successful charge — a
     * card payment, a USSD collection, a transfer into a dedicated account.
     * Crediting on the event name alone would turn any other Paystack product
     * on the same integration into a way to create wallet balances.
     */
    await expect(
      handlePaystackDeposit(parsePaystackWebhook(body({ channel: 'card' })), owned),
    ).rejects.toThrow(/only credits 'dedicated_nuban'/);
  });

  it('refuses an event it does not recognise, rather than acknowledging it', async () => {
    const raw = JSON.stringify({ ...JSON.parse(body()), event: 'transfer.success' });
    await expect(handlePaystackDeposit(parsePaystackWebhook(raw), owned)).rejects.toBeInstanceOf(
      ProviderContractError,
    );
  });

  it('refuses a currency this rail does not carry', async () => {
    await expect(
      handlePaystackDeposit(parsePaystackWebhook(body({ currency: 'USD' })), owned),
    ).rejects.toThrow(/this rail is NGN/);
  });

  it('refuses an amount past the ceiling rather than crediting it', async () => {
    // The ceiling is what makes a misread amount recoverable: nobody is
    // credited, and the caller decides it goes to suspense.
    await expect(
      handlePaystackDeposit(parsePaystackWebhook(body({ amount: 90_000_000 })), owned),
    ).rejects.toBeInstanceOf(DepositCeilingError);
  });

  it('refuses an amount that arrived as a float', async () => {
    // By the time a decimal is a JS number the precision is already gone, and
    // this number becomes somebody's balance.
    await expect(
      handlePaystackDeposit(parsePaystackWebhook(body({ amount: 5000.5 })), owned),
    ).rejects.toThrow();
  });
});

describe('money that cannot be attributed', () => {
  it('goes to SUSPENSE, never nowhere', async () => {
    // The money arrived whatever we can work out about it. Dropping the event
    // because it matched no account is how a real transfer disappears from a
    // real person's life.
    const outcome = await handlePaystackDeposit(parsePaystackWebhook(body()), {
      ceilingKobo: CEILING,
      resolve: async () => ({ ownerId: undefined, reason: 'no account matched' }),
    });

    expect(outcome.ownerId).toBeUndefined();
    expect(outcome.suspenseReason).toBe('no account matched');
    expect(outcome.intent.postings[0]?.account).toEqual({ kind: 'suspense', currency: 'NGN' });
    // The float leg is IDENTICAL to an attributed deposit, because the money
    // is equally real.
    expect(outcome.intent.postings[1]?.amountMinor).toBe(-500_000n);
  });
});
