import { describe, expect, it } from 'vitest';
import { AiraloAdapter, usdToCents } from './airalo-adapter.js';
import { fulfilmentContract, scriptedFetch } from '../ports/fulfilment.contract.js';
import { supportsVerification } from '../ports/fulfilment.js';

const token = { data: { access_token: 'tok_live', expires_in: 3600 } };

const packages = {
  data: [
    {
      slug: 'nigeria',
      operators: [
        {
          packages: [
            { id: 'ng-7day-1gb', title: 'Nigeria 1GB 7 Days', price: 4.5 },
            { id: 'ng-30day-5gb', title: 'Nigeria 5GB 30 Days', price: '18.00' },
          ],
        },
      ],
    },
  ],
};

const delivered = {
  data: {
    id: 8891,
    code: 'xetral-ref-1',
    status: 'completed',
    sims: [{ iccid: '8944', qrcode: 'LPA:1$rsp$token', lpa: 'rsp.example' }],
  },
};

function harness(nowMs = () => 1_000_000) {
  const transport = scriptedFetch();
  return {
    transport,
    port: new AiraloAdapter({
      baseUrl: 'https://airalo.test/',
      clientId: 'id',
      clientSecret: 'secret',
      fetch: transport.fetch,
      nowMs,
    }),
  };
}

describe('AiraloAdapter against the shared contract', () => {
  fulfilmentContract(() => {
    const { transport, port } = harness();
    return {
      port,
      // Every call needs a token first, so the token response leads each script.
      script: (responses) => transport.script([{ json: token }, ...responses]),
      deliveredPurchase: [{ json: delivered }],
      catalogueResponses: [{ json: packages }],
      statusResponses: [{ json: delivered }],
      currency: 'USD' as const,
      itemCode: 'ng-7day-1gb',
      target: 'NG',
    };
  });
});

describe('USD amounts never pass through a float multiply', () => {
  it('parses both a JSON number and a string', () => {
    expect(usdToCents(4.5)).toBe(450n);
    expect(usdToCents('18.00')).toBe(1800n);
    expect(usdToCents('0.07')).toBe(7n);
  });

  it('gets the case a float multiply gets wrong', () => {
    expect(0.07 * 100).not.toBe(7);
    expect(usdToCents('0.07')).toBe(7n);
  });

  it('rejects an amount with more precision than a cent', () => {
    expect(() => usdToCents('1.005')).toThrow();
  });
});

describe('the eSIM activation payload is the product', () => {
  it('carries iccid, qr code and lpa through', async () => {
    const { transport, port } = harness();
    transport.script([{ json: token }, { json: delivered }]);

    const result = await port.purchase({
      reference: 'r1',
      itemCode: 'ng-7day-1gb',
      target: 'NG',
      amountMinor: 450n,
      currency: 'USD',
    });

    expect(result.status).toBe('delivered');
    expect(result.delivery['iccid']).toBe('8944');
    expect(result.delivery['qr_code']).toBe('LPA:1$rsp$token');
  });

  it('is pending when the order exists but no SIM is attached yet', async () => {
    // An order marked complete with nothing to activate is not delivered. The
    // customer has paid and has nothing to scan.
    const { transport, port } = harness();
    transport.script([{ json: token }, { json: { data: { id: 1, status: 'completed', sims: [] } } }]);

    const result = await port.purchase({
      reference: 'r2',
      itemCode: 'ng-7day-1gb',
      target: 'NG',
      amountMinor: 450n,
      currency: 'USD',
    });
    expect(result.status).toBe('pending');
  });

  it('reports a cancelled order as failed', async () => {
    const { transport, port } = harness();
    transport.script([{ json: token }, { json: { data: { id: 2, status: 'cancelled' } } }]);

    const result = await port.purchase({
      reference: 'r3',
      itemCode: 'ng-7day-1gb',
      target: 'NG',
      amountMinor: 450n,
      currency: 'USD',
    });
    expect(result.status).toBe('failed');
  });
});

describe('the access token', () => {
  it('is fetched once and reused', async () => {
    const { transport, port } = harness();
    transport.script([{ json: token }, { json: packages }]);

    await port.catalogue({ group: 'NG' });
    await port.catalogue({ group: 'NG' });

    // Token, catalogue, catalogue -- not token, catalogue, token, catalogue.
    const tokenCalls = transport.calls.filter((c) => c.url.includes('/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('is refetched once it has expired', async () => {
    let now = 1_000_000;
    const { transport, port } = harness(() => now);
    // All four responses scripted: the transport repeats its last entry once
    // the queue is down to one, which would otherwise hand the packages body
    // to the token parser and fail for the wrong reason.
    transport.script([
      { json: token },
      { json: packages },
      { json: token },
      { json: packages },
    ]);

    await port.catalogue({ group: 'NG' });
    // Past the expiry, including the one-minute safety margin.
    now += 3_600_000;
    await port.catalogue({ group: 'NG' });

    expect(transport.calls.filter((c) => c.url.includes('/token'))).toHaveLength(2);
  });

  it('is dropped after a 401 so the next call re-authenticates', async () => {
    // Looping on a credential we already know is stale is how a transient
    // rotation becomes a sustained outage.
    let now = 1_000_000;
    const { transport, port } = harness(() => now);
    transport.script([{ json: token }, { status: 401, json: { message: 'expired' } }]);

    await expect(port.catalogue({ group: 'NG' })).rejects.toThrow();

    transport.script([{ json: token }, { json: packages }]);
    await port.catalogue({ group: 'NG' });
    expect(transport.calls.filter((c) => c.url.includes('/token'))).toHaveLength(2);
  });
});

describe('capabilities', () => {
  it('does not claim target verification', () => {
    // Airalo has no meter to verify. The port is not widened to give it a
    // method that throws.
    const { port } = harness();
    expect(supportsVerification(port)).toBe(false);
  });
});
