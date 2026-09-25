import { describe, expect, it } from 'vitest';

import { BitnobFundingAdapter } from './funding-adapter.js';
import { BitnobClient } from './client.js';
import { ProviderRejectedError } from '../ports/errors.js';
import type { CreateVirtualAccountRequest } from '../ports/funding.js';

/**
 * THE PREREQUISITE THAT MOVED, and the reason this file exists.
 *
 * `FundingPort` used to take a `providerCustomerId` and nothing else, which
 * was Bitnob's requirement written into the shared interface — so every rail
 * inherited it, and an unverified customer had no way to put money in at all.
 * The port now carries the identity the platform HAS, and each adapter decides
 * what it needs from it.
 *
 * That is only an improvement if the requirement survived the move. If it did
 * not, this adapter would send an unverified customer to Bitnob and get back
 * a provider error nobody can act on. So the refusal is asserted here, in the
 * one place it is now true — and `funding.e2e.test.ts` asserts the other half:
 * that the same customer IS issued an account on the default rail.
 */

/** A client that would explode if anything actually called it. Nothing here
 *  should reach the network: the refusal happens before the request. */
function adapter(): BitnobFundingAdapter {
  const client = new BitnobClient({
    baseUrl: 'https://api.bitnob.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetch: () => {
      throw new Error('the adapter must refuse BEFORE it calls Bitnob');
    },
  });
  return new BitnobFundingAdapter({ client, amountUnit: 'kobo' });
}

function request(providerCustomerId: string | undefined): CreateVirtualAccountRequest {
  return {
    customer: {
      reference: 'user-1',
      email: 'ada@example.ng',
      firstName: 'Ada',
      lastName: 'Obi',
      phone: '+2348031234567',
      providerCustomerId,
    },
    currency: 'NGN',
    idempotencyKey: 'key-1',
  };
}

describe('Bitnob will not open an account for somebody it has not verified', () => {
  it('refuses a customer with no verified BVN, and says why', async () => {
    await expect(adapter().createVirtualAccount(request(undefined))).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });

  it('refuses the same way whatever provider customer id is on file', async () => {
    // A blank string is what a row written by a path that "set" the mapping
    // without one looks like. Treating it as present would send Bitnob an
    // empty customer id and turn a clear refusal into a provider error.
    await expect(adapter().createVirtualAccount(request(''))).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });

  it('carries a code the API can translate, not just a message', async () => {
    // `kyc_required` is what reaches a customer. A refusal whose only content
    // is prose is one every caller has to pattern-match on.
    const error = await adapter()
      .createVirtualAccount(request(undefined))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).providerCode).toBe('kyc_required');
  });

  it('refuses BEFORE calling Bitnob', async () => {
    // The fetch above throws a DIFFERENT error, so this passes only while the
    // check runs first. Asking Bitnob and relaying their refusal would work
    // too, and would spend a network call to learn something we already knew.
    const error = await adapter()
      .createVirtualAccount(request(undefined))
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('must refuse BEFORE');
  });
});

/**
 * A VERIFIED CUSTOMER, AGAINST BITNOB'S PUBLISHED v2 SHAPES.
 *
 * Routed by URL rather than by position, because the adapter legitimately
 * makes a lookup, maybe a registration, then the account call — and a
 * positional script hands one call's body to another the moment that count
 * changes (`v4Stub`'s lesson in the Flutterwave suite).
 */
