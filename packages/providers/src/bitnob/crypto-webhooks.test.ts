import { describe, expect, it } from 'vitest';
import { handleCryptoDeposit, parseCryptoWebhook } from './crypto-webhooks.js';
import type { CryptoDepositContext } from './crypto-webhooks.js';
import { ProviderContractError } from '../ports/errors.js';

const body = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
  JSON.stringify({
    event_id: 'evt_cx_1',
    event: 'crypto.deposit.pending',
    created_at: '2026-08-20T10:00:00Z',
    data: {
      id: 'cxd_1',
      address: 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
      chain: 'tron',
      currency: 'USDT',
      amount: '250000000',
      tx_hash: '0xabc',
      confirmations: 1,
      ...data,
    },
    ...overrides,
  });

const context = (overrides: Partial<CryptoDepositContext> = {}): CryptoDepositContext => ({
  resolve: async () => ({ ownerId: '42', asset: 'USDT' }),
  ...overrides,
});

describe('a deposit that has been SEEN', () => {
  it('lands in pending, not the spendable wallet', async () => {
    // The whole point of the two-phase flow. One confirmation can be
    // reorganised away, and a customer who withdrew against it would have
    // spent money that stopped having happened.
    const out = await handleCryptoDeposit(parseCryptoWebhook(body()), context());

    expect(out.phase).toBe('seen');
    expect(out.intent.postings[0]?.account).toEqual({
      kind: 'customer_pending',
      ownerId: '42',
      currency: 'USDT',
    });
    expect(out.intent.postings[0]?.amountMinor).toBe(250_000_000n);
    expect(out.intent.postings[1]?.account).toEqual({ kind: 'provider_float', currency: 'USDT' });
  });

  it('keys on the provider event id', async () => {
    const out = await handleCryptoDeposit(parseCryptoWebhook(body()), context());
    expect(out.intent.idempotencyKey).toBe('bitnob:evt_cx_1');
  });
});

describe('a deposit that has been CONFIRMED', () => {
  const confirmed = () =>
    body({ event: 'crypto.deposit.confirmed' }, { confirmations: 25 });

  it('moves the money from pending into the wallet', async () => {
    const out = await handleCryptoDeposit(parseCryptoWebhook(confirmed()), context());

    expect(out.phase).toBe('confirmed');
    expect(out.intent.postings[0]).toMatchObject({
      account: { kind: 'customer_pending', ownerId: '42', currency: 'USDT' },
      amountMinor: -250_000_000n,
    });
    expect(out.intent.postings[1]).toMatchObject({
      account: { kind: 'customer_wallet', ownerId: '42', currency: 'USDT' },
      amountMinor: 250_000_000n,
    });
  });

  it('uses a DIFFERENT idempotency key from the seen phase', async () => {
    // Derived from the same event. Without the suffix the confirmation would
    // replay the seen entry and the money would never become spendable.
    const seen = await handleCryptoDeposit(parseCryptoWebhook(body()), context());
    const done = await handleCryptoDeposit(parseCryptoWebhook(confirmed()), context());
    expect(done.intent.idempotencyKey).not.toBe(seen.intent.idempotencyKey);
    expect(done.intent.idempotencyKey).toBe('bitnob:evt_cx_1:confirmed');
  });
});

describe('what it refuses', () => {
  it('refuses a deposit to an address nobody owns', async () => {
    // Unlike a naira deposit this cannot go to suspense: an address we do not
    // recognise is not ours, so the money is not ours and posting it would
    // invent a liability.
    await expect(
      handleCryptoDeposit(parseCryptoWebhook(body()), context({ resolve: async () => undefined })),
    ).rejects.toThrow(/no customer owns/);
  });

  it('refuses an asset that does not match the address', async () => {
    // An address is issued for one asset on one chain. Believing the payload
    // over the address would credit the wrong balance.
    const wrong = body({}, { currency: 'BTC' });
    await expect(handleCryptoDeposit(parseCryptoWebhook(wrong), context())).rejects.toThrow(
      /landed on a USDT address/,
    );
  });

  it('refuses an unrecognised chain', async () => {
    const wrong = body({}, { chain: 'solana' });
    await expect(handleCryptoDeposit(parseCryptoWebhook(wrong), context())).rejects.toThrow(
      /unrecognised chain/,
    );
  });

  it('maps chain aliases the provider may use', async () => {
    for (const chain of ['trc20', 'TRON', 'trx']) {
      const out = await handleCryptoDeposit(
        parseCryptoWebhook(body({}, { chain })),
        context(),
      );
      expect(out.network).toBe('tron');
    }
  });

  it('throws on an unrecognised event rather than acknowledging it', async () => {
    const other = body({ event: 'crypto.deposit.something' });
    await expect(handleCryptoDeposit(parseCryptoWebhook(other), context())).rejects.toThrow(
      ProviderContractError,
    );
  });

  it('refuses an amount JSON.parse has already rounded', async () => {
    const unsafe = body({}, { amount: 12345678901234567890 });
    await expect(handleCryptoDeposit(parseCryptoWebhook(unsafe), context())).rejects.toThrow(
      /string/,
    );
  });

  it('refuses a payload with no transaction hash', () => {
    // The only thing a customer can point at when they say "I sent it".
    const noHash = JSON.stringify({
      event_id: 'e',
      event: 'crypto.deposit.pending',
      created_at: '2026-08-20T10:00:00Z',
      data: {
        id: 'd',
        address: 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
        chain: 'tron',
        currency: 'USDT',
        amount: '1',
        confirmations: 1,
      },
    });
    expect(() => parseCryptoWebhook(noHash)).toThrow(ProviderContractError);
  });

  it('carries the output index, because one transaction can pay twice', async () => {
    const second = body({}, { output_index: 1 });
    const out = await handleCryptoDeposit(parseCryptoWebhook(second), context());
    expect(out.outputIndex).toBe(1);
  });
});
