import { describe, expect, it } from 'vitest';
import { VtpassAdapter, vtpassRequestId, koboToNaira, nairaToKobo } from './vtpass-adapter.js';
import { fulfilmentContract, scriptedFetch } from '../ports/fulfilment.contract.js';
import { ProviderRejectedError } from '../ports/errors.js';
import { supportsVerification } from '../ports/fulfilment.js';

/** A fixed instant, so a request_id derived from it is stable across runs. */
const INITIATED_AT = new Date('2026-02-07T17:30:00.000Z');

const variations = {
  content: {
    variations: [
      { variation_code: 'mtn-10gb', name: 'MTN 10GB Monthly', variation_amount: '4500.00' },
      { variation_code: 'mtn-1gb', name: 'MTN 1GB Daily', variation_amount: '500.00' },
    ],
  },
};

const delivered = {
  code: '000',
  content: { transactions: { status: 'delivered', transactionId: 'vt_9911' } },
};

function harness() {
  const transport = scriptedFetch();
  return {
    transport,
    port: new VtpassAdapter({
      baseUrl: 'https://vtpass.test/',
      apiKey: 'k',
      secretKey: 's',
      publicKey: 'p',
      service: 'data' as const,
      fetch: transport.fetch,
    }),
  };
}

describe('VtpassAdapter against the shared contract', () => {
  fulfilmentContract(() => {
    const { transport, port } = harness();
    return {
      port,
      script: transport.script,
      deliveredPurchase: [{ json: delivered }],
      catalogueResponses: [{ json: variations }],
      statusResponses: [{ json: delivered }],
      currency: 'NGN' as const,
      itemCode: 'mtn-data:mtn-10gb',
      target: '08030000000',
    };
  });
});

describe('naira amounts never pass through a float', () => {
  it('parses a decimal string to kobo exactly', () => {
    expect(nairaToKobo('4500.00')).toBe(450_000n);
    expect(nairaToKobo('500')).toBe(50_000n);
    expect(nairaToKobo('0.07')).toBe(7n);
  });

  it('gets the case a float multiply gets wrong', () => {
    // Number('0.07') * 100 is 7.000000000000001. The difference is invisible
    // until it is somebody's balance.
    expect(0.07 * 100).not.toBe(7);
    expect(nairaToKobo('0.07')).toBe(7n);
  });

  it('round-trips kobo back to the string VTpass expects', () => {
    for (const kobo of [0n, 7n, 50_000n, 450_000n, 123_456_789n]) {
      expect(nairaToKobo(koboToNaira(kobo))).toBe(kobo);
    }
    expect(koboToNaira(450_000n)).toBe('4500.00');
    expect(koboToNaira(7n)).toBe('0.07');
  });

  it('rejects an amount it cannot represent rather than rounding it', () => {
    // Three decimal places is not naira. Truncating silently is how a customer
    // is charged something other than the screen showed.
    expect(() => nairaToKobo('10.005')).toThrow();
    expect(() => nairaToKobo('abc')).toThrow();
  });
});

