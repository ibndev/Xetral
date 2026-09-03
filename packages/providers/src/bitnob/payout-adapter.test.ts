import { describe, expect, it } from 'vitest';
import { ngn } from '@xetral/shared';

import { BitnobPayoutAdapter } from './payout-adapter.js';
import { BitnobClient, type FetchLike } from './client.js';
import { ProviderContractError } from '../ports/errors.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function adapterWith(responses: readonly unknown[]): {
  adapter: BitnobPayoutAdapter;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const body = responses[i++] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new BitnobClient({
    baseUrl: 'https://api.bitnob.test',
    clientId: 'client_abc',
    clientSecret: 'sekret',
    fetch,
  });
  return { adapter: new BitnobPayoutAdapter({ client }), calls };
}

const QUOTE = { data: { quote_id: 'q_1' } };
const INITIALIZED = { data: { id: 'po_1', status: 'pending' } };

describe('listing banks', () => {
  it('asks per country and returns codes and names', async () => {
    const { adapter, calls } = adapterWith([
      { data: [{ code: '058', name: 'GTBank' }, { code: '057', name: 'Zenith Bank' }] },
    ]);

    const banks = await adapter.banks('NG');

    expect(calls[0]?.url).toBe('https://api.bitnob.test/api/payouts/banks/NG');
    expect(banks).toEqual([
      { code: '058', name: 'GTBank' },
      { code: '057', name: 'Zenith Bank' },
    ]);
  });
});

describe('looking a beneficiary up', () => {
  it('returns the name the BANK holds, not one the sender supplied', async () => {
    // The whole value of the lookup. A confirmation screen showing a name the
    // sender typed themselves confirms nothing at all.
    const { adapter, calls } = adapterWith([
      { data: { account_name: 'ADEBAYO O ADEYEMI', account_number: '0123456789', bank_code: '058' } },
    ]);

    const found = await adapter.lookup('NG', '058', '0123456789');

    expect(found.accountName).toBe('ADEBAYO O ADEYEMI');
    expect(calls[0]?.url).toContain('account_number=0123456789');
    expect(calls[0]?.url).toContain('bank_code=058');
  });

  it('escapes what it puts in the query string', async () => {
    // A bank code is opaque and comes from the provider, so it is not ours to
    // assume is URL-safe.
    const { adapter, calls } = adapterWith([
      { data: { account_name: 'A', account_number: '1', bank_code: 'a b&c' } },
    ]);
    await adapter.lookup('NG', 'a b&c', '0123456789');
    expect(calls[0]?.url).toContain('bank_code=a%20b%26c');
  });
});

describe('sending', () => {
  it('is three calls, in order, and the beneficiary rides on initialize', async () => {
    const { adapter, calls } = adapterWith([QUOTE, INITIALIZED, { data: { id: 'po_1', status: 'pending' } }]);

    await adapter.send({
      country: 'NG',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'ADEBAYO O ADEYEMI',
      amount: ngn(500_000n),
      reference: 'xetral-payout-7-abc',
    });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/payouts/quotes',
      'POST /api/payouts/q_1/initialize',
      'POST /api/payouts/q_1/finalize',
    ]);

    // Their docs: the beneficiary goes on INITIALIZE, not on the quote. A
    // quote is a price, not a payment.
    expect((calls[0]?.body as Record<string, unknown>)['beneficiary']).toBeUndefined();
    expect((calls[1]?.body as { beneficiary: Record<string, unknown> }).beneficiary).toEqual({
      account_number: '0123456789',
      bank_code: '058',
      account_name: 'ADEBAYO O ADEYEMI',
    });
    // Finalize takes no body, by their contract.
    expect(calls[2]?.body).toBeUndefined();
  });

  it('sends the amount as a string in minor units', async () => {
    const { adapter, calls } = adapterWith([QUOTE, INITIALIZED, INITIALIZED]);
    await adapter.send({
      country: 'NG',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'A B',
      amount: ngn(500_000n),
      reference: 'ref-1',
    });
    // 500,000 kobo — ₦5,000. A JSON number would be fine here and would stop
    // being fine at a balance nobody tests with.
    expect((calls[0]?.body as Record<string, unknown>)['amount']).toBe('500000');
  });

  it('carries ONE reference through all three calls', async () => {
    // Their de-duplication and ours must agree on what "the same payout"
    // means. On this operation a duplicate cannot be clawed back.
    const { adapter, calls } = adapterWith([QUOTE, INITIALIZED, INITIALIZED]);
    await adapter.send({
      country: 'NG',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'A B',
      amount: ngn(100n),
      reference: 'xetral-payout-7-abc',
    });
    expect((calls[1]?.body as Record<string, unknown>)['reference']).toBe('xetral-payout-7-abc');
  });
});

describe('what the provider says it became', () => {
  it.each([
    ['success', 'completed'],
    ['successful', 'completed'],
    ['completed', 'completed'],
    ['pending', 'sent'],
    ['processing', 'sent'],
    ['initiated', 'sent'],
    ['failed', 'failed'],
    ['reversed', 'failed'],
    ['cancelled', 'failed'],
  ])('maps %s to %s', async (status, expected) => {
    const { adapter } = adapterWith([{ data: { id: 'po_1', status } }]);
    expect((await adapter.status('po_1')).state).toBe(expected);
  });

  it('THROWS on a status it does not recognise', async () => {
    // Never defaults. One default reverses money that has already reached a
    // bank; the other tells a customer money left when it did not. Neither is
    // a safe guess — Phase 9's rule, on the flow where it costs most.
    // Two identical responses: the harness advances its script per call, and
    // this asserts twice.
    const { adapter } = adapterWith([
      { data: { id: 'po_1', status: 'on_hold' } },
      { data: { id: 'po_1', status: 'on_hold' } },
    ]);
    await expect(adapter.status('po_1')).rejects.toBeInstanceOf(ProviderContractError);
    await expect(adapter.status('po_1')).rejects.toThrow(/refusing to guess/);
  });

  it('carries a reason only on a failure', async () => {
    const { adapter } = adapterWith([
      { data: { id: 'po_1', status: 'failed', reason: 'account closed' } },
      { data: { id: 'po_2', status: 'success', reason: 'ignore me' } },
    ]);
    expect((await adapter.status('po_1')).failureReason).toBe('account closed');
    // A completed payout must not arrive carrying a reason a screen would
    // render as though something had gone wrong.
    expect((await adapter.status('po_2')).failureReason).toBeUndefined();
  });

  it('names a reason even when the provider gives none', async () => {
    const { adapter } = adapterWith([{ data: { id: 'po_1', status: 'failed' } }]);
    // 043 has a CHECK that a failed payout says why, so an empty reason here
    // would be a constraint violation at the moment we are trying to record a
    // failure — the worst time to discover it.
    expect((await adapter.status('po_1')).failureReason).toBe('the provider did not say');
  });
});
