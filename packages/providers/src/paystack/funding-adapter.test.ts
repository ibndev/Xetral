import { describe, expect, it } from 'vitest';

import { PaystackFundingAdapter } from './funding-adapter.js';
import { PaystackClient, type PaystackFetch } from './client.js';
import { ProviderRejectedError } from '../ports/errors.js';
import type { CreateVirtualAccountRequest } from '../ports/funding.js';

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly auth: string | undefined;
}

function adapterWith(
  responses: readonly unknown[],
  options: { preferredBank?: string } = {},
): { adapter: PaystackFundingAdapter; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: PaystackFetch = async (url, init) => {
    calls.push({
      path: url.replace('https://api.paystack.test', ''),
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      auth: (init.headers as Record<string, string>)['authorization'],
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
  return {
    adapter: new PaystackFundingAdapter({
      client,
      preferredBank: options.preferredBank,
    }),
    calls,
  };
}

const NEW_CUSTOMER: CreateVirtualAccountRequest = {
  currency: 'NGN',
  idempotencyKey: 'xetral-va-42-NGN',
  customer: {
    reference: '42',
    email: 'ada@example.ng',
    firstName: 'Ada',
    lastName: 'Obi',
    phone: '+2348031234567',
    providerCustomerId: undefined,
  },
};

const CUSTOMER_CREATED = { status: true, data: { customer_code: 'CUS_abc' } };
const NO_ACCOUNTS = { status: true, data: [] };
const ACCOUNT_CREATED = {
  status: true,
  data: {
    id: 77,
    account_number: '9911223344',
    account_name: 'ADA OBI',
    bank: { name: 'Wema Bank' },
    active: true,
  },
};

describe('opening an account for somebody who has not been verified', () => {
  it('creates a Paystack customer from what signup already holds', async () => {
    /*
     * THE WHOLE REASON THIS ADAPTER EXISTS. Bitnob refuses without a verified
     * BVN; Paystack takes a name and an email address, which is what CBN
     * tier 1 asks for and what tier 0's ₦50,000 ceiling already assumes.
     */
    const { adapter, calls } = adapterWith([CUSTOMER_CREATED, NO_ACCOUNTS, ACCOUNT_CREATED]);
    const account = await adapter.createVirtualAccount(NEW_CUSTOMER);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/customer');
    expect(calls[0]?.body).toMatchObject({
      email: 'ada@example.ng',
      first_name: 'Ada',
      last_name: 'Obi',
      phone: '+2348031234567',
    });
    // No BVN, no identity document, nothing a customer has to go and find.
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/bvn|nin|identification/i);

    expect(account.accountNumber).toBe('9911223344');
    expect(account.bankName).toBe('Wema Bank');
    expect(account.accountName).toBe('ADA OBI');
  });

  it('bears the secret key rather than signing the request', async () => {
    // Correct here and wrong one directory away: Bitnob v2 signs and bears
    // nothing. Copying either scheme onto the other is a 401 that reads as a
    // bad key.
    const { adapter, calls } = adapterWith([CUSTOMER_CREATED, NO_ACCOUNTS, ACCOUNT_CREATED]);
    await adapter.createVirtualAccount(NEW_CUSTOMER);
    expect(calls[0]?.auth).toBe('Bearer sk_test_key');
  });

  it('reuses a customer the platform already has, rather than making a second', async () => {
    const { adapter, calls } = adapterWith([NO_ACCOUNTS, ACCOUNT_CREATED]);
    await adapter.createVirtualAccount({
      ...NEW_CUSTOMER,
      customer: { ...NEW_CUSTOMER.customer, providerCustomerId: 'CUS_existing' },
    });
    expect(calls.map((c) => c.path)).toEqual([
      '/dedicated_account?customer=CUS_existing',
      '/dedicated_account',
    ]);
  });

  it('names the preferred bank only when one is configured', async () => {
    // A deployment value, because Paystack test integrations issue Titan and
    // live ones are usually Wema, and a business can be enabled for one and
    // not the other. Hardcoding either makes a correct configuration fail.
    const withBank = adapterWith([CUSTOMER_CREATED, NO_ACCOUNTS, ACCOUNT_CREATED], {
      preferredBank: 'wema-bank',
    });
    await withBank.adapter.createVirtualAccount(NEW_CUSTOMER);
    expect(withBank.calls[2]?.body).toEqual({ customer: 'CUS_abc', preferred_bank: 'wema-bank' });

    const without = adapterWith([CUSTOMER_CREATED, NO_ACCOUNTS, ACCOUNT_CREATED]);
    await without.adapter.createVirtualAccount(NEW_CUSTOMER);
    expect(without.calls[2]?.body).toEqual({ customer: 'CUS_abc' });
  });
});

describe('not issuing a second account number', () => {
  it('returns the one Paystack already has rather than creating another', async () => {
    /*
     * `POST /dedicated_account` takes no idempotency key, so a retry after a
     * timeout would leave a SECOND live account receiving money against a row
     * we never wrote. Our unique index stops the second row; only this stops
     * the second number.
     */
    const { adapter, calls } = adapterWith([
      CUSTOMER_CREATED,
      { status: true, data: [{ id: 5, account_number: '0099887766', account_name: 'ADA OBI', bank: { name: 'Titan Bank' }, active: true }] },
    ]);

    const account = await adapter.createVirtualAccount(NEW_CUSTOMER);

    expect(account.accountNumber).toBe('0099887766');
    // Three calls would mean it created one anyway.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/dedicated_account')).toBe(false);
  });

  it('ignores a deactivated account and issues a new one', async () => {
    const { adapter } = adapterWith([
      CUSTOMER_CREATED,
      { status: true, data: [{ id: 5, account_number: '0000000000', account_name: 'X', bank: { name: 'B' }, active: false }] },
      ACCOUNT_CREATED,
    ]);
    expect((await adapter.createVirtualAccount(NEW_CUSTOMER)).accountNumber).toBe('9911223344');
  });
});

describe('what Paystack says no to', () => {
  it('treats status:false on a 200 as a refusal', async () => {
    /*
     * Paystack refuses with a 200 body carrying `status: false`. Reading only
     * the HTTP code would hand the caller a body with no `data` in it, and
     * the failure would surface as a schema error far away from the reason.
     */
    const calls: Call[] = [];
    const fetch: PaystackFetch = async (url, init) => {
      calls.push({ path: url, method: String(init.method), body: undefined, auth: undefined });
      return new Response(
        JSON.stringify({ status: false, message: 'Customer not found' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const adapter = new PaystackFundingAdapter({
      client: new PaystackClient({
        baseUrl: 'https://api.paystack.test',
        secretKey: 'sk',
        fetch,
      }),
      preferredBank: undefined,
    });

    await expect(adapter.getVirtualAccount('77')).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(adapter.getVirtualAccount('77')).rejects.toThrow(/Customer not found/);
  });

  it('refuses a currency this rail does not carry', async () => {
    const { adapter } = adapterWith([]);
    await expect(
      adapter.createVirtualAccount({ ...NEW_CUSTOMER, currency: 'USD' }),
    ).rejects.toThrow(/this rail are NGN/);
  });

  it('refuses without a secret key, naming where to put one', async () => {
    // NOT `Bearer undefined`, which Paystack answers 401 to — and a 401 reads
    // as "the key is wrong" when the truth is that there is no key.
    const client = new PaystackClient({
      baseUrl: 'https://api.paystack.test',
      secretKey: async () => undefined,
      fetch: () => {
        throw new Error('the request was sent without a key');
      },
    });
    const adapter = new PaystackFundingAdapter({ client, preferredBank: undefined });
    await expect(adapter.getVirtualAccount('1')).rejects.toThrow(
      /no Paystack secret key is configured/,
    );
  });
});

describe('reading deposits back for reconciliation', () => {
  it('carries THEIR reference, so a late webhook is a replay', async () => {
    const { adapter, calls } = adapterWith([
      {
        status: true,
        data: [
          {
            id: 1,
            reference: 'ps_ref_001',
            amount: 500_000,
            currency: 'NGN',
            status: 'success',
            paid_at: '2026-09-03T09:00:00.000Z',
            authorization: { sender_bank: 'Kuda Bank', account_name: 'ADA OBI' },
          },
        ],
      },
    ]);

    const deposits = await adapter.listDeposits('CUS_abc');

    expect(calls[0]?.path).toBe('/transaction?customer=CUS_abc&status=success');
    expect(deposits[0]?.providerReference).toBe('ps_ref_001');
    expect(deposits[0]?.amountMinor).toBe(500_000n);
    expect(deposits[0]?.senderBank).toBe('Kuda Bank');
  });

  it('refuses an amount that arrived as a float', async () => {
    // This number becomes somebody's balance. By the time a decimal is a JS
    // number the precision is already gone.
    const { adapter } = adapterWith([
      { status: true, data: [{ id: 1, reference: 'r', amount: 5000.5, currency: 'NGN' }] },
    ]);
    await expect(adapter.listDeposits('CUS_abc')).rejects.toThrow();
  });
});
