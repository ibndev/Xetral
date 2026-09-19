/**
 * The decisions `verify-flutterwave-sandbox.mjs` makes, extracted so they can
 * be tested without a live key.
 *
 * WHY THIS FILE EXISTS. The script's whole purpose is to tell an operator
 * whether this repo's constants match Flutterwave's real API — so a script
 * that reports a FAILURE for something that is a correct answer is worse than
 * no script at all: it is the thing people learn to skip, which is the
 * argument this repo already makes about a generic ruleset and about an alert
 * that fires on every declined card.
 *
 * It did exactly that on its first real run. Every Ghanaian telco answered
 * `GET /v3/banks/:id/branches` with 404 "No branches found for specified bank
 * id", the script counted three provider-contract failures, and the summary
 * said the constants in `packages/providers/src/flutterwave` were wrong. They
 * were not. A mobile money wallet HAVING NO BRANCHES IS THE ANSWER, and the
 * adapter already handles it — `branch_code` is filled in only where exactly
 * one branch comes back, so nothing at all changes when none does.
 *
 * None of these functions performs I/O. That is the point: what the script
 * concludes from a response is decided here and asserted in
 * `flutterwave-verify.test.mjs`, and what it does with a socket stays in the
 * script.
 */

/**
 * The body of the hosted-checkout probe.
 *
 * `redirect_url` IS REQUIRED AND THE SCRIPT DID NOT SEND ONE, so every run
 * answered `400 "One or more required parameters missing"` — a message that
 * names no parameter, on the one probe that proves money can come in. The
 * same request with a redirect URL answers 200 with a checkout link, which is
 * how this was settled: the field was added and the call was made, rather
 * than the message being read twice.
 *
 * It is a REAL URL rather than a placeholder because Flutterwave sends the
 * payer there after paying. Nothing is ever paid here — the link is opened by
 * an operator to read the amount and then abandoned — but a checkout that
 * would strand a payer on a dead host if anybody did pay is not the contract
 * this is meant to be verifying.
 */
export function checkoutPayload({ now = Date.now(), redirectUrl = 'https://app.xetral.com' } = {}) {
  return {
    tx_ref: `verify-${now}`,
    /* MAJOR units here and MINOR at Paystack — the factor-of-a-hundred this
     * adapter's tests pin, in the direction that overcharges a payer. */
    amount: '1.00',
    currency: 'GHS',
    redirect_url: redirectUrl,
    payment_options: 'mobilemoneyghana',
    customer: { email: 'verify@xetral.test' },
    customizations: { title: 'Xetral verification' },
  };
}

/**
 * Fields on a bank-list entry that state whether it has branches.
 *
 * READ FROM THE RESPONSE, NEVER INFERRED FROM THE NAME. The previous version
 * decided "this looks like a telco, therefore ask for branches", which is the
 * same shape of guess as the unsourced `MTN`/`VOD`/`ATL`/`MPS` codes this
 * whole script exists because of — a claim about their catalogue made without
 * reading it.
 *
 * Their v3 bank list is documented as `{ id, code, name }` and no published
 * field says anything about branches, so in practice this returns "unknown"
 * for every entry today. It is written anyway, and printed, because the cost
 * is nothing and the alternative is that the day they add such a field
 * nobody notices. `unknown` is not a gap to be filled with a guess: it means
 * ASK, and let the answer decide.
 */
const BRANCH_FIELDS = ['has_branches', 'supports_branches', 'branches_supported'];

/** Fields whose presence means the entry is a wallet rather than a bank. */
const WALLET_FIELDS = ['is_mobile_money', 'is_wallet', 'mobile_money'];

/**
 * What the listing itself says about whether `institution` has branches.
 *
 * `{ known: false }` means the listing does not say — which is the honest
 * answer and the one that leads to asking, not to assuming.
 */
