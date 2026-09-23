import { describe, expect, it } from 'vitest';
import { ghs, kes, ngn } from './test-money.js';
import { FlutterwaveClient } from './client.js';
import { FlutterwavePayoutAdapter } from './payout-adapter.js';
import { FlutterwaveV4Client } from './v4-client.js';
import { ProviderRejectedError } from '../ports/errors.js';

/**
 * A v3 stand-in that can ROUTE BY URL as well as by position.
 *
 * `send()` now asks Flutterwave which code THEY use for a network before it
 * transfers, so a purely positional stub hands the transfer's scripted body to
 * the bank-list call and every send test fails for a reason unrelated to what
 * it is testing. That is the fault this file's own `v4Stub` comment records,
 * one client over — position is the wrong key the moment the code under test
 * may legitimately make one more call.
 *
 * Named routes win where a test supplies them; everything else falls through
 * to the positional script, so every test written before this reads the same.
 */
function stub(
  responses: readonly unknown[],
  routes: { banks?: unknown; branches?: unknown } = {},
): {
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
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/branches') && routes.branches !== undefined) return json(routes.branches);
      if (url.includes('/v3/banks/') && !url.includes('/branches') && routes.banks !== undefined) {
        return json(routes.banks);
      }
      return json(responses[i++] ?? { status: 'success', data: {} });
    },
  });
  return { client, sent };
}

/** Flutterwave's Ghana list, in the shape their API answers: the telcos are in
 *  it, under THEIR codes, each with an id the branches path takes. */
const GHANA_LIST = {
  status: 'success',
  data: [
    { id: 1, code: 'MTN', name: 'MTN Mobile Money' },
    { id: 2, code: 'VODAFONE', name: 'Vodafone (Telecel) Cash' },
    { id: 3, code: 'AIRTELTIGO', name: 'AirtelTigo Money' },
  ],
};

/** Flutterwave's Kenya list. M-PESA is Safaricom's and their catalogue names
 *  it neither `MPS` nor anything containing those three letters, which is the
 *  whole of why Kenya needed its own hints. */
const KENYA_LIST = {
  status: 'success',
  data: [{ id: 41, code: 'MPESA', name: 'Safaricom M-PESA' }],
};

/** The transfer body out of a recorded exchange, found by URL rather than by
 *  position — the same reason the stub routes that way. */
function transferBody(sent: readonly { url: string; body: unknown }[]): Record<string, unknown> {
  const found = sent.find((r) => r.url.endsWith('/v3/transfers'));
  expect(found, 'no /v3/transfers call was made').toBeDefined();
  return found?.body as Record<string, unknown>;
}

/** A v4 client whose token exchange and calls are both stubbed. */
/**
 * A v4 stand-in that ROUTES BY URL rather than by position.
 *
 * It used to answer the nth request with the nth scripted body, and the
 * adapter now asks `/mobile-networks` before it resolves anything — so every
 * scripted resolve answered the network list instead, and three tests failed
 * for a reason that had nothing to do with what they were testing. Position
 * is the wrong key whenever the code under test may legitimately make one
 * more call, which is the same argument the Expo adapter records about
 * attributing a push ticket to a handset.
 *
 * `networks` defaults to EMPTY, which is the honest default: a deployment
 * whose network list cannot be read falls back to the code this platform
 * already holds, and most of these tests are about the resolve.
 */