function stub(routes: Record<string, unknown>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = new BitnobClient({
    baseUrl: 'https://api.bitnob.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetch: async (url: string, init: RequestInit) => {
      const path = url.replace('https://api.bitnob.test', '');
      const method = init.method ?? 'GET';
      calls.push({ method, url: path, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const key = `${method} ${path.split('?')[0]}`;
      const answer = routes[key];
      if (answer === undefined) return new Response('{"message":"no route"}', { status: 404 });
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  });
  return { calls, adapter: new BitnobFundingAdapter({ client, amountUnit: 'kobo' }) };
}

function verified(providerCustomerId: string | undefined): CreateVirtualAccountRequest {
  const base = request(providerCustomerId);
  return {
    ...base,
    customer: {
      ...base.customer,
      bvn: async () => '22345678901',
      dateOfBirth: async () => '1994-03-21',
    },
  };
}

/** `data.virtual_account`, exactly as their specification answers. */
const NESTED_ACCOUNT = {
  success: true,
  data: {
    virtual_account: {
      id: 'va-1',
      account_number: '9000074928',
      account_name: 'Ada Obi',
      bank_name: 'Sandbox Bank',
      currency: 'NGN',
      status: 'active',
    },
  },
};

describe('a verified customer is registered at Bitnob, not described by a string we invented', () => {
  it('registers the customer with the BVN on it, then opens the account for THAT id', async () => {
    const { calls, adapter: port } = stub({
      'GET /api/customers': { data: { customers: [] } },
      'POST /api/customers': { data: { id: 'bn-cust-1' } },
      'POST /api/virtual-accounts': NESTED_ACCOUNT,
    });
    // `xetral-…` is what KYC approval writes; Bitnob never issued it.
    const account = await port.createVirtualAccount(verified('xetral-0000'));

    expect(account.accountNumber).toBe('9000074928');
    const register = calls.find((c) => c.method === 'POST' && c.url === '/api/customers');
    expect(register?.body).toMatchObject({
      email: 'ada@example.ng',
      customer_type: 'individual',
      id_type: 'bvn',
      id_number: '22345678901',
      date_of_birth: '1994-03-21',
    });
    const open = calls.find((c) => c.url === '/api/virtual-accounts');
    expect(open?.body).toMatchObject({ customer_id: 'bn-cust-1', currency: 'NGN' });
  });

  it('finds an existing customer by email rather than registering a second one', async () => {
    const { calls, adapter: port } = stub({
      'GET /api/customers': {
        data: {
          customers: [
            // A server that ignored the filter: somebody else first.
            { id: 'someone-else', email: 'other@example.ng', id_number: '1' },
            { id: 'bn-cust-2', email: 'ADA@example.ng', id_number: '22345678901' },
          ],
        },
      },
      'POST /api/virtual-accounts': NESTED_ACCOUNT,
    });
    await port.createVirtualAccount(verified(undefined));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/customers')).toBe(false);
    expect(calls.find((c) => c.url === '/api/virtual-accounts')?.body).toMatchObject({
      customer_id: 'bn-cust-2',
    });
  });

  it('completes an existing customer that has no BVN yet', async () => {
    const { calls, adapter: port } = stub({
      'GET /api/customers': { data: { customers: [{ id: 'bn-cust-3', email: 'ada@example.ng' }] } },
      'PUT /api/customers/bn-cust-3': { data: { id: 'bn-cust-3' } },
      'POST /api/virtual-accounts': NESTED_ACCOUNT,
    });
    await port.createVirtualAccount(verified(undefined));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      id_type: 'bvn',
      id_number: '22345678901',
    });
  });

  it('uses a real Bitnob customer id as given', async () => {
    const { calls, adapter: port } = stub({ 'POST /api/virtual-accounts': NESTED_ACCOUNT });
    await port.createVirtualAccount(verified('019edc65-bc3f-7bc4-980b-e328a940ef5d'));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/virtual-accounts']);
  });

  it('refuses with nothing sent when there is a BVN and no date of birth', async () => {
    const base = request(undefined);
    const error = await adapter()
      .createVirtualAccount({
        ...base,
        customer: { ...base.customer, bvn: async () => '22345678901', dateOfBirth: async () => undefined },
      })
      .catch((e: unknown) => e);
    expect((error as ProviderRejectedError).providerCode).toBe('kyc_required');
  });
});

describe('deposits, in the v2 shape', () => {
  it('reads data.transactions and counts only completed credits', async () => {
    const { adapter: port } = stub({
      'GET /api/virtual-accounts/va-1/transactions': {
        data: {
          transactions: [
            { id: 't-1', amount: '100000', currency: 'NGN', type: 'credit', status: 'completed' },
            { id: 't-2', amount: '5000', currency: 'NGN', type: 'credit', status: 'pending' },
            { id: 't-3', amount: '7000', currency: 'NGN', type: 'debit', status: 'completed' },
          ],
        },
      },
    });
    const deposits = await port.listDeposits({ providerAccountId: 'va-1', providerCustomerRef: undefined });
    expect(deposits.map((d) => [d.providerReference, d.amountMinor])).toEqual([['t-1', 100000n]]);
  });
});
