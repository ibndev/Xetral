import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE STORED PIN IS FORGOTTEN EVERYWHERE IT STOPS BEING TRUE.
 *
 * Biometric unlock keeps the customer's REAL transaction PIN in the Keychain
 * and sends it as if it had been typed — the server is unchanged and accepts
 * no "passed Face ID" in its place. That design has one consequence nobody had
 * written down: the stored copy has to be dropped the moment it can be wrong,
 * and `forget()` had exactly ONE caller.
 *
 * TWO BUGS FROM ONE MISSING CALL:
 *
 *   SIGNING OUT left it. The sign-out function's own comment said it forgot
 *   the PIN behind the biometric gate; it did not. `signOut()` clears tokens
 *   and `resetXetral()` resets the singleton, and neither touches SecureStore
 *   — so a face on this phone still unlocked the transaction PIN of an account
 *   nobody was signed in to, which is precisely the case a customer handing
 *   over their device is guarding against.
 *
 *   CHANGING THE PIN left it. That one presents as "it says my PIN is
 *   incorrect when I entered the correct one": every biometric-authorised
 *   action afterwards sends the OLD PIN, the server correctly refuses it, and
 *   the customer used Face ID and has no way to see what was sent for them.
 *
 * Neither is visible to the compiler or to a unit test of either function,
 * because in both cases the code that runs is correct — it is the code that
 * does NOT run that is the fault. So this reads the screens as text and asks
 * whether the call is there.
 */

const HERE = new URL('.', import.meta.url).pathname;
const SETTINGS = join(HERE, '..', 'app', 'settings.tsx');
const SECURITY = join(HERE, '..', 'app', 'security.tsx');

/** Comments stripped, so a paragraph ABOUT forgetting the PIN cannot stand in
 *  for forgetting it — which is the exact shape of the bug: the sign-out
 *  comment claimed the behaviour the code was missing. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The body of the first function whose declaration matches, braces balanced. */
function functionBody(source: string, declaration: RegExp): string {
  const at = source.search(declaration);
  expect(at, `no function matching ${String(declaration)}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const start = source.indexOf('{', at);
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function');
}

describe('the PIN behind the biometric gate', () => {
  it('is forgotten when the customer signs out', () => {
    const body = functionBody(code(SETTINGS), /async function signOut\s*\(/);
    expect(
      /forget\s*\(/.test(body),
      'signing out must call forget(): a face on this phone would otherwise ' +
        'still unlock the transaction PIN of an account nobody is signed in to',
    ).toBe(true);
  });

  it('is forgotten when the customer CHANGES their PIN', () => {
    // The stored copy is stale the instant the server accepts a new one, and a
    // stale copy is worse than none: it is sent silently and refused, which
    // reads to the customer as the app rejecting the PIN they just chose.
    const source = code(SETTINGS);
    const at = source.indexOf('setPin(');
    expect(at, 'nothing in settings sets a PIN').toBeGreaterThanOrEqual(0);
    // Within the same handler — the next few statements, not merely somewhere
    // in the file, which the sign-out call would satisfy on its own.
    expect(
      /forget\s*\(/.test(source.slice(at, at + 400)),
      'changing the PIN must call forget(): otherwise Face ID keeps sending ' +
        'the OLD PIN and every action answers "That PIN is not right"',
    ).toBe(true);
  });

  it('is still forgotten when biometrics are turned off', () => {
    // The original and only caller. Kept under test so a refactor cannot move
    // the other two in and take this one out.
    expect(/forget\s*\(/.test(code(SECURITY))).toBe(true);
  });
});