function v4Stub(
  resolves: readonly { status: number; body: unknown }[],
  networks: readonly { id?: string; code?: string; name?: string }[] = [],
): {
  v4: FlutterwaveV4Client;
  sent: { url: string; body: unknown }[];
} {
  const sent: { url: string; body: unknown }[] = [];
  let i = 0;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const v4 = new FlutterwaveV4Client({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetch: async (url, init) => {
      if (url.includes('openid-connect/token')) {
        return json({ access_token: 'tok', expires_in: 600 });
      }
      sent.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (url.includes('/mobile-networks')) return json({ data: networks });
      const next = resolves[i++] ?? { status: 200, body: {} };
      return json(next.body, next.status);
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
    /* THE NETWORK LIST IS ASKED FIRST, then the resolve. `mobile_network` is
       typed as a bare string in their spec and their own network object
       carries both an `id` and a `code`, so the adapter reads THEIR list
       rather than asserting which one the field wants — the assertion that
       cost five rounds, in the one place left that could still make it. */
    const resolve = sent.find((r) => r.url.includes('/wallet-account/resolve'));
    expect(resolve).toBeDefined();
    expect(resolve?.body).toEqual({
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

  it('BLOCKS on a 404, because that is the rail naming nobody', async () => {
    /*
     * THE ONLY ANSWER THAT MAY STOP A SEND IS THE RAIL'S OWN VERDICT. A 404
     * from the wallet resolver means Flutterwave looked and that number
     * belongs to nobody — money sent there is unrecoverable, so `lookup`
     * refuses and the screen refuses with it.
     */
    const { client } = stub([]);
    const { v4 } = v4Stub([{ status: 404, body: { message: 'wallet not found' } }]);
    const failed = await new FlutterwavePayoutAdapter(client, v4)
      .lookup('GH', 'MTN', '233553921133')
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ providerCode: 'unknown_account' });
    const trail = JSON.stringify((failed as { cause?: unknown }).cause);
    expect(trail).toContain('v4 resolve');
    // The trail carries a number's SHAPE and never its digits — 016's rule
    // that the way to hold less is to store less.
    expect(trail).not.toContain('233553921133');
  });

  it('DOES NOT BLOCK on a 400, because that is about our request', async () => {
    /*
     * THE REGRESSION THIS TEST EXISTS FOR, and it took the Ghanaian corridor
     * down the day a v4 credential was pasted.
     *
     * Every non-2xx used to become `unknown_account`, which the Send screen
     * refuses on. So a malformed field, a product not enabled on the account,
     * or a client id that does not authorise stopped EVERY Ghanaian send —
     * worded to each customer as their own number being wrong, which is the
     * exact sentence five rounds of this were spent on.
     *
     * A 400 says the REQUEST was wrong, and the request is the part we wrote.
     * So it degrades to `name_unavailable`: the screen asks for a label and
     * the send proceeds, exactly as Kenya already does — and the refusal is
     * still carried out, so `name_enquiry_refusals` can say what happened.
     */
    const { client } = stub([]);
    const { v4 } = v4Stub([{ status: 400, body: { message: 'invalid mobile_network' } }]);
    const failed = await new FlutterwavePayoutAdapter(client, v4)
      .lookup('GH', 'MTN', '233553921133')
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ providerCode: 'name_unavailable' });
    const trail = JSON.stringify((failed as { cause?: unknown }).cause);
    expect(trail).toContain('invalid mobile_network');
  });

  it('tries the network spelling THEIR list gives before concluding anything', async () => {
    /*
     * `mobile_network` IS A BARE STRING IN THEIR SPEC and their own network
     * object carries an `id` AND a `code` — while the sibling endpoint on the
     * same specification names its field `bank_id` where it wants an id. The
     * question is genuinely open, and picking one and writing a test that
     * agrees is precisely what this file has now done wrong three times.
     *
     * So the code we hold goes first, and a refusal that is about the REQUEST
     * moves to the value their own list gave. Bounded, provider-sourced, and
     * recorded either way.
     */
    const { client } = stub([]);
    const { v4, sent } = v4Stub(
      [
        { status: 400, body: { message: 'invalid mobile_network' } },
        { status: 200, body: { account_name: 'RABI SIEDU' } },
      ],
      [{ id: 'mn_ghana_mtn', code: 'MTN', name: 'MTN Ghana' }],
    );
    const found = await new FlutterwavePayoutAdapter(client, v4).lookup(
      'GH',
      'MTN',
      '233553921133',
    );
    expect(found.accountName).toBe('RABI SIEDU');
    const networks = sent
      .filter((r) => r.url.includes('/wallet-account/resolve'))
      .map((r) => (r.body as { mobile_network: string }).mobile_network);
    expect(networks).toEqual(['MTN', 'mn_ghana_mtn']);
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
    const { client, sent } = stub([{ status: 'success', data: { id: 99, status: 'NEW' } }], {
      banks: GHANA_LIST,
      branches: { status: 'success', data: [{ branch_code: 'GH-MTN-1', branch_name: 'MTN' }] },
    });
    const receipt = await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'MTN',
      accountNumber: '0244123456',
      accountName: 'Ama Mensah',
      amount: ghs(250_00n),
      reference: 'xetpay-out-1',
    });

    const body = transferBody(sent);
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

  it('carries the reference THEY recorded, which is what ties an unsigned event to our payout', async () => {
    const { client } = stub([
      { status: 'success', data: { id: 7, status: 'SUCCESSFUL', reference: 'xetpay-out-7' } },
      { status: 'success', data: { id: 8, status: 'NEW' } },
    ]);
    const adapter = new FlutterwavePayoutAdapter(client);
    expect((await adapter.status('7')).reference).toBe('xetpay-out-7');
    // Absent, not invented: a receipt with no echo matches no payout.
    expect((await adapter.status('8')).reference).toBeUndefined();
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

  it('SENDS FLUTTERWAVE\'S OWN CODE, not the one this platform abbreviates with', async () => {
    /*
     * THE CORRIDOR'S BUG, AND IT WAS ON THE ONE CALL THAT MOVES MONEY.
     *
     * `FLUTTERWAVE_MOBILE_MONEY_NETWORKS` holds `VOD` and `ATL`. Nothing in
     * this repo sources those from Flutterwave, and the READ path already
     * distrusted them enough to reconcile against the live list before asking
     * for a name — while the TRANSFER sent them verbatim. A constant good
     * enough to be checked before a retryable lookup and not before an
     * irreversible payout had the asymmetry exactly backwards.
     */
    const { client, sent } = stub([{ status: 'success', data: { id: 7, status: 'NEW' } }], {
      banks: GHANA_LIST,
      branches: { status: 'success', data: [{ branch_code: 'GH-VOD-1', branch_name: 'Telecel' }] },
    });
    await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'VOD',
      accountNumber: '233551234567',
      amount: ghs(25_00n),
      reference: 'xetpay-out-vod',
    });

    const body = transferBody(sent);
    expect(body['account_bank']).toBe('VODAFONE');
    /* And the beneficiary LABEL reads the way their dashboard names the
       network, not the way this platform abbreviates it. */
    expect(body['beneficiary_name']).toBe('VODAFONE 4567');
  });

  it('DOES THE SAME FOR KENYA, which the first version of the fix silently did not', async () => {
    /*
     * THE HALF THAT WAS MISSING FROM THE FIX FOR THE HALF THAT WAS MISSING.
     *
     * `#transferRail` first read `RESOLVE_TELCO_ALIASES`, which is about what
     * `/v3/accounts/resolve` ACCEPTS — a Ghana-only endpoint, so a Ghana-only
     * table. Every Ghanaian network has an entry and Kenya has none, so Ghana
     * was fixed and Kenya fell straight back through to the unsourced `MPS`
     * with no test able to notice: the suite was all Ghanaian, the code path
     * was shared, and the fallback is silent by construction.
     *
     * `MPS` does not appear in their name either, so a bare containment test
     * finds nothing — which is what makes this a hints table rather than a
     * substring of the code we hold.
     */
    const { client, sent } = stub([{ status: 'success', data: { id: 9, status: 'NEW' } }], {
      banks: KENYA_LIST,
    });
    await new FlutterwavePayoutAdapter(client).send({
      country: 'KE',
      bankCode: 'MPS',
      accountNumber: '254701234567',
      amount: kes(500_00n),
      reference: 'xetpay-out-mps',
    });

    const body = transferBody(sent);
    expect(body['account_bank']).toBe('MPESA');
    expect(body['beneficiary_name']).toBe('MPESA 4567');
    /* Kenya is not in `REQUIRES_BRANCH_CODE`, so no branch is invented for it
       and none is looked up. */
    expect(body['destination_branch_code']).toBeUndefined();
    expect(sent.some((r) => r.url.includes('/branches'))).toBe(false);
  });

  it('CARRIES A GHANAIAN BRANCH CODE, which no wallet transfer could before', async () => {
    /*
     * Flutterwave, quoted in this adapter's own header: "When transferring to
     * Ghanaian bank accounts AND MOBILE MONEY WALLETS, you need to pass the
     * branch code of the institution or telco ... as destination_branch_code."
     *
     * Nothing in this platform could produce one for a wallet. The recipient
     * row stores `branch_code: null` for every momo destination and the
     * branches route searches the BANK list, where a telco code is never
     * found — so every Ghanaian wallet transfer went out missing a field their
     * own documentation calls required.
     */
    const { client, sent } = stub([{ status: 'success', data: { id: 8, status: 'NEW' } }], {
      banks: GHANA_LIST,
      branches: { status: 'success', data: [{ branch_code: 'GH-MTN-1', branch_name: 'MTN' }] },
    });
    await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'MTN',
      accountNumber: '233241234567',
      amount: ghs(25_00n),
      reference: 'xetpay-out-mtn',
    });
    expect(transferBody(sent)['destination_branch_code']).toBe('GH-MTN-1');
  });

  it('WILL NOT CHOOSE among several branches, because that is inventing one', async () => {
    // A telco has one branch and a bank has many; where the customer picks,
    // this file must not. The caller's own value still wins — see below.
    const { client, sent } = stub([{ status: 'success', data: { id: 9, status: 'NEW' } }], {
      banks: GHANA_LIST,
      branches: {
        status: 'success',
        data: [
          { branch_code: 'A', branch_name: 'Accra' },
          { branch_code: 'B', branch_name: 'Kumasi' },
        ],
      },
    });
    await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'MTN',
      accountNumber: '233241234567',
      amount: ghs(25_00n),
      reference: 'xetpay-out-many',
    });
    expect(transferBody(sent)['destination_branch_code']).toBeUndefined();
  });

  it('KEEPS THE CALLER\'S BRANCH where one was chosen on a screen', async () => {
    const { client, sent } = stub([{ status: 'success', data: { id: 10, status: 'NEW' } }], {
      banks: GHANA_LIST,
      branches: { status: 'success', data: [{ branch_code: 'GH-MTN-1', branch_name: 'MTN' }] },
    });
    await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'MTN',
      accountNumber: '233241234567',
      branchCode: 'CHOSEN-BY-CUSTOMER',
      amount: ghs(25_00n),
      reference: 'xetpay-out-chosen',
    });
    expect(transferBody(sent)['destination_branch_code']).toBe('CHOSEN-BY-CUSTOMER');
  });

  it('SENDS EXACTLY WHAT IT ALWAYS DID when their list cannot be read', async () => {
    /*
     * 059's rule: a missing row falls through rather than turning one absent
     * answer into an outage on the screen customers send money from. A
     * deployment whose bank list 500s must be no worse off than before any of
     * this existed.
     */
    const { client, sent } = stub([{ status: 'success', data: { id: 11, status: 'NEW' } }], {
      banks: { nonsense: true },
    });
    await new FlutterwavePayoutAdapter(client).send({
      country: 'GH',
      bankCode: 'VOD',
      accountNumber: '233551234567',
      amount: ghs(25_00n),
      reference: 'xetpay-out-blind',
    });
    const body = transferBody(sent);
    expect(body['account_bank']).toBe('VOD');
    expect(body['destination_branch_code']).toBeUndefined();
  });

  it('is generic over its currency, so a concrete amount compiles', async () => {
    // `Money` is invariant. A non-generic `send` compiles and then rejects
    // every caller holding `ngn(…)` or `kes(…)` — the trap Phase 10 and Phase
    // 14 both walked into. This test exists to fail at TYPECHECK, not at run.
    const { client } = stub(
      [
        { status: 'success', data: { id: 4, status: 'NEW' } },
        { status: 'success', data: { id: 5, status: 'NEW' } },
      ],
      /* Their list carries neither of these, so the transfer falls back to the
         code this platform holds — which is the behaviour every corridor had
         before the rail was resolved from their data. */
      { banks: { status: 'success', data: [] } },
    );
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