export function branchSupportFromListing(institution) {
  if (institution === null || typeof institution !== 'object') return { known: false };

  for (const field of BRANCH_FIELDS) {
    const value = institution[field];
    if (typeof value === 'boolean') return { known: true, supported: value, field };
    /* An ARRAY on the entry is the listing answering the question outright. */
    if (Array.isArray(value)) return { known: true, supported: value.length > 0, field };
  }

  for (const field of WALLET_FIELDS) {
    const value = institution[field];
    /*
     * A wallet is not a bank and has nothing a branch could be. This is still
     * READING their field rather than matching their name — the distinction
     * that matters, because a name match is our guess about their catalogue
     * and a field is their statement about it.
     */
    if (value === true) return { known: true, supported: false, field };
  }

  return { known: false };
}

/**
 * What a `/v3/banks/:id/branches` response means.
 *
 * THREE OUTCOMES, NOT TWO, and collapsing the middle one is the bug this
 * file was written for:
 *
 *   `branches`  they have some, and the adapter may send one
 *   `none`      they have none, which is a correct answer and not a failure
 *   `error`     something we did not expect, which IS a failure
 *
 * `none` is recognised by the 404 AND by their sentence, because a 404 alone
 * is also what a wrong path produces — and a wrong path is exactly the class
 * of fault this script exists to catch. Requiring the message means a
 * genuinely missing endpoint still reports as an error rather than being
 * waved through as "no branches", which would be this script lying in the
 * flattering direction.
 */
const NO_BRANCHES = /no branches? found/i;

export function classifyBranchResponse({ httpStatus, payload }) {
  const message = typeof payload?.message === 'string' ? payload.message : '';

  if (payload?.status === 'success' && Array.isArray(payload.data)) {
    return payload.data.length === 0
      ? { kind: 'none', reason: 'the endpoint answered with an empty list' }
      : { kind: 'branches', branches: payload.data };
  }

  if (httpStatus === 404 && NO_BRANCHES.test(message)) {
    return { kind: 'none', reason: message };
  }

  return {
    kind: 'error',
    detail: message === '' ? `HTTP ${String(httpStatus)}` : `${String(httpStatus)} ${message}`,
  };
}

/**
 * What the adapter will actually put on the wire for this institution.
 *
 * Mirrors `#transferRail`'s rule rather than restating it loosely: exactly one
 * branch is sent, several are not, because choosing among them would be
 * inventing a destination — the mistake that file has already made twice in
 * the other direction.
 */
export function branchCodeForTransfer(branches) {
  return Array.isArray(branches) && branches.length === 1
    ? (branches[0]?.branch_code ?? undefined)
    : undefined;
}

/**
 * The closing summary, as data.
 *
 * FOUR CATEGORIES, because the run that prompted this had two real successes,
 * one real failure and three non-failures reported as failures, and printed
 * one number. An operator reading "6 probe(s) failed" against a working
 * integration cannot act on it, and the next person to see a red summary will
 * assume it is that again.
 */
export function summarise({ passed = 0, failed = 0, checkout = null, noBranches = [] } = {}) {
  const lines = [];

  lines.push(`API and authentication: ${String(passed)} check(s) passed.`);

  if (checkout === null) lines.push('Hosted checkout: NOT ATTEMPTED.');
  else if (checkout.ok) lines.push(`Hosted checkout: initialised — ${String(checkout.link)}`);
  else lines.push(`Hosted checkout: FAILED — ${String(checkout.detail)}`);

  if (noBranches.length > 0) {
    lines.push(
      `No branches (expected, not a failure): ${noBranches.map((n) => String(n)).join(', ')}.`,
    );
    lines.push(
      '  A wallet has no branch, so the adapter sends no destination_branch_code ' +
        'for it — which is what it already does when a lookup returns none.',
    );
  }

  lines.push(
    failed === 0
      ? 'Unexpected failures: none. Record TODAY’S DATE beside the endpoint table in client.ts.'
      : `Unexpected failures: ${String(failed)} — the constants in packages/providers/src/flutterwave are wrong.`,
  );

  return { lines, exitCode: failed === 0 ? 0 : 1 };
}
