#!/usr/bin/env node
/**
 * Probe a real Flutterwave key, and check this repo's constants against it.
 *
 * WHY THIS EXISTS, and why it is the first thing to run before Ghana or Kenya
 * takes a real payment. Every endpoint, field name and vocabulary in
 * `packages/providers/src/flutterwave/` was written from Flutterwave's
 * published v3 API in September 2026. That is a source AND a date, and this
 * repo has now been bitten twice by a table of plausible constants that
 * passed every test written from the same assumptions and failed on the first
 * live call — Bitnob's card paths, and its webhook hash.
 *
 * `verify-bitnob-sandbox.mjs` was written for exactly that and had never been
 * run when the v2 migration finally forced the issue. So: run this one.
 *
 *   FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-... node scripts/verify-flutterwave-sandbox.mjs
 *
 * IT MOVES NO MONEY. Every probe is a read, or a checkout initialise that is
 * never paid — the two things that can be asked of a test key without leaving
 * anything behind.
 */
const KEY = process.env['FLUTTERWAVE_SECRET_KEY'];
const BASE = process.env['FLUTTERWAVE_BASE_URL'] ?? 'https://api.flutterwave.com';

if (KEY === undefined || KEY === '') {
  console.error('set FLUTTERWAVE_SECRET_KEY (a TEST key — FLWSECK_TEST-...)');
  process.exit(2);
}
if (!KEY.includes('TEST')) {
  // A live key here would issue a real checkout link against real money. The
  // refusal is the same shape as the staging guard in `config.ts`.
  console.error('that does not look like a TEST key. Refusing to probe with a live one.');
  process.exit(2);
}

let failures = 0;

async function probe(name, method, path, body) {
  process.stdout.write(`${name} … `);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      console.log(`FAIL — ${response.status}, and the body is not JSON`);
      failures += 1;
      return undefined;
    }
    /*
     * THE ENVELOPE IS A STRING, NOT A BOOLEAN — the single most likely way a
     * refusal is recorded as a success in this adapter, because the Paystack
     * client one directory away tests `status === false` and every non-empty
     * string is truthy.
     */
    if (payload.status !== 'success') {
      console.log(`FAIL — ${response.status} ${JSON.stringify(payload.message ?? payload)}`);
      failures += 1;
      return undefined;
    }
    console.log('ok');
    return payload.data;
  } catch (error) {
    console.log(`FAIL — ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
    return undefined;
  }
}

// 1. The key is accepted at all, and the path shape is right. `/v3` is on the
//    PATH, not on the base URL — a base ending in /v3 gives /v3/v3/banks/GH,
//    which is the doubling 042 records about Bitnob.
const ghanaBanks = await probe('GET /v3/banks/GH', 'GET', '/v3/banks/GH');

// 2. The hosted checkout, in cedis. THE AMOUNT IS MAJOR UNITS here and MINOR
//    at Paystack — the factor-of-a-hundred this adapter's tests pin, in the
//    direction that overcharges a payer.
const session = await probe('POST /v3/payments (GHS, major units)', 'POST', '/v3/payments', {
  tx_ref: `verify-${Date.now()}`,
  amount: '1.00',
  currency: 'GHS',
  payment_options: 'mobilemoneyghana',
  customer: { email: 'verify@xetral.test' },
  customizations: { title: 'Xetral verification' },
});

// 3. Verifying by OUR reference rather than by their id — the call the whole
//    settle path depends on. A reference nobody paid must REFUSE rather than
//    answering a zero-amount success.
process.stdout.write('GET /v3/transactions/verify_by_reference (unknown ref) … ');
const unknown = await fetch(
  `${BASE}/v3/transactions/verify_by_reference?tx_ref=xetral-does-not-exist`,
  { headers: { authorization: `Bearer ${KEY}` } },
);
const unknownBody = await unknown.json().catch(() => ({}));
if (unknownBody.status === 'success') {
  console.log('FAIL — an unknown reference answered success; settle would credit nothing safely');
  failures += 1;
} else {
  console.log(`ok (refused: ${String(unknownBody.message ?? unknown.status)})`);
}

/*
 * 4. THE TRANSFER CONTRACT — the probe this script did not have, and the one
 *    the Ghana and Kenya corridor turns on.
 *
 *    Everything above proves the key works and money can come IN. Nothing
 *    proved anything about money going OUT, which is the direction that
 *    cannot be recalled and the one customers reported broken. Two things
 *    have to be settled against a real account and neither can be settled
 *    from a specification:
 *
 *      - WHICH `account_bank` a wallet transfer takes. This repo held `MTN`,
 *        `VOD`, `ATL` and `MPS` as constants no vendor document produces. The
 *        adapter now reads them out of THEIR OWN Ghana list instead, and this
 *        prints what that list actually says so an operator can see it.
 *      - WHETHER a Ghanaian wallet needs `destination_branch_code`. Their
 *        documentation says bank accounts and mobile money wallets both do;
 *        this fetches the branches of each telco so the answer is visible
 *        rather than assumed.
 *
 *    IT DOES NOT SEND MONEY. A transfer probe that moved a cedi would be a
 *    verification script with a side effect somebody has to reconcile, so
 *    this reads the two lists the transfer is BUILT from and leaves the
 *    sending to a real customer.
 */
const NETWORK_HINTS = ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO', 'TIGO', 'AIRTEL'];
if (Array.isArray(ghanaBanks)) {
  const telcos = ghanaBanks.filter((b) =>
    NETWORK_HINTS.some((hint) => String(b?.name ?? '').toUpperCase().includes(hint)),
  );
  console.log('');
  console.log(`Ghana list: ${ghanaBanks.length} entries, ${telcos.length} look like a telco.`);
  if (telcos.length === 0) {
    console.log(
      'FAIL — no mobile money network is in Flutterwave\'s Ghana list. The adapter ' +
        'falls back to MTN/VOD/ATL, which nothing here sources from Flutterwave. ' +
        'Ask their support for the account_bank values a GHS wallet transfer takes.',
    );
    failures += 1;
  }
  for (const telco of telcos) {
    console.log(`  account_bank=${telco.code}  id=${telco.id}  ${telco.name}`);
    if (telco?.id === undefined) continue;
    const branches = await probe(
      `  GET /v3/banks/${telco.id}/branches`,
      'GET',
      `/v3/banks/${telco.id}/branches`,
    );
    if (Array.isArray(branches)) {
      console.log(
        branches.length === 1
          ? `    destination_branch_code=${branches[0]?.branch_code} (one branch — the adapter sends it)`
          : `    ${branches.length} branches — the adapter sends NONE, because choosing would be inventing one`,
      );
    }
  }
}
if (session !== undefined) {
  console.log(`Checkout link: ${session.link}`);
  console.log('Open it and confirm the amount reads 1.00 cedi, NOT 100 or 0.01.');
}

console.log('');
console.log(
  failures === 0
    ? 'All probes passed. Record TODAY\'S DATE beside the endpoint table in client.ts.'
    : `${failures} probe(s) failed — the constants in packages/providers/src/flutterwave are wrong.`,
);
process.exit(failures === 0 ? 0 : 1);
