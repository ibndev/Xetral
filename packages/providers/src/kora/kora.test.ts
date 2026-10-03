import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { money } from '@xetral/shared';
import {
  NO_SUCH_TRANSFER,
  ProviderContractError,
  ProviderNotSentError,
  ProviderRejectedError,
  ProviderUnavailableError,
  providerDidNothing,
} from '../ports/errors.js';
import { KoraClient } from './client.js';
import { koraMajor, koraMinor } from './amounts.js';
import { KoraCheckoutAdapter } from './checkout-adapter.js';
import { KoraFundingAdapter } from './funding-adapter.js';
import { KoraPayoutAdapter } from './payout-adapter.js';
import { parseKoraEvent, verifyKoraWebhook } from './webhooks.js';

/**
 * Kora, against the shapes its own guides publish (developers.korapay.com,
 * read 3 October 2026). Each stub answers BY PATH, never by position: an
 * adapter that legitimately makes one more call must not be handed another
 * call's answer — the lesson the v3 stub of the removed rail paid for.
 */
type Route = (body: unknown) => { status?: number; json: unknown };

function stub(routes: Record<string, Route>, keyless = false) {
  const secretKey = keyless ? undefined : 'sk_test_x';
  const sent: { method: string; path: string; body: unknown; auth: string | undefined }[] = [];
  const client = new KoraClient({
    baseUrl: 'https://api.korapay.com/merchant',
    secretKey: async () => secretKey,
    fetch: async (url, init) => {
      const path = url.replace('https://api.korapay.com/merchant', '');
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      const headers = init.headers as Record<string, string>;
      sent.push({ method: String(init.method), path, body, auth: headers['authorization'] });
      const key = Object.keys(routes).find((k) => `${String(init.method)} ${path}`.startsWith(k));
      const answer = key === undefined
        ? { status: 404, json: { status: false, message: 'not stubbed' } }
        : routes[key]!(body);
      return new Response(JSON.stringify(answer.json), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, sent };
}

describe('the client', () => {
  it('bears the secret key and reads a BOOLEAN envelope', async () => {
    const { client, sent } = stub({ 'GET /api/v1/balances': () => ({ json: { status: true, data: {} } }) });
    await client.request('GET', '/api/v1/balances');
    expect(sent[0]?.auth).toBe('Bearer sk_test_x');
  });

  it('refuses a `status: false` and keeps the HTTP status as the code', async () => {
    const { client } = stub({
      'POST /x': () => ({ status: 400, json: { status: false, message: 'Invalid account.' } }),
    });
    const error = await client.request('POST', '/x', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).providerCode).toBe('http_400');
  });

  it('reads Kora’s own "we do not know" sentences as UNAVAILABLE, never as a refusal', async () => {
    /* The Errors guide: an internal server error and an invalid authorization
     * key "do not indicate any error with your request ... requery". A
     * refusal is what gives a payout's money back; these must not. */
    for (const message of ['Internal Server Error', 'Invalid authorization key', 'Duplicate Transaction Reference. Please use a unique reference']) {
      const { client } = stub({ 'POST /x': () => ({ status: 400, json: { status: false, message } }) });
      const error = await client.request('POST', '/x', {}).catch((e: unknown) => e);
      expect(error, message).toBeInstanceOf(ProviderUnavailableError);
      expect(providerDidNothing(error), message).toBe(false);
    }
  });

  it('a 5xx is unavailable — "DO NOT treat ... 500 ... as failed payout"', async () => {
    const { client } = stub({ 'POST /x': () => ({ status: 502, json: {} }) });
    const error = await client.request('POST', '/x', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(providerDidNothing(error)).toBe(false);
  });

  it('sends nothing without a key', async () => {
    const { client, sent } = stub({}, true);
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(ProviderNotSentError);
    expect(sent).toHaveLength(0);
  });
});

describe('the unit boundary — Kora takes MAJOR units', () => {
  it('converts minor to major text and back, per currency', () => {
    expect(koraMajor(500_000n, 'NGN')).toBe('5000.00');
    expect(koraMinor('2000.00', 'NGN')).toBe(200_000n);
    expect(koraMinor(150.99, 'NGN')).toBe(15_099n);
    expect(koraMinor('10.00', 'GHS')).toBe(1_000n);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => koraMinor(undefined, 'NGN')).toThrow(ProviderContractError);
    expect(() => koraMinor(Number.NaN, 'NGN')).toThrow(ProviderContractError);
    expect(() => koraMinor('1', 'XYZ')).toThrow(ProviderContractError);
  });
});

describe('the webhook signature — HMAC-SHA256 of ONLY the data object', () => {
  const data = { reference: 'KPY-PAY-1', currency: 'NGN', amount: 1000, fee: 15, status: 'success' };
  const payload = { event: 'charge.success', data };
  const good = createHmac('sha256', 'sk_live_s').update(JSON.stringify(data)).digest('hex');

  it('accepts the signature their own sample computes, and nothing else', () => {
    expect(verifyKoraWebhook({ header: good, payload, secretKey: 'sk_live_s' })).toBe(true);
    expect(verifyKoraWebhook({ header: good, payload, secretKey: 'sk_live_t' })).toBe(false);
    const tampered = { ...payload, data: { ...data, amount: 9_000 } };
    expect(verifyKoraWebhook({ header: good, payload: tampered, secretKey: 'sk_live_s' })).toBe(false);
  });

  it('REFUSES with no key configured, rather than treating it as off', () => {
    expect(verifyKoraWebhook({ header: good, payload, secretKey: undefined })).toBe(false);
    expect(verifyKoraWebhook({ header: good, payload, secretKey: '' })).toBe(false);
  });

  it('refuses a missing or short header without throwing', () => {
    expect(verifyKoraWebhook({ header: undefined, payload, secretKey: 'sk_live_s' })).toBe(false);
    expect(verifyKoraWebhook({ header: 'abc', payload, secretKey: 'sk_live_s' })).toBe(false);
  });

  it('reads which payment, and which virtual account, an event is about', () => {
    const event = parseKoraEvent({
      event: 'charge.success',
      data: {
        reference: 'KPY-PAY-4l5O8mxmgX2kijp',
        status: 'success',
        virtual_bank_account_details: { virtual_bank_account: { account_reference: 'acct-1' } },
      },
    });
    expect(event).toEqual({
      kind: 'charge.success',
      reference: 'KPY-PAY-4l5O8mxmgX2kijp',
      status: 'success',
      accountReference: 'acct-1',
    });
  });
});

describe('the checkout', () => {
  it('initializes in MAJOR units with the chosen channel, and returns the checkout URL', async () => {
    const { client, sent } = stub({
      'POST /api/v1/charges/initialize': () => ({
        json: { status: true, data: { reference: 'ref-1', checkout_url: 'https://checkout.korapay.com/ref-1/pay' } },
      }),
    });
    const session = await new KoraCheckoutAdapter(client, {
      notificationUrl: 'https://api.example/v1/webhooks/kora',
    }).begin({
      payerEmail: 'payer@example.com',
      amountMinor: 50_00n,
      currency: 'GHS',
      reference: 'ref-1',
      callbackUrl: 'https://app.example/pay/x',
      method: 'mobile_money',
    });
    expect(session.authorizationUrl).toBe('https://checkout.korapay.com/ref-1/pay');
    expect(sent[0]?.body).toMatchObject({
      reference: 'ref-1',
      amount: '50.00',
      currency: 'GHS',
      channels: ['mobile_money'],
      default_channel: 'mobile_money',
      redirect_url: 'https://app.example/pay/x',
      notification_url: 'https://api.example/v1/webhooks/kora',
      customer: { email: 'payer@example.com' },
    });
  });

  it('refuses a method Kora has no channel for, sending nothing', async () => {
    const { client, sent } = stub({});
    const error = await new KoraCheckoutAdapter(client)
      .begin({ payerEmail: 'a@b.c', amountMinor: 100n, currency: 'NGN', reference: 'r', method: 'ussd' })
      .catch((e: unknown) => e);
    expect((error as ProviderRejectedError).providerCode).toBe('method_unavailable');
    expect(sent).toHaveLength(0);
  });

  it('verifies by our reference and credits what was PAID', async () => {
    const { client } = stub({
      'GET /api/v1/charges/ref-1': () => ({
        json: { status: true, data: { reference: 'ref-1', status: 'success', amount: '2000.00', amount_paid: '2000.00', currency: 'NGN' } },
      }),
    });
    const outcome = await new KoraCheckoutAdapter(client).verify('ref-1');
    expect(outcome).toMatchObject({ status: 'success', reference: 'ref-1', amountMinor: 200_000n, currency: 'NGN' });
  });

  it('leaves anything unfinished PENDING, and a reference Kora never saw a refusal', async () => {
    const { client } = stub({
      'GET /api/v1/charges/p': () => ({ json: { status: true, data: { status: 'processing', amount: '10.00', currency: 'GHS' } } }),
      'GET /api/v1/charges/gone': () => ({ status: 404, json: { status: false, message: 'Charge not found' } }),
    });
    expect((await new KoraCheckoutAdapter(client).verify('p')).status).toBe('pending');
    const error = await new KoraCheckoutAdapter(client).verify('gone').catch((e: unknown) => e);
    expect((error as ProviderRejectedError).providerCode).toBe('unknown_reference');
  });
});

describe('the fixed virtual account', () => {
  const customer = (bvn: string | undefined) => ({
    reference: 'u1',
    email: 'c@example.com',
    firstName: 'Ada',
    lastName: 'Obi',
    phone: undefined,
    providerCustomerId: undefined,
    bvn: async () => bvn,
  });

  it('refuses a customer with no approved BVN before sending anything', async () => {
    const { client, sent } = stub({
      'GET /api/v1/virtual-bank-account/': () => ({ status: 404, json: { status: false, message: 'Virtual bank account not found' } }),
    });
    const error = await new KoraFundingAdapter(client, { bankCode: '035' })
      .createVirtualAccount({ customer: customer(undefined), currency: 'NGN', idempotencyKey: 'va-1' })
      .catch((e: unknown) => e);
    expect((error as ProviderRejectedError).providerCode).toBe('kyc_required');
    expect(sent).toHaveLength(0);
  });

  it('opens a PERMANENT account with the BVN and the configured bank', async () => {
    const { client, sent } = stub({
      'GET /api/v1/virtual-bank-account/': () => ({ status: 404, json: { status: false, message: 'Virtual bank account not found' } }),
      'POST /api/v1/virtual-bank-account': () => ({
        json: {
          status: true,
          data: { account_name: 'Ada Obi', account_number: '0657789765', bank_name: 'Wema Bank', account_reference: 'va-1', account_status: 'active', currency: 'NGN' },
        },
      }),
    });
    const account = await new KoraFundingAdapter(client, { bankCode: '035' }).createVirtualAccount({
      customer: customer('22222222222'),
      currency: 'NGN',
      idempotencyKey: 'va-1',
    });
    expect(account).toMatchObject({ provider: 'kora', accountNumber: '0657789765', providerCustomerRef: 'va-1', active: true });
    expect(sent.find((s) => s.method === 'POST')?.body).toMatchObject({
      account_reference: 'va-1',
      permanent: true,
      bank_code: '035',
      kyc: { bvn: '22222222222' },
    });
  });

  it('returns the account a timed-out first attempt opened, rather than asking twice', async () => {
    const { client, sent } = stub({
      'GET /api/v1/virtual-bank-account/va-1': () => ({
        json: { status: true, data: { account_number: '0657789765', account_name: 'Ada Obi', account_status: 'active', currency: 'NGN' } },
      }),
    });
    const account = await new KoraFundingAdapter(client, { bankCode: '035' }).createVirtualAccount({
      customer: customer('22222222222'),
      currency: 'NGN',
      idempotencyKey: 'va-1',
    });
    expect(account.accountNumber).toBe('0657789765');
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('opens naira accounts only', async () => {
    const { client } = stub({});
    const error = await new KoraFundingAdapter(client, { bankCode: '035' })
      .createVirtualAccount({ customer: customer('2'), currency: 'KES', idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect((error as ProviderRejectedError).providerCode).toBe('account_not_supported_here');
  });

  it('confirms a deposit from Kora’s own answer, and names the account it landed in', async () => {
    const { client } = stub({
      'GET /api/v1/charges/KPY-PAY-1': () => ({
        json: {
          status: true,
          data: {
            reference: 'KPY-PAY-1', status: 'success', amount: '100.00', amount_paid: '100.00', currency: 'NGN',
            virtual_bank_account: { account_reference: 'va-1', payer_bank_account: { account_name: 'John Doe', bank_name: 'First Bank' } },
          },
        },
      }),
      'GET /api/v1/charges/KPY-PAY-2': () => ({ json: { status: true, data: { reference: 'KPY-PAY-2', status: 'processing', amount: '1.00', currency: 'NGN' } } }),
    });
    const adapter = new KoraFundingAdapter(client, { bankCode: '035' });
    expect(await adapter.verifyDeposit('KPY-PAY-1')).toMatchObject({
      providerReference: 'KPY-PAY-1', amountMinor: 10_000n, accountReference: 'va-1', senderName: 'John Doe',
    });
    expect(await adapter.verifyDeposit('KPY-PAY-2')).toBeUndefined();
  });

  it('refuses an answer about some other charge', async () => {
    const { client } = stub({
      'GET /api/v1/charges/KPY-PAY-1': () => ({ json: { status: true, data: { reference: 'KPY-PAY-9', status: 'success', amount: '1.00', currency: 'NGN' } } }),
    });
    await expect(new KoraFundingAdapter(client, { bankCode: '035' }).verifyDeposit('KPY-PAY-1')).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('lists only successful deposits of THIS account', async () => {
    const { client } = stub({
      'GET /api/v1/virtual-bank-account/va-1': () => ({ json: { status: true, data: { account_number: '1003346789', currency: 'NGN' } } }),
      'GET /api/v1/virtual-bank-account/transactions': () => ({
        json: {
          status: true,
          data: {
            account_number: '1003346789',
            transactions: [
              { reference: 'kpy-1', status: 'success', amount: '3000.00', currency: 'NGN' },
              { reference: 'kpy-2', status: 'failed', amount: '9.00', currency: 'NGN' },
            ],
          },
        },
      }),
    });
    const deposits = await new KoraFundingAdapter(client, { bankCode: '035' }).listDeposits({
      providerAccountId: 'va-1',
      providerCustomerRef: 'va-1',
    });
    expect(deposits.map((d) => [d.providerReference, d.amountMinor])).toEqual([['kpy-1', 300_000n]]);
  });
});

describe('the payout', () => {
  const lists = {
    'GET /api/v1/misc/mobile-money?countryCode=GH': () => ({
      json: { status: true, data: [{ name: 'MTN', slug: 'mtn-gh', code: '0004', country: 'GH' }, { name: 'AirtelTigo', slug: 'airtel-gh', code: '0006', country: 'GH' }] },
    }),
  };
  const ghs = (minor: bigint) => money(minor, 'GHS');

  it('sends a wallet payout with KORA’S operator slug, found by name — never our code', async () => {
    const { client, sent } = stub({
      ...lists,
      'POST /api/v1/transactions/disburse': () => ({
        json: { status: true, data: { reference: 'xetral-payout-1', status: 'processing', amount: '100.00', currency: 'GHS' } },
      }),
    });
    const receipt = await new KoraPayoutAdapter(client, { customerEmail: 'ops@xetral.com' }).send({
      country: 'GH', bankCode: 'ATL', accountNumber: '233242426222', amount: ghs(100_00n), reference: 'xetral-payout-1',
    });
    expect(receipt).toEqual({ providerPayoutId: 'xetral-payout-1', reference: 'xetral-payout-1', state: 'sent' });
    expect(sent.find((s) => s.method === 'POST')?.body).toEqual({
      reference: 'xetral-payout-1',
      destination: {
        type: 'mobile_money',
        amount: '100.00',
        currency: 'GHS',
        mobile_money: { operator: 'airtel-gh', mobile_number: '233242426222' },
        customer: { email: 'ops@xetral.com' },
      },
    });
  });

  it('sends a bank payout with the bank code and account', async () => {
    const { client, sent } = stub({
      'POST /api/v1/transactions/disburse': () => ({ json: { status: true, data: { reference: 'r', status: 'success' } } }),
    });
    const receipt = await new KoraPayoutAdapter(client, { customerEmail: 'ops@xetral.com' }).send({
      country: 'NG', bankCode: '033', accountNumber: '0000000000', accountName: 'EBUKA OLADEMJI',
      amount: money(150_000n, 'NGN'), reference: 'r',
    });
    expect(receipt.state).toBe('completed');
    expect(sent[0]?.body).toMatchObject({
      destination: { type: 'bank_account', bank_account: { bank: '033', account: '0000000000' }, customer: { name: 'EBUKA OLADEMJI' } },
    });
  });

  it('refuses before sending what Kora cannot do — another balance, no email, a Ghanaian bank', async () => {
    const { client, sent } = stub({});
    const adapter = new KoraPayoutAdapter(client, { customerEmail: 'ops@xetral.com' });
    const base = { country: 'GH', bankCode: 'MTN', accountNumber: '233240000000', amount: ghs(10_00n), reference: 'r' };
    for (const [request, code, port] of [
      [{ ...base, debitCurrency: 'NGN' }, 'debit_currency_unsupported', adapter],
      [base, 'payout_misconfigured', new KoraPayoutAdapter(client, { customerEmail: undefined })],
      [{ ...base, bankCode: 'GH280100' }, 'payout_method_unavailable', adapter],
    ] as const) {
      const error = await port.send(request).catch((e: unknown) => e);
      expect((error as ProviderRejectedError).providerCode).toBe(code);
      expect(providerDidNothing(error)).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });

  it('asks about a payout BY OUR REFERENCE, and only "Transaction not found" means never sent', async () => {
    const { client } = stub({
      'GET /api/v1/transactions/done': () => ({ json: { status: true, data: { reference: 'done', status: 'failed', message: 'Invalid Bank Account' } } }),
      'GET /api/v1/transactions/none': () => ({ status: 404, json: { status: false, message: 'Transaction not found' } }),
      'GET /api/v1/transactions/key': () => ({ status: 401, json: { status: false, message: 'Unauthorized' } }),
    });
    const adapter = new KoraPayoutAdapter(client, { customerEmail: 'ops@xetral.com' });
    expect(await adapter.status('done')).toMatchObject({ state: 'failed', failureReason: 'Invalid Bank Account' });
    const none = await adapter.statusByReference('none').catch((e: unknown) => e);
    expect((none as ProviderRejectedError).providerCode).toBe(NO_SUCH_TRANSFER);
    const key = await adapter.statusByReference('key').catch((e: unknown) => e);
    expect((key as ProviderRejectedError).providerCode).not.toBe(NO_SUCH_TRANSFER);
  });

  it('resolves a Ghanaian wallet by the operator’s CODE, and has no name enquiry for Kenya', async () => {
    const { client, sent } = stub({
      ...lists,
      'POST /api/v1/misc/mobile-money/resolve': () => ({ json: { status: true, data: { account_name: 'EBUKA CIROMA OLADEMJI' } } }),
    });
    const adapter = new KoraPayoutAdapter(client, { customerEmail: 'ops@xetral.com' });
    const found = await adapter.lookup('GH', 'MTN', '233722222222');
    expect(found.accountName).toBe('EBUKA CIROMA OLADEMJI');
    expect(sent.find((s) => s.method === 'POST')?.body).toEqual({ mobileMoneyCode: '0004', phoneNumber: '233722222222', currency: 'GH' });
    const kenya = await adapter.lookup('KE', 'MPS', '254711111111').catch((e: unknown) => e);
    expect((kenya as ProviderRejectedError).providerCode).toBe('name_unavailable');
  });

  it('reads the AVAILABLE balance per currency, in minor units', async () => {
    const { client } = stub({
      'GET /api/v1/balances': () => ({
        json: { status: true, data: { NGN: { pending_balance: 1, available_balance: 400300.9 }, GHS: { available_balance: '25.50' } } },
      }),
    });
    const held = await new KoraPayoutAdapter(client, { customerEmail: undefined }).floatBalances();
    expect(held.map((m) => [m.currency, m.amount])).toEqual([['NGN', 40_030_090n], ['GHS', 2_550n]]);
  });
});
