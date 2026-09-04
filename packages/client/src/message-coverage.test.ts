import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { knownErrorCodes } from './errors.js';
import { messageFor } from './messages.js';
import { ApiError } from './errors.js';

/**
 * EVERY CODE THE API CAN SEND HAS WORDS OF ITS OWN.
 *
 * THE FAILURE THIS EXISTS FOR, and it is the one that cost the most time in
 * this project's history — not because it was hard, but because it made every
 * OTHER failure unreadable.
 *
 * `messageFor` is a switch with a `default` that returns "Something went
 * wrong. Please try again." A code with no `case` therefore does not fail to
 * compile, does not fail a test, and does not look wrong in review: it renders
 * a sentence that is grammatical, reassuring and completely uninformative.
 *
 * The concrete instance: an administrator pressed Approve on an identity
 * submission, with a correct PIN and a correct authenticator code, and was
 * told something had gone wrong. The API was answering
 * `403 cannot_review_own_submission` — a CORRECT refusal, enforced by a CHECK
 * on the table, because a reviewer may not approve their own documents. That
 * code had no `case`. So the one message that would have ended the confusion
 * in one second ("you cannot review your own submission") was replaced by the
 * one sentence that guarantees somebody goes looking for a bug in the code.
 *
 * `error-codes.test.ts` already checks the API and the client's UNION agree.
 * This is the other half: the union and the SENTENCES. A code can be in the
 * union, typecheck everywhere, and still say nothing.
 *
 * Adding a code now means writing what a person should read, which is the
 * point at which somebody has to think about it.
 */

/** Codes that legitimately share the generic sentence, each with a reason.
 *
 *  Deliberately tiny, and every entry has to be a failure where "something
 *  went wrong" is the WHOLE truth — not one where nobody got round to the
 *  wording. */
const GENERIC_IS_CORRECT: ReadonlySet<string> = new Set([
  // The filter's answer when something threw that nothing expected. There is
  // by definition nothing more specific to say, and the reference the API now
  // attaches is what makes it reportable.
  'internal_error',
]);

const SOURCE = readFileSync(new URL('./messages.ts', import.meta.url), 'utf8');

describe('every API error code says something a person can act on', () => {
  it('has a case in messageFor', () => {
    const missing = knownErrorCodes().filter(
      (code) => !GENERIC_IS_CORRECT.has(code) && !SOURCE.includes(`case '${code}':`),
    );
    expect(missing).toEqual([]);
  });

  it('and that case does not render the generic sentence', () => {
    // The stronger check, and the one a `case` alone cannot make: a case that
    // falls through to a neighbour, or was written to return the same words,
    // passes the test above and fails a customer.
    const generic = knownErrorCodes()
      .filter((code) => !GENERIC_IS_CORRECT.has(code))
      .filter((code) => messageFor(new ApiError(code, 400)).startsWith('Something went wrong'));
    expect(generic).toEqual([]);
  });

  it('appends the reference when the API sent one, and only then', () => {
    // A 4xx names itself and gets no reference — a wrong PIN is not a mystery
    // anybody needs six characters to look up.
    expect(messageFor(new ApiError('invalid_pin', 400))).not.toContain('reference');
    expect(messageFor(new ApiError('internal_error', 500, [], undefined, 'a1b2c3'))).toContain(
      'reference a1b2c3',
    );
  });
});
