import { describe, expect, it } from 'vitest';

import { PaystackPayoutAdapter } from './payout-adapter.js';
import { PaystackClient, type PaystackFetch } from './client.js';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import { ngn } from '@xetral/shared';

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function adapterWith(responses: readonly unknown[]): {
  adapter: PaystackPayoutAdapter;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: PaystackFetch = async (url, init) => {
    calls.push({
      path: url.replace('https://api.paystack.test', ''),
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = responses[i++] ?? { status: true, data: {} };
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new PaystackClient({
    baseUrl: 'https://api.paystack.test',
    secretKey: 'sk_test_key',
    fetch,
  });
  return { adapter: new PaystackPayoutAdapter({ client }), calls };
}

describe('the bank list', () => {
  it('asks for the country by NAME and the currency, not by ISO code', async () => {
    // Paystack's `country` parameter is a slug — `nigeria`, not `NG` — and
    // sending the code returns an EMPTY list rather than an error. A screen
    // reporting "no banks" is the same symptom as a broken credential, which
    // is exactly the confusion this adapter exists to end.
    const { adapter, calls } = adapterWith([
      { status: true, data: [{ name: 'GTBank', code: '058', active: true, type: 'nuban' }] },
    ]);

    const banks = await adapter.banks('NG');
    expect(calls[0]?.path).toContain('country=nigeria');
    expect(calls[0]?.path).toContain('currency=NGN');
    expect(banks).toEqual([{ code: '058', name: 'GTBank' }]);
  });

  it('drops rails that cannot receive a bank transfer', async () => {
    // Their catalogue carries mobile money wallets and inactive entries.
    // Offering one under a heading that says "Bank account" produces a
    // selection that fails at the lookup — which reads to the customer as
    // their own account number being wrong.
    const { adapter } = adapterWith([
      {
        status: true,
        data: [
          { name: 'GTBank', code: '058', active: true, type: 'nuban' },
          { name: 'Closed Bank', code: '999', active: false, type: 'nuban' },
          { name: 'MTN MoMo', code: 'MTN', active: true, type: 'mobile_money' },
        ],
      },
    ]);

    expect(await adapter.banks('NG')).toEqual([{ code: '058', name: 'GTBank' }]);
  });

  it('REFUSES a country this rail does not serve, rather than reporting an outage', async () => {
    // A rejection is not ill health. Counting a customer's unsupported
    // country against 037's failure rate is how a provider alert becomes
    // something people mute.
    const { adapter, calls } = adapterWith([]);
    await expect(adapter.banks('FR')).rejects.toBeInstanceOf(ProviderRejectedError);
    expect(calls).toHaveLength(0);
  });
});

describe('the account lookup', () => {
  it("returns the BANK'S name, and never anything the sender supplied", async () => {
    const { adapter, calls } = adapterWith([
      { status: true, data: { account_number: '0123456789', account_name: 'ADEBAYO O ADEYEMI' } },
    ]);

    const found = await adapter.lookup('NG', '058', '0123456789');
    expect(calls[0]?.path).toContain('account_number=0123456789');
    expect(calls[0]?.path).toContain('bank_code=058');
    expect(found.accountName).toBe('ADEBAYO O ADEYEMI');
  });
});

describe('sending', () => {
  it('registers the recipient FIRST, then moves the money', async () => {
    const { adapter, calls } = adapterWith([
      { status: true, data: { recipient_code: 'RCP_1' } },
      { status: true, data: { id: 987, status: 'pending' } },
    ]);

    const receipt = await adapter.send({
      country: 'NG',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'ADEBAYO O ADEYEMI',
      amount: ngn(500_000n),
      reference: 'xetral:payout-1',
    });

    expect(calls[0]?.path).toBe('/transferrecipient');
    expect(calls[1]?.path).toBe('/transfer');
    // The name that goes to Paystack is the LOOKUP'S, carried through.
    expect((calls[0]?.body as { name: string }).name).toBe('ADEBAYO O ADEYEMI');
    expect(receipt).toEqual({ providerPayoutId: '987', state: 'sent' });
  });

  it('sends the amount as MINOR UNITS, and as a string', async () => {
    // `JSON.stringify` throws on a bigint, and the tempting fix — a global
    // serialiser — is how a money amount silently becomes a JSON number
    // somewhere else six months later. A string cannot be rounded.
    const { adapter, calls } = adapterWith([
      { status: true, data: { recipient_code: 'RCP_1' } },
      { status: true, data: { id: 1, status: 'success' } },
    ]);

    await adapter.send({
      country: 'NG',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'A B',
      amount: ngn(90_071_992_547_409_940n),
      reference: 'xetral:payout-2',
    });

    expect((calls[1]?.body as { amount: unknown }).amount).toBe('90071992547409940');
  });

  it('carries OUR reference, so a retry is one payout at their end too', async () => {
    const { adapter, calls } = adapterWith([
      { status: true, data: { recipient_code: 'RCP_1' } },
      { status: true, data: { id: 2, status: 'success' } },
    ]);

    await adapter.send({
      country: 'NG',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'A B',
      amount: ngn(1000n),
      reference: 'xetral:payout-3',
    });

    expect((calls[1]?.body as { reference: string }).reference).toBe('xetral:payout-3');
  });
});

describe('what became of it', () => {
  it('maps success, failure and in-flight to three different answers', async () => {
    for (const [status, state] of [
      ['success', 'completed'],
      ['failed', 'failed'],
      ['reversed', 'failed'],
      ['pending', 'sent'],
      ['otp', 'sent'],
    ] as const) {
      const { adapter } = adapterWith([{ status: true, data: { id: 5, status } }]);
      expect((await adapter.status('5')).state).toBe(state);
    }
  });

  it('THROWS on a status it does not recognise, rather than guessing', async () => {
    // One default reverses a payout already on its way to somebody; the other
    // tells a customer money left when it did not. Neither is a safe guess —
    // the rule Phase 9 records for crypto, applied here.
    const { adapter } = adapterWith([{ status: true, data: { id: 6, status: 'quantum' } }]);
    await expect(adapter.status('6')).rejects.toBeInstanceOf(ProviderContractError);
  });
});
