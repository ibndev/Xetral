import { describe, expect, it } from 'vitest';
import { ghs, kes, ngn } from './test-money.js';
import { FlutterwaveClient } from './client.js';
import { FlutterwavePayoutAdapter } from './payout-adapter.js';
import { FlutterwaveV4Client } from './v4-client.js';
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

/** A v4 client whose token exchange and calls are both stubbed. */
function v4Stub(responses: readonly { status: number; body: unknown }[]): {
  v4: FlutterwaveV4Client;
  sent: { url: string; body: unknown }[];
} {
  const sent: { url: string; body: unknown }[] = [];
  let i = 0;
  const v4 = new FlutterwaveV4Client({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetch: async (url, init) => {
      if (url.includes('openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      sent.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const next = responses[i++] ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { v4, sent };
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

  it('answers the BANK list for Ghana when a bank is asked for', async () => {
    /*
     * 070. A COUNTRY WITH TWO RAILS HAS TWO CATALOGUES.
     *
     * This used to short-circuit on "does this country have networks?", full
     * stop — so Ghana's and Kenya's bank lists were unreachable through this
     * adapter and a Ghanaian could only ever be offered a wallet. Returning
     * banks to somebody choosing a wallet is 046's failure; returning WALLETS
     * to somebody who asked for a bank is the same failure with the sides
     * swapped, and one of the two had to become a parameter.
     */
    const { client, sent } = stub([
      { status: 'success', data: [{ code: '130100', name: 'GCB Bank' }] },
    ]);
    const banks = await new FlutterwavePayoutAdapter(client).banks('GH', 'bank');
    expect(sent[0]?.url).toBe('https://api.flutterwave.com/v3/banks/GH');
    expect(banks).toEqual([{ code: '130100', name: 'GCB Bank' }]);
  });

  it('still answers the WALLET list when nothing is asked for', async () => {
    // Undefined means what every caller written before 070 meant, so a client
    // that has not shipped yet is unchanged rather than newly wrong.
    const { client, sent } = stub([]);
    const networks = await new FlutterwavePayoutAdapter(client).banks('GH');
    expect(sent).toHaveLength(0);
    expect(networks.map((n) => n.code)).toEqual(['MTN', 'VOD', 'ATL']);
  });
});

describe('who holds the destination', () => {
  it('asks v4 for a Ghanaian wallet, because v3 has no wallet resolver', async () => {
    /*
     * FIVE ROUNDS, AND THIS TEST HAS NOW ENCODED THREE DIFFERENT BELIEFS.
     *
     * It first asserted that a `GH`/`MTN` lookup threw `name_unavailable`
     * WITHOUT CALLING ANYTHING, and passed while customers in Accra reported
     * the opposite. Then it asserted a v3 `/accounts/resolve` call, on the
     * strength of a SEARCH SNIPPET, and passed while the same customers
     * reported the same thing.
     *
     * FLUTTERWAVE'S OWN v3 SPECIFICATION says that endpoint "resolves a BANK
     * ACCOUNT number ... account_bank: Bank code (3 DIGITS)". We were sending
     * `MTN` and twelve digits. No spelling of either was ever going to work.
     *
     * THE WALLET RESOLVER IS v4's `POST /wallet-account/resolve`, taking
     * `{ account_number, mobile_network, country }`. A test written from the
     * same assumption as the code passes everything; only the vendor's own
     * specification settles it, which is Phase 3's lesson for the third time.
     */
    const { client } = stub([]);
    const { v4, sent } = v4Stub([
      { status: 200, body: { account_name: 'RABI SIEDU', account_number: '233553921133' } },
    ]);
    const found = await new FlutterwavePayoutAdapter(client, v4).lookup(
      'GH',
      'MTN',
      '233553921133',
    );
    expect(sent[0]?.url).toContain('/wallet-account/resolve');
    expect(sent[0]?.body).toEqual({
      account_number: '233553921133',
      mobile_network: 'MTN',
      country: 'GH',
    });
    expect(found.accountName).toBe('RABI SIEDU');
    // The number that will be SENT is unchanged — 067's rule that the row
    // records what the provider was given.
    expect(found.accountNumber).toBe('233553921133');
  });

  it('reads the name whether it is wrapped in `data` or not', async () => {
    // Their published schema answers at the top level; several of their
    // surfaces wrap a payload. Being tolerant on a READ costs nothing and
    // being wrong costs every Ghanaian send — the Bitnob card-shape call.
    const { client } = stub([]);
    const { v4 } = v4Stub([{ status: 200, body: { data: { account_name: 'KWAME MENSAH' } } }]);
    const found = await new FlutterwavePayoutAdapter(client, v4).lookup('GH', 'MTN', '233240000000');
    expect(found.accountName).toBe('KWAME MENSAH');
  });

  it('says the NAME IS UNAVAILABLE when nobody has pasted the v4 credentials', async () => {
    /*
     * A CREDENTIAL NOBODY HAS IS NOT A NUMBER THAT IS WRONG, and the
     * difference decides whether a customer can send at all. 069's tri-state
     * turns `name_unavailable` into "ask for a label and go on" — Kenya's
     * behaviour — and `unknown_account` into a refusal. Reporting a missing
     * credential as the second would block every Ghanaian send on something
     * the customer cannot do anything about.
     */
    const { client } = stub([]);
    await expect(
      new FlutterwavePayoutAdapter(client).lookup('GH', 'MTN', '233553921133'),
    ).rejects.toMatchObject({ providerCode: 'name_unavailable' });
  });

  it('carries the refusal out, so somebody can read what the rail said', async () => {
    // 069's point stands whatever endpoint is called: a refusal nobody can
    // read is a refusal nobody can fix. The trail carries a number's SHAPE
    // and never its digits — 016's rule that the way to hold less is to
    // store less.
    const { client } = stub([]);
    const { v4 } = v4Stub([
      { status: 400, body: { message: 'wallet not found' } },
    ]);
    const failed = await new FlutterwavePayoutAdapter(client, v4)
      .lookup('GH', 'MTN', '233553921133')
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ providerCode: 'unknown_account' });
    const trail = JSON.stringify((failed as { cause?: unknown }).cause);
    expect(trail).toContain('wallet-account/resolve');
    expect(trail).not.toContain('233553921133');
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
