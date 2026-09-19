import { describe, expect, it } from 'vitest';
import {
  branchCodeForTransfer,
  branchSupportFromListing,
  checkoutPayload,
  classifyBranchResponse,
  summarise,
} from './flutterwave-verify.mjs';

/**
 * WHAT THE FIRST REAL RUN AGAINST A TEST KEY REPORTED, pinned.
 *
 * Six probes, of which the script called four failures. One was real (the
 * checkout body), three were correct answers it did not recognise, and the
 * summary showed a single number for all of them — so the one finding an
 * operator could act on was buried under three they could not.
 *
 * Every case below is a response that actually came back from Flutterwave on
 * 19 September 2026, not one invented to make a function pass.
 */

describe('the hosted checkout probe', () => {
  it('sends a redirect_url, because /v3/payments requires one', () => {
    /*
     * THE FAILURE THIS FIXES. Without it the call answers 400 "One or more
     * required parameters missing" — a message naming no parameter — so the
     * probe that proves money can come in had never once succeeded, and the
     * script blamed the API for its own body.
     */
    const body = checkoutPayload();
    expect(body.redirect_url).toBeTypeOf('string');
    expect(body.redirect_url).toMatch(/^https:\/\//);
  });

  it('asks for one cedi in MAJOR units', () => {
    // Minor units at Paystack and major here: the factor of a hundred, in the
    // direction that overcharges a payer.
    const body = checkoutPayload({ now: 1_700_000_000_000 });
    expect(body.amount).toBe('1.00');
    expect(body.currency).toBe('GHS');
    expect(body.tx_ref).toBe('verify-1700000000000');
  });

  it('carries every field the successful manual request carried', () => {
    // Pinned against the body that actually returned 200 and a checkout link,
    // so a later tidy-up cannot quietly drop one and reintroduce the 400.
    expect(Object.keys(checkoutPayload()).sort()).toEqual([
      'amount',
      'currency',
      'customer',
      'customizations',
      'payment_options',
      'redirect_url',
      'tx_ref',
    ]);
  });
});

describe('what a /branches response means', () => {
  it('a telco 404 is no-branches, NOT a failure', () => {
    /*
     * THE EXACT RESPONSE all three Ghanaian telcos gave. Counting it as a
     * provider-contract failure told an operator the adapter's constants were
     * wrong about an integration that was working.
     */
    const verdict = classifyBranchResponse({
      httpStatus: 404,
      payload: { status: 'error', message: 'No branches found for specified bank id' },
    });
    expect(verdict.kind).toBe('none');
    expect(verdict.reason).toMatch(/no branches/i);
  });

  it('an empty list is also no-branches', () => {
    const verdict = classifyBranchResponse({
      httpStatus: 200,
      payload: { status: 'success', data: [] },
    });
    expect(verdict.kind).toBe('none');
  });

  it('branches come back as branches', () => {
    const verdict = classifyBranchResponse({
      httpStatus: 200,
      payload: { status: 'success', data: [{ branch_code: 'GH010101', branch_name: 'Accra' }] },
    });
    expect(verdict.kind).toBe('branches');
    expect(verdict.branches).toHaveLength(1);
  });

  it('a genuine unexpected error is STILL a failure', () => {
    // The half that matters as much: a script that waved every 404 through
    // would stop being able to see a wrong path, which is the class of fault
    // it exists to catch.
    for (const response of [
      { httpStatus: 401, payload: { status: 'error', message: 'Authorization required' } },
      { httpStatus: 500, payload: { status: 'error', message: 'server error' } },
      { httpStatus: 0, payload: undefined },
    ]) {
      expect(classifyBranchResponse(response).kind, JSON.stringify(response)).toBe('error');
    }
  });

  it('a 404 that is NOT about branches is a failure', () => {
    /*
     * A wrong path answers 404 too. Recognising "no branches" by the STATUS
     * alone would turn a missing endpoint into a clean run — this script
     * lying in the flattering direction, which is the one failure mode a
     * verification script cannot have.
     */
    const verdict = classifyBranchResponse({
      httpStatus: 404,
      payload: { status: 'error', message: 'Route not found' },
    });
    expect(verdict.kind).toBe('error');
    expect(verdict.detail).toContain('Route not found');
  });
});

describe('what the listing itself says about branches', () => {
  it('says nothing for a plain v3 entry, which means ASK', () => {
    // Their documented shape is { id, code, name } and carries no such field.
    // "Unknown" has to lead to the endpoint, not to a guess.
    expect(branchSupportFromListing({ id: 1, code: 'MTN', name: 'MTN Mobile Money' })).toEqual({
      known: false,
    });
  });

  it('believes a field when there is one', () => {
    expect(branchSupportFromListing({ name: 'X', has_branches: false })).toEqual({
      known: true,
      supported: false,
      field: 'has_branches',
    });
    expect(branchSupportFromListing({ name: 'X', has_branches: true })).toEqual({
      known: true,
      supported: true,
      field: 'has_branches',
    });
  });

  it('reads a wallet flag as having no branches', () => {
    expect(branchSupportFromListing({ name: 'X', is_mobile_money: true })).toEqual({
      known: true,
      supported: false,
      field: 'is_mobile_money',
    });
  });

  it('does not decide anything from the NAME', () => {
    /*
     * The rule this file exists to hold. Matching "MTN" and concluding "no
     * branches" is the same shape of guess as the unsourced MTN/VOD/ATL/MPS
     * codes the adapter was sending — a claim about their catalogue made
     * without reading it.
     */
    for (const name of ['MTN Mobile Money', 'Vodafone Cash', 'AirtelTigo Money', 'Safaricom M-PESA']) {
      expect(branchSupportFromListing({ id: 1, code: 'X', name }), name).toEqual({ known: false });
    }
  });

  it('is unbothered by a malformed entry', () => {
    for (const entry of [null, undefined, 'MTN', 42]) {
      expect(branchSupportFromListing(entry)).toEqual({ known: false });
    }
  });
});

describe('what the adapter would send', () => {
  it('sends the code when there is exactly one branch', () => {
    expect(branchCodeForTransfer([{ branch_code: 'GH010101' }])).toBe('GH010101');
  });

  it('sends nothing when there are several, because choosing invents one', () => {
    expect(branchCodeForTransfer([{ branch_code: 'A' }, { branch_code: 'B' }])).toBeUndefined();
  });

  it('sends nothing when there are none', () => {
    // Which is the telco case, and is why a 404 changes nothing on the wire.
    expect(branchCodeForTransfer([])).toBeUndefined();
    expect(branchCodeForTransfer(undefined)).toBeUndefined();
  });
});

describe('the summary', () => {
  it('separates the four things that used to be one number', () => {
    const { lines, exitCode } = summarise({
      passed: 5,
      failed: 0,
      checkout: { ok: true, link: 'https://checkout.flutterwave.com/v3/hosted/pay/abc' },
      noBranches: ['Ghana/MTN', 'Ghana/Vodafone', 'Ghana/AirtelTigo'],
    });
    const text = lines.join('\n');

    expect(text).toContain('5 check(s) passed');
    expect(text).toContain('Hosted checkout: initialised');
    expect(text).toContain('No branches (expected, not a failure): Ghana/MTN');
    expect(text).toContain('Unexpected failures: none');
    expect(exitCode).toBe(0);
  });

  it('exits non-zero only on an UNEXPECTED failure', () => {
    // Three telcos with no branches must not colour the run red.
    expect(summarise({ passed: 5, noBranches: ['a', 'b', 'c'] }).exitCode).toBe(0);
    expect(summarise({ passed: 5, failed: 1 }).exitCode).toBe(1);
  });

  it('says so when the checkout failed', () => {
    const { lines, exitCode } = summarise({
      passed: 3,
      failed: 1,
      checkout: { ok: false, detail: 'One or more required parameters missing' },
    });
    expect(lines.join('\n')).toContain('Hosted checkout: FAILED');
    expect(exitCode).toBe(1);
  });
});
