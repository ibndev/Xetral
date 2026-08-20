import { describe, expect, it } from 'vitest';
import { TwilioAdapter } from './twilio-adapter.js';
import { fulfilmentContract, scriptedFetch } from '../ports/fulfilment.contract.js';
import { supportsVerification } from '../ports/fulfilment.js';

const available = {
  available_phone_numbers: [
    { phone_number: '+15005550006', friendly_name: '(500) 555-0006', locality: 'Austin', iso_country: 'US' },
    { phone_number: '+15005550007', iso_country: 'US' },
  ],
};

const purchased = { sid: 'PN9911', phone_number: '+15005550006', status: 'in-use' };

function harness() {
  const transport = scriptedFetch();
  return {
    transport,
    port: new TwilioAdapter({
      baseUrl: 'https://api.twilio.test/',
      accountSid: 'AC123',
      authToken: 'tok',
      priceCents: 300n,
      fetch: transport.fetch,
    }),
  };
}

describe('TwilioAdapter against the shared contract', () => {
  fulfilmentContract(() => {
    const { transport, port } = harness();
    return {
      port,
      script: transport.script,
      deliveredPurchase: [{ json: purchased }],
      catalogueResponses: [{ json: available }],
      statusResponses: [{ json: { incoming_phone_numbers: [purchased] } }],
      currency: 'USD' as const,
      itemCode: '+15005550006',
      target: 'US',
    };
  });
});

describe('pricing', () => {
  it('quotes OUR price, not what Twilio charges us', async () => {
    // What a provider charges is a cost. A cost is not a price, and letting the
    // provider set the customer's price means a supplier can reprice our
    // product without anyone deciding.
    const { transport, port } = harness();
    transport.script([{ json: available }]);

    const items = await port.catalogue({ group: 'US' });
    expect(items.every((item) => item.priceMinor === 300n)).toBe(true);
  });

  it('uses the number itself as the product code', async () => {
    // You buy THAT number, not "a number from this pool".
    const { transport, port } = harness();
    transport.script([{ json: available }]);

    const items = await port.catalogue({ group: 'US' });
    expect(items[0]?.code).toBe('+15005550006');
  });
});

describe('form encoding', () => {
  it('sends a purchase as form data, which the port never has to know', async () => {
    // The one place this adapter differs from the other two. Absorbed here
    // rather than leaked into the port.
    const { transport, port } = harness();
    transport.script([{ json: purchased }]);

    await port.purchase({
      reference: 'r1',
      itemCode: '+15005550006',
      target: 'US',
      amountMinor: 300n,
      currency: 'USD',
    });

    const call = transport.calls.at(-1);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(String(call?.init.body)).toContain('PhoneNumber=%2B15005550006');
  });

  it('authenticates with basic auth over the account sid', async () => {
    const { transport, port } = harness();
    transport.script([{ json: available }]);
    await port.catalogue({ group: 'US' });

    const headers = transport.calls[0]?.init.headers as Record<string, string>;
    const decoded = Buffer.from(headers['authorization']?.split(' ')[1] ?? '', 'base64').toString();
    expect(decoded).toBe('AC123:tok');
  });
});

describe('recovering from a timeout', () => {
  it('finds the number by our reference instead of buying another', async () => {
    // Twilio has no notion of our reference, so the friendly name carries it.
    // That is what makes a timeout answerable rather than a gamble.
    const { transport, port } = harness();
    transport.script([{ json: { incoming_phone_numbers: [purchased] } }]);

    const result = await port.status('r1');
    expect(result.status).toBe('delivered');
    expect(result.delivery['phone_number']).toBe('+15005550006');
    expect(transport.calls[0]?.url).toContain('FriendlyName=xetral%3Ar1');
  });

  it('reports a definite failure when nothing was bought', async () => {
    // A definite "no" is what makes it safe to reverse the customer's debit.
    // An ambiguous answer would leave the money in limbo.
    const { transport, port } = harness();
    transport.script([{ json: { incoming_phone_numbers: [] } }]);

    const result = await port.status('r-missing');
    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/no number was purchased/);
  });
});

describe('capabilities', () => {
  it('does not claim target verification', () => {
    const { port } = harness();
    expect(supportsVerification(port)).toBe(false);
  });
});
