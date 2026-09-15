import { describe, expect, it } from 'vitest';
import { FlutterwaveClient } from './client.js';
import { FlutterwaveCheckoutAdapter } from './checkout-adapter.js';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';

/**
 * The Flutterwave checkout, and the one thing about it that costs money.
 *
 * THE UNIT IS MAJOR HERE AND MINOR AT PAYSTACK, one directory apart. The
 * instinct built by `paystack/checkout.ts` — send `amountMinor.toString()` —
 * charges a payer ONE HUNDRED TIMES the amount here, in the direction that
 * takes their money, and neither API would refuse it: 5,000 cedis is a
 * perfectly valid charge. So these tests assert the exact string on the wire
 * rather than that a call was made.
 */
function stub(responses: readonly unknown[]): {
  client: FlutterwaveClient;
  sent: { url: string; body: unknown }[];
} {
  const sent: { url: string; body: unknown }[] = [];
  let i = 0;
  const client = new FlutterwaveClient({
    baseUrl: 'https://api.flutterwave.com',
    secretKey: 'FLWSECK_TEST-xxx',
    fetch: async (url, init) => {
      sent.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const body = responses[i++] ?? { status: 'success', data: {} };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, sent };
}

describe('starting a Flutterwave checkout', () => {
  it('sends the amount in MAJOR units, not minor', async () => {
    const { client, sent } = stub([
      { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/abc' } },
    ]);

    const session = await new FlutterwaveCheckoutAdapter(client).begin({
      payerEmail: 'payer@example.com',
      // 500.00 cedis. Paystack would want "50000"; this API wants "500.00".
      amountMinor: 50_000n,
      currency: 'GHS',
      reference: 'xetpay-1',
    });

    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/payments');
    expect((sent[0]?.body as { amount: string }).amount).toBe('500.00');
    expect(session.authorizationUrl).toContain('checkout.flutterwave.com');
    // OUR reference, not theirs — it names a row written before the payer left.
    expect(session.reference).toBe('xetpay-1');
    expect((sent[0]?.body as { tx_ref: string }).tx_ref).toBe('xetpay-1');
  });

  it('reads the exponent per currency rather than dividing by a hundred', async () => {
    // USDT is six decimal places. A hardcoded ÷100 is wrong by four orders of
    // magnitude here, which is precisely why `toMajor` is the only conversion.
    const { client, sent } = stub([{ status: 'success', data: { link: 'https://x' } }]);
    await new FlutterwaveCheckoutAdapter(client).begin({
      payerEmail: 'payer@example.com',
      amountMinor: 1_500_000n,
      currency: 'USDT',
      reference: 'xetpay-2',
    });
    expect((sent[0]?.body as { amount: string }).amount).toBe('1.500000');
  });

  it('names the payment methods that currency actually has', async () => {
    const { client, sent } = stub([{ status: 'success', data: { link: 'https://x' } }]);
    await new FlutterwaveCheckoutAdapter(client).begin({
      payerEmail: 'payer@example.com',
      amountMinor: 10_000n,
      currency: 'KES',
      reference: 'xetpay-3',
    });
    // `account` AND NOT `banktransfer`, and this assertion is the point of the
    // test. Flutterwave's two bank options are not spellings of one thing:
    // `banktransfer` is the Nigerian pay-with-transfer product, and offering
    // it here does not produce an error — it produces a checkout with the
    // method quietly missing, which is exactly the shape of "the Ghana link
    // is broken and the Nigerian one is fine".
    expect((sent[0]?.body as { payment_options: string }).payment_options).toBe(
      'card,account,mpesa',
    );
  });

  it('offers Ghana a card, a bank account and the wallet', async () => {
    const { client, sent } = stub([{ status: 'success', data: { link: 'https://x' } }]);
    await new FlutterwaveCheckoutAdapter(client).begin({
      payerEmail: 'payer@example.com',
      amountMinor: 10_000n,
      currency: 'GHS',
      reference: 'xetpay-3b',
    });
    const body = sent[0]?.body as { payment_options: string; currency: string };
    expect(body.payment_options).toBe('card,account,mobilemoneyghana');
    /*
     * AND THE CURRENCY IS THE LITERAL CODE. Asserted because it was one of
     * four candidate explanations for a Ghanaian checkout refusing while the
     * Nigerian one worked, and the only one a test could settle: a country
     * code, a blank, or anything but `GHS` here is a refusal from Flutterwave
     * that reaches the payer as "try again shortly".
     */
    expect(body.currency).toBe('GHS');
  });

  it('offers a dollar checkout a card and nothing else', async () => {
    const { client, sent } = stub([{ status: 'success', data: { link: 'https://x' } }]);
    await new FlutterwaveCheckoutAdapter(client).begin({
      payerEmail: 'payer@example.com',
      amountMinor: 10_000n,
      currency: 'USD',
      reference: 'xetpay-3c',
    });
    // A dollar belongs to no country and has no wallet rail, so naming one
    // would offer a payer a method that cannot serve the currency.
    expect((sent[0]?.body as { payment_options: string }).payment_options).toBe('card');
  });

  it('carries the payer note into their metadata without letting it touch the amount', async () => {
    const { client, sent } = stub([{ status: 'success', data: { link: 'https://x' } }]);
    await new FlutterwaveCheckoutAdapter(client).begin({
      payerEmail: 'payer@example.com',
      amountMinor: 10_000n,
      currency: 'GHS',
      reference: 'xetpay-4',
      note: 'Rent for March',
      payeeName: 'Ama Mensah',
    });
    const body = sent[0]?.body as {
      amount: string;
      meta: { xetral_note?: string };
      customizations: { title: string; description?: string };
    };
    expect(body.meta.xetral_note).toBe('Rent for March');
    expect(body.customizations.title).toBe('Ama Mensah');
    expect(body.amount).toBe('100.00');
  });
});

describe('verifying a Flutterwave checkout', () => {
  it('converts their MAJOR amount back to the ledger\'s minor units, from the text', async () => {
    const { client } = stub([
      {
        status: 'success',
        data: {
          status: 'successful',
          tx_ref: 'xetpay-5',
          // A STRING. Their API sends numbers too, and `JSON.parse` has
          // already rounded one by the time anybody looks at it.
          amount: '500.00',
          currency: 'GHS',
          payment_type: 'mobilemoneyghana',
          created_at: '2026-09-06T10:00:00Z',
        },
      },
    ]);

    const outcome = await new FlutterwaveCheckoutAdapter(client).verify('xetpay-5');
    expect(outcome.status).toBe('success');
    expect(outcome.amountMinor).toBe(50_000n);
    expect(outcome.currency).toBe('GHS');
    expect(outcome.channel).toBe('mobilemoneyghana');
  });

  it('reads `successful`, not the envelope\'s `success`', async () => {
    // Two fields named status, two vocabularies, one nesting level apart.
    // Treating either spelling as the other is the difference between
    // crediting an unpaid checkout and never crediting a paid one.
    const { client } = stub([
      {
        status: 'success',
        data: { status: 'pending', tx_ref: 'xetpay-6', amount: '1.00', currency: 'GHS' },
      },
    ]);
    const outcome = await new FlutterwaveCheckoutAdapter(client).verify('xetpay-6');
    expect(outcome.status).toBe('pending');
  });

  it('treats an unfinished payment as pending rather than failed', async () => {
    const { client } = stub([
      {
        status: 'success',
        data: { status: 'abandoned', tx_ref: 'xetpay-7', amount: '1.00', currency: 'GHS' },
      },
    ]);
    expect((await new FlutterwaveCheckoutAdapter(client).verify('xetpay-7')).status).toBe(
      'pending',
    );
  });

  it('refuses a reference they do not know rather than calling it failed', async () => {
    const { client } = stub([{ status: 'success', message: 'No transaction found' }]);
    await expect(new FlutterwaveCheckoutAdapter(client).verify('nope')).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });

  it('refuses an amount it cannot read rather than guessing at one', async () => {
    const { client } = stub([
      {
        status: 'success',
        data: { status: 'successful', tx_ref: 'x', amount: null, currency: 'GHS' },
      },
    ]);
    await expect(new FlutterwaveCheckoutAdapter(client).verify('x')).rejects.toBeInstanceOf(
      ProviderContractError,
    );
  });
});

describe('their envelope', () => {
  it('rejects `status: "error"` rather than reading it as truthy', async () => {
    /*
     * THE MOST LIKELY WAY A REFUSAL BECOMES A CREDIT. Paystack's envelope is a
     * BOOLEAN and this one is a STRING, so the test one directory away —
     * `status === false` — passes here for every value, because a non-empty
     * string is truthy.
     */
    const { client } = stub([{ status: 'error', message: 'Invalid currency' }]);
    await expect(
      new FlutterwaveCheckoutAdapter(client).begin({
        payerEmail: 'payer@example.com',
        amountMinor: 100n,
        currency: 'GHS',
        reference: 'xetpay-8',
      }),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('refuses to send with no key rather than sending `Bearer undefined`', async () => {
    const client = new FlutterwaveClient({
      baseUrl: 'https://api.flutterwave.com',
      secretKey: async () => undefined,
      fetch: async () => new Response('{}', { status: 200 }),
    });
    await expect(client.request('GET', '/v3/banks/GH')).rejects.toThrow(/no Flutterwave secret/);
  });
});
