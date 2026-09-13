#!/usr/bin/env node
/**
 * PROVE THE v4 WALLET RESOLVER ANSWERS, AGAINST A REAL KEY.
 *
 * WHY THIS EXISTS, AND WHY IT MUST BE RUN. Five rounds of "it says it cannot
 * find the momo details", and every round shipped a change that was correct
 * about the layer it touched and wrong about the endpoint underneath:
 *
 *   1. the SCREEN enabled a button whose handler refused
 *   2. the SERVER treated a name refusal as a reason not to send
 *   3. the ADAPTER refused before calling anything, on a belief
 *   4. the ADAPTER called v3 and retried two spellings, on a search snippet
 *
 * Round four is the one this script is aimed at. `/v3/accounts/resolve` is a
 * BANK-account resolver — Flutterwave's own specification says "account_bank:
 * Bank code (3 DIGITS)" — so `MTN` and a twelve-digit phone number were never
 * going to resolve, however carefully they were retried. The wallet resolver
 * is v4's `POST /wallet-account/resolve`.
 *
 * THIS REPO HAS NOW SHIPPED A TABLE OF PLAUSIBLE CONSTANTS THREE TIMES, and
 * each time the tests agreed because the same person wrote both. The only
 * thing that settles it is a live call. Run this before relying on the name.
 *
 *   FLUTTERWAVE_V4_CLIENT_ID=… FLUTTERWAVE_V4_CLIENT_SECRET=… \
 *   node scripts/verify-flutterwave-v4.mjs 233553921133 MTN GH
 *
 * IT MOVES NO MONEY. Every call here is a read.
 */

const TOKEN_URL =
  process.env.FLUTTERWAVE_V4_TOKEN_URL ??
  'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

/*
 * TWO PUBLIC SOURCES DISAGREE ABOUT THE HOST. Flutterwave's published OpenAPI
 * says `api.flutterwave.cloud/f4b/production`; their own developer blog says
 * `f4bexperience.flutterwave.com`. The specification is the default and this
 * script prints which one it used, because the first thing a 404 here means is
 * that the other one was right.
 */
const BASE =
  process.env.FLUTTERWAVE_V4_BASE_URL ?? 'https://api.flutterwave.cloud/f4b/production';

const [number, network, country] = process.argv.slice(2);

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const clientId = process.env.FLUTTERWAVE_V4_CLIENT_ID;
const clientSecret = process.env.FLUTTERWAVE_V4_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  fail(
    'set FLUTTERWAVE_V4_CLIENT_ID and FLUTTERWAVE_V4_CLIENT_SECRET. They are ' +
      'generated under the v4 Developer toggle and are NOT the v3 secret key.',
  );
}
if (!number || !network || !country) {
  fail('usage: verify-flutterwave-v4.mjs <number> <network> <country>');
}

console.log(`\n  base   ${BASE}`);
console.log(`  token  ${TOKEN_URL}\n`);

/* ---- 1. The token. A 401 here is the credentials, not the endpoint. ---- */
const tokenResponse = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString(),
});
const tokenBody = await tokenResponse.text();
if (!tokenResponse.ok) {
  fail(`the token endpoint answered ${tokenResponse.status}: ${tokenBody.slice(0, 400)}`);
}

let token;
try {
  const parsed = JSON.parse(tokenBody);
  token = parsed.access_token;
  console.log(`  ✓ token obtained, valid for ${parsed.expires_in ?? '?'}s`);
} catch {
  fail(`the token endpoint returned a non-JSON body: ${tokenBody.slice(0, 400)}`);
}
if (!token) fail('the token endpoint returned no access_token');

/* ---- 2. The wallet resolver, which is the whole point. ---- */
const resolveResponse = await fetch(`${BASE}/wallet-account/resolve`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    account_number: number,
    mobile_network: network,
    country: country.toUpperCase(),
  }),
});
const resolveBody = await resolveResponse.text();

console.log(`\n  POST /wallet-account/resolve → ${resolveResponse.status}`);
console.log(`  ${resolveBody.slice(0, 800)}\n`);

if (resolveResponse.status === 404) {
  fail(
    'the resolver answered 404. THE BASE URL IS THE FIRST THING TO CHECK — ' +
      'try FLUTTERWAVE_V4_BASE_URL=https://f4bexperience.flutterwave.com, ' +
      'which is the host their developer blog names. If both 404, the ' +
      'endpoint has moved and `v4-client.ts` is out of date: correct it there ' +
      'and say where the new path came from AND on what date.',
  );
}
if (!resolveResponse.ok) {
  fail(
    'the resolver refused. That is an answer worth having either way: it may ' +
      'mean the number is not on that network, or that name enquiry is not ' +
      'enabled on this account. The sentence above is what the payout service ' +
      'now writes to `name_enquiry_refusals`.',
  );
}

const parsed = JSON.parse(resolveBody);
const name = parsed.account_name ?? parsed.data?.account_name;
if (!name) {
  fail(
    'the resolver answered 200 and named nobody. Check whether the name sits ' +
      'under a key this adapter does not read — `v4-client.ts` accepts a ' +
      'top-level `account_name` and one wrapped in `data`.',
  );
}

console.log(`  ✓ ${network} ${number} resolves to: ${name}\n`);
