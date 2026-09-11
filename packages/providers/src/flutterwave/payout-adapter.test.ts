import { describe, expect, it } from 'vitest';
import { ghs, kes, ngn } from './test-money.js';
import { FlutterwaveClient } from './client.js';
import { FlutterwavePayoutAdapter } from './payout-adapter.js';
import { ProviderRejectedError } from '../ports/errors.js';

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
      return new Response(JSON.stringify(responses[i++] ?? { status: 'success', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, sent };
}

describe('what a customer is offered to send to', () => {
  it('answers NETWORKS in Ghana, not banks', async () => {
    /*
     * Their bank list answers BANKS. In Accra money moves to a wallet on a
     * phone number, and the code a transfer to one carries is a NETWORK code
     * their bank list does not contain — so offering that list is offering a
     * selection the customer's money cannot reach, which then fails at the
     * transfer and reads as their own number being wrong. 046's lesson.
     */
    const { client, sent } = stub([]);
    const banks = await new FlutterwavePayoutAdapter(client).banks('GH');
    expect(banks.map((b) => b.code)).toEqual(['MTN', 'VOD', 'ATL']);
    // And it did not call them at all.
    expect(sent).toHaveLength(0);
  });

  it('answers M-PESA in Kenya', async () => {
    const { client } = stub([]);
    expect((await new FlutterwavePayoutAdapter(client).banks('KE'))[0]?.name).toBe('M-PESA');
  });

  it('asks for the real bank list where money moves to banks', async () => {
    const { client, sent } = stub([
      { status: 'success', data: [{ code: '044', name: 'Access Bank' }] },
    ]);
    const banks = await new FlutterwavePayoutAdapter(client).banks('NG');
    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/banks/NG');
    expect(banks).toEqual([{ code: '044', name: 'Access Bank' }]);
  });
});

describe('who holds the destination', () => {
  it('ASKS for a Ghanaian wallet, instead of refusing to ask', async () => {
    /*
     * THE TEST THAT ENCODED THE BUG, rewritten to encode the fact.
     *
     * It used to assert that a `GH`/`MTN` lookup threw `name_unavailable`
     * WITHOUT CALLING ANYTHING — and it passed, for three rounds, while
     * customers in Accra were reporting that their momo details could not be
     * found. Flutterwave's own documentation for `/v3/accounts/resolve` lists
     * GHANAIAN MOBILE MONEY NUMBERS among what it accepts, so the refusal was
     * this adapter's invention and the test was agreeing with it.
     *
     * A test written from the same assumption as the code passes everything
     * and fails on the first live call. It is the lesson Phase 3 records about
     * the Bitnob endpoint table, in a second place.
     */
    const { client, sent } = stub([
      { status: 'success', data: { account_name: 'RABI SIEDU' } },
    ]);
    const found = await new FlutterwavePayoutAdapter(client).lookup('GH', 'MTN', '233553921133');
    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/accounts/resolve');
    // The NETWORK code goes in `account_bank` and the number goes in
    // INTERNATIONAL form — what `phone.ts` produces and what the row records.
    expect(sent[0]?.body).toMatchObject({
      account_bank: 'MTN',
      account_number: '233553921133',
    });
    expect(found.accountName).toBe('RABI SIEDU');
  });

  it('still says M-PESA has no name enquiry, because it has none', async () => {
    /*
     * 043'S RULE HOLDS WHERE IT APPLIES, and Kenya is where it applies. M-PESA
     * is absent from what `/v3/accounts/resolve` accepts, so this is the
     * provider's real position rather than an assumption — and it is told
     * apart from `unknown_account`, which reads to a customer as "check the
     * number".
     *
     * What this must never do either way is echo back a name the sender typed,
     * which would be a confirmation screen that confirms nothing while looking
     * exactly like one.
     */
    const { client, sent } = stub([]);
    await expect(
      new FlutterwavePayoutAdapter(client).lookup('KE', 'MPS', '254712345678'),
    ).rejects.toMatchObject({ providerCode: 'name_unavailable' });
    expect(sent).toHaveLength(0);
  });

  it('asks the bank, and returns the BANK\'s answer', async () => {
    const { client, sent } = stub([
      { status: 'success', data: { account_name: 'ADEBAYO OKON' } },
    ]);
    const found = await new FlutterwavePayoutAdapter(client).lookup('NG', '044', '0123456789');
    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/accounts/resolve');
    expect(found.accountName).toBe('ADEBAYO OKON');
  });

  it('answers the same way for an unknown account and an unreachable bank', async () => {
    // Distinguishing them maps which numbers are live at which bank, one
    // request at a time. 043's rule, unchanged by the rail.
    const { client } = stub([{ status: 'error', message: 'Sorry that account is invalid' }]);
    await expect(
      new FlutterwavePayoutAdapter(client).lookup('NG', '044', '0123456789'),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });
});

describe('sending', () => {
  it('sends MAJOR units and names what we are debited in', async () => {
    const { client, sent } = stub([
      { status: 'success', data: { id: 99, status: 'NEW' } },
    ]);
    const receipt = await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'MTN',
      accountNumber: '0244123456',
      accountName: 'Ama Mensah',
      amount: ghs(250_00n),
      reference: 'xetpay-out-1',
    });

    const body = sent[0]?.body as Record<string, unknown>;
    expect(body['amount']).toBe('250.00');
    /*
     * `debit_currency` STATED, not inferred. Left out, Flutterwave picks a
     * balance — and on a multi-currency account that can mean funding a cedi
     * payout from the naira one at a rate nobody chose, which is the same
     * silent conversion this whole rail exists because of, outbound.
     */
    expect(body['debit_currency']).toBe('GHS');
    expect(body['reference']).toBe('xetpay-out-1');
    expect(receipt.state).toBe('sent');
    expect(receipt.providerPayoutId).toBe('99');
  });

  it('reads SUCCESSFUL as completed and FAILED as failed', async () => {
    const { client } = stub([
      { status: 'success', data: { id: 1, status: 'SUCCESSFUL' } },
      { status: 'success', data: { id: 2, status: 'FAILED', complete_message: 'wrong number' } },
    ]);
    const adapter = new FlutterwavePayoutAdapter(client);
    expect((await adapter.status('1')).state).toBe('completed');
    const failed = await adapter.status('2');
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toBe('wrong number');
  });

  it('treats a state it does not recognise as still in flight, never as failed', async () => {
    /*
     * THE ASYMMETRY IS THE POINT. Reading an unknown word as failed reverses a
     * payout that may already be in somebody's wallet; reading it as in-flight
     * leaves the money held and `bank_payouts_stuck` counting it until a
     * person looks. Only one of those is recoverable.
     */
    const { client } = stub([{ status: 'success', data: { id: 3, status: 'QUEUED_FOR_REVIEW' } }]);
    expect((await new FlutterwavePayoutAdapter(client).status('3')).state).toBe('sent');
  });

  it('is generic over its currency, so a concrete amount compiles', async () => {
    // `Money` is invariant. A non-generic `send` compiles and then rejects
    // every caller holding `ngn(…)` or `kes(…)` — the trap Phase 10 and Phase
    // 14 both walked into. This test exists to fail at TYPECHECK, not at run.
    const { client } = stub([
      { status: 'success', data: { id: 4, status: 'NEW' } },
      { status: 'success', data: { id: 5, status: 'NEW' } },
    ]);
    const adapter = new FlutterwavePayoutAdapter(client);
    const base = {
      country: 'KE',
      bankCode: 'MPS',
      accountNumber: '254700000000',
      accountName: 'Wanjiru',
      reference: 'r',
    };
    expect((await adapter.send({ ...base, amount: kes(100_00n) })).state).toBe('sent');
    expect(
      (await adapter.send({ ...base, country: 'NG', bankCode: '044', amount: ngn(100_00n) }))
        .state,
    ).toBe('sent');
  });
});