describe('provider response codes', () => {
  it('treats 099 as pending, not success', async () => {
    // VTpass accepts and processes asynchronously. Reading 099 as delivered
    // tells a customer their airtime arrived before it has.
    const { transport, port } = harness();
    transport.script([{ json: { code: '099', content: { transactions: { transactionId: 't1' } } } }]);

    const result = await port.purchase({
      reference: 'r1',
      itemCode: 'mtn-data:mtn-10gb',
      target: '08030000000',
      amountMinor: 450_000n,
      currency: 'NGN',      initiatedAt: INITIATED_AT,

    });
    expect(result.status).toBe('pending');
  });

  it('distrusts a success code whose transaction is still pending', async () => {
    // The numbers win over the label, as with Bitnob card funding.
    const { transport, port } = harness();
    transport.script([
      { json: { code: '000', content: { transactions: { status: 'pending', transactionId: 't2' } } } },
    ]);

    const result = await port.purchase({
      reference: 'r2',
      itemCode: 'mtn-data:mtn-10gb',
      target: '08030000000',
      amountMinor: 450_000n,
      currency: 'NGN',      initiatedAt: INITIATED_AT,

    });
    expect(result.status).toBe('pending');
  });

  it('reports a failure code with the reason attached', async () => {
    const { transport, port } = harness();
    transport.script([{ json: { code: '016', response_description: 'TRANSACTION FAILED' } }]);

    const result = await port.purchase({
      reference: 'r3',
      itemCode: 'mtn-data:mtn-10gb',
      target: '08030000000',
      amountMinor: 450_000n,
      currency: 'NGN',      initiatedAt: INITIATED_AT,

    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('TRANSACTION FAILED');
  });

  it('carries the electricity token through, because it IS the product', async () => {
    // A customer who paid and did not receive the token has bought nothing
    // they can use.
    const { transport, port } = harness();
    transport.script([
      { json: { code: '000', purchased_code: '1234-5678-9012-3456', content: { transactions: { status: 'delivered', transactionId: 't4' } } } },
    ]);

    const result = await port.purchase({
      reference: 'r4',
      itemCode: 'ikeja-electric:prepaid',
      target: '01234567890',
      amountMinor: 500_000n,
      currency: 'NGN',      initiatedAt: INITIATED_AT,

    });
    expect(result.delivery['token']).toBe('1234-5678-9012-3456');
  });
});

describe('airtime has no catalogue', () => {
  it('returns nothing rather than inventing an any-amount product', async () => {
    // The customer names the amount. A single product priced at zero would
    // make "free" and "you decide" the same value.
    const transport = scriptedFetch();
    const airtime = new VtpassAdapter({
      baseUrl: 'https://vtpass.test',
      apiKey: 'k',
      secretKey: 's',
      publicKey: 'p',
      service: 'airtime',
      fetch: transport.fetch,
    });
    expect(await airtime.catalogue({ group: 'mtn' })).toEqual([]);
  });
});

describe('meter verification', () => {
  it('is offered by this adapter', () => {
    const { port } = harness();
    expect(supportsVerification(port)).toBe(true);
  });

  it('returns the account holder so the customer can confirm', async () => {
    const { transport, port } = harness();
    transport.script([
      { json: { code: '000', content: { Customer_Name: 'ADA OBI', Address: '12 Broad St' } } },
    ]);

    const verified = await port.verifyTarget('ikeja-electric:prepaid', '01234567890');
    expect(verified.name).toBe('ADA OBI');
    expect(verified.metadata['address']).toBe('12 Broad St');
  });

  it('rejects an unknown meter instead of returning an empty name', async () => {
    // VTpass answers `false` rather than erroring. Handing the customer a blank
    // name to confirm is worse than telling them the number is wrong.
    const { transport, port } = harness();
    transport.script([{ json: { code: '000', content: { Customer_Name: false } } }]);

    await expect(port.verifyTarget('ikeja-electric:prepaid', '999')).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });
});

describe("VTpass's request_id format", () => {
  it('is a Lagos YYYYMMDDHHMM stamp followed by our reference', async () => {
    // Their documented example is 202202071830YUs83meikd. 17:30Z is 18:30 in
    // Lagos, which is UTC+1 all year.
    const id = vtpassRequestId('xtabc123', new Date('2026-02-07T17:30:00.000Z'));
    expect(id).toBe('202602071830xtabc123');
  });

  it('rolls the DATE over when the Lagos offset crosses midnight', async () => {
    // 23:30Z is 00:30 the NEXT day in Lagos. Shifting only the hour would
    // produce a stamp dated yesterday, which is the kind of thing that works
    // for twenty-three hours a day.
    const id = vtpassRequestId('xt1', new Date('2026-02-07T23:30:00.000Z'));
    expect(id.slice(0, 12)).toBe('202602080030');
  });

  it('is DERIVED, so ordering and requerying use the same id', async () => {
    // The property the entire recovery path rests on. If this read the clock,
    // a requery would ask VTpass about an id that was never ordered, and a
    // retry would look to them like a second purchase.
    const initiatedAt = new Date('2026-02-07T17:30:00.000Z');
    const { transport, port } = harness();
    transport.script([
      { json: { code: '099', content: { transactions: { status: 'pending' } } } },
      { json: { code: '000', content: { transactions: { status: 'delivered' } } } },
    ]);

    await port.purchase({
      reference: 'xt-shared-ref',
      itemCode: 'mtn-data:500',
      target: '08030000000',
      amountMinor: 50_000n,
      currency: 'NGN',
      initiatedAt,
    });
    await port.status({ reference: 'xt-shared-ref', initiatedAt });

    const ordered = JSON.parse(String(transport.calls[0]?.init.body)) as { request_id: string };
    const requeried = JSON.parse(String(transport.calls[1]?.init.body)) as { request_id: string };
    expect(requeried.request_id).toBe(ordered.request_id);
    expect(ordered.request_id).toBe('202602071830xtsharedref');
  });
});
