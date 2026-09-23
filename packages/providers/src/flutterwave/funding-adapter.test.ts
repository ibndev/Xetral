import { describe, expect, it } from 'vitest';
import { FlutterwaveClient } from './client.js';
import { FlutterwaveFundingAdapter } from './funding-adapter.js';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type { CreateVirtualAccountRequest } from '../ports/funding.js';

/**
 * A naira account number through Flutterwave, and the money that lands in it.
 *
 * Three claims, each pinned on the wire rather than on a call count: the BVN
 * is asked for only when a naira account is opened and reaches the body only
 * then; a deposit is credited on THEIR answer about THEIR transaction id; and
 * the account's history is filtered on our side as well as theirs, because a
 * query parameter a server ignores returns everybody's money.
 */
function stub(route: (url: string) => unknown): {
  client: FlutterwaveClient;
  sent: { url: string; body: unknown }[];
} {
  const sent: { url: string; body: unknown }[] = [];
  const client = new FlutterwaveClient({
    baseUrl: 'https://api.flutterwave.com',
    secretKey: 'FLWSECK_TEST-xxx',
    fetch: async (url, init) => {
      sent.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(route(url)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, sent };
}

const ACCOUNT = {
  status: 'success',
  message: 'Virtual account created',
  data: {
    flw_ref: 'FLW-1',
    order_ref: 'URF_1',
    account_number: '7824822527',
    bank_name: 'WEMA BANK',
  },
};

function request(
  currency: 'NGN' | 'GHS',
  bvn: string | undefined,
  asked: { count: number } = { count: 0 },
): CreateVirtualAccountRequest {
  return {
    currency,
    idempotencyKey: `xetral-va-42-${currency}`,
    customer: {
      reference: '42',
      email: 'ada@example.ng',
      firstName: 'Ada',
      lastName: 'Obi',
      phone: '+2348031234567',
      providerCustomerId: undefined,
      bvn: async () => {
        asked.count += 1;
        return bvn;
      },
    },
  };
}

describe('opening a permanent naira account', () => {
  it('sends the BVN, permanently, under our own reference', async () => {
    const { client, sent } = stub(() => ACCOUNT);
    const account = await new FlutterwaveFundingAdapter(client).createVirtualAccount(
      request('NGN', '12345678901'),
    );

    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/virtual-account-numbers');
    expect(sent[0]?.body).toMatchObject({
      bvn: '12345678901',
      is_permanent: true,
      currency: 'NGN',
      tx_ref: 'xetral-va-42-NGN',
    });
    // THE REFERENCE, NOT THE EMAIL — every payment into the account is echoed
    // back under it, and an email is shared with every checkout they paid.
    expect(account.providerCustomerRef).toBe('xetral-va-42-NGN');
    expect(account.accountNumber).toBe('7824822527');
  });

  it('refuses an unverified customer itself, before anything is sent', async () => {
    const { client, sent } = stub(() => ACCOUNT);
    const refusal = new FlutterwaveFundingAdapter(client).createVirtualAccount(
      request('NGN', undefined),
    );
    await expect(refusal).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(refusal).rejects.toMatchObject({ providerCode: 'kyc_required' });
    expect(sent).toHaveLength(0);
  });

  it('does not unseal a BVN for a currency that does not need one', async () => {
    const asked = { count: 0 };
    const { client, sent } = stub(() => ACCOUNT);
    await new FlutterwaveFundingAdapter(client).createVirtualAccount(
      request('GHS', '12345678901', asked),
    );
    expect(asked.count).toBe(0);
    expect(sent[0]?.body).not.toHaveProperty('bvn');
  });
});

function txn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 285959875,
    tx_ref: 'xetral-va-42-NGN',
    amount: 5000,
    currency: 'NGN',
    status: 'successful',
    payment_type: 'bank_transfer',
    created_at: '2026-09-23T09:00:00.000Z',
    meta: { originatorname: 'ADA OBI', bankname: 'Kuda', originatoraccountnumber: '0123456789' },
    ...overrides,
  };
}

describe('confirming a deposit', () => {
  it('reads it by THEIR transaction id and converts from major units once', async () => {
    const { client, sent } = stub(() => ({ status: 'success', data: txn({ amount: 5000.5 }) }));
    const deposit = await new FlutterwaveFundingAdapter(client).verifyDeposit('285959875');

    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/transactions/285959875/verify');
    expect(deposit?.providerReference).toBe('285959875');
    // 5,000.50 naira is 500,050 kobo — not 5,000 and not 500,050,000.
    expect(deposit?.amountMinor).toBe(500_050n);
    expect(deposit?.accountReference).toBe('xetral-va-42-NGN');
    expect(deposit?.senderName).toBe('ADA OBI');
  });

  it('credits nothing on anything but `successful`', async () => {
    for (const status of ['pending', 'failed', 'success']) {
      const { client } = stub(() => ({ status: 'success', data: txn({ status }) }));
      expect(await new FlutterwaveFundingAdapter(client).verifyDeposit('285959875')).toBeUndefined();
    }
  });

  it('refuses an answer about some other transaction', async () => {
    const { client } = stub(() => ({ status: 'success', data: txn({ id: 1 }) }));
    await expect(
      new FlutterwaveFundingAdapter(client).verifyDeposit('285959875'),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });
});

describe('listing what landed in one account', () => {
  const lookup = { providerAccountId: 'URF_1', providerCustomerRef: 'xetral-va-42-NGN' };

  it('keeps only this account’s successful payments, whatever the server returned', async () => {
    // A server that ignored `tx_ref=` would hand back every transaction on
    // the integration. Each would otherwise be credited to this customer.
    const { client, sent } = stub(() => ({
      status: 'success',
      data: [
        txn({ id: 1 }),
        txn({ id: 2, tx_ref: 'somebody-elses-link' }),
        txn({ id: 3, status: 'failed' }),
        txn({ id: 4, tx_ref: null }),
      ],
    }));
    const deposits = await new FlutterwaveFundingAdapter(client).listDeposits(lookup);

    expect(sent[0]?.url).toBe(
      'https://api.flutterwave.com/v3/transactions?tx_ref=xetral-va-42-NGN&status=successful',
    );
    expect(deposits.map((d) => d.providerReference)).toEqual(['1']);
  });

  it('asks nothing for an account keyed on an email address', async () => {
    const { client, sent } = stub(() => ({ status: 'success', data: [] }));
    const deposits = await new FlutterwaveFundingAdapter(client).listDeposits({
      providerAccountId: 'URF_1',
      providerCustomerRef: 'ada@example.ng',
    });
    expect(deposits).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});
