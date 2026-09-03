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
  it('refuses when there is no provider customer, and says why', async () => {
    await expect(adapter().createVirtualAccount(request(undefined))).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });

  it('refuses an EMPTY provider customer the same way', async () => {
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
