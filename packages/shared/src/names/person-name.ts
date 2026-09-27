/**
 * WHETHER A STRING IS PLAUSIBLY A PERSON'S NAME.
 *
 * Accounts were being opened as "Other Things" and "Let's Create". A name is
 * printed on a card, sent to Paystack when an account number is opened, shown
 * to whoever is about to pay the customer and greeted on every screen — and a
 * reviewer comparing it with a BVN record has to start from something that is
 * at least trying to be one.
 *
 * WHAT THIS CANNOT DO IS REFUSE ENGLISH WORDS, and that is the whole design
 * constraint. Blessing, Favour, Precious, Goodluck, Patience, Mercy, Gift,
 * Sunday, Wisdom, Peace — a great many Nigerian and Ghanaian names ARE
 * dictionary words, so "is it a word?" would lock real people out of their
 * own money. What is refused instead:
 *
 *   - a word from a short list of words that are NEVER a name — the filler
 *     people type to get past a form ("other", "things", "create", "test");
 *   - the form's own placeholders, "John Doe" and "Jane Doe";
 *   - digits, symbols and emoji — a name carries letters, spaces, hyphens,
 *     apostrophes and full stops, in any script;
 *   - one letter repeated, and fewer than two letters in a part.
 *
 * ONE DEFINITION, used at every path that writes a name — registration, the
 * profile, and a KYC submission — so no path accepts what another refuses.
 * The forms show the refusal as `name_invalid` in words.
 */

/** Words people type to get past a name field, none of which is anybody's name. */
const NEVER_A_NAME = new Set([
  'other', 'others', 'thing', 'things', 'stuff', 'something', 'anything', 'nothing', 'everything',
  'lets', "let's", 'let', 'create', 'created', 'creating', 'make', 'new', 'account', 'accounts',
  'test', 'tests', 'testing', 'tester', 'demo', 'sample', 'example', 'fake', 'dummy', 'temp',
  'user', 'users', 'username', 'admin', 'administrator', 'customer', 'client', 'person',
  'name', 'names', 'firstname', 'lastname', 'surname', 'first', 'last', 'middle', 'full',
  'hello', 'hi', 'hey', 'ok', 'okay', 'yes', 'no', 'none', 'null', 'undefined', 'nil', 'na', 'n/a',
  'the', 'and', 'or', 'for', 'with', 'you', 'your', 'my', 'me', 'mine', 'our', 'this', 'that',
  'xetral', 'paystack', 'flutterwave', 'bank', 'money', 'wallet', 'payment', 'pay', 'send',
  'asdf', 'asdfgh', 'qwerty', 'qwertyuiop', 'zxcv', 'abc', 'abcd', 'xyz', 'lol', 'nil',
  'unknown', 'anonymous', 'someone', 'somebody', 'anybody', 'nobody', 'whatever',
]);

/** The form's own placeholders, typed back as a name. */
const PLACEHOLDERS = new Set(['john doe', 'jane doe']);

export type NameProblem = 'not_a_name';

/**
 * Undefined when the name will do; otherwise why not, as one code. The
 * refusal is deliberately not more specific: telling somebody which word was
 * refused invites them to swap it for the next filler word.
 */
export function personNameProblem(fullName: string): NameProblem | undefined {
  const name = fullName.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 2) return 'not_a_name';
  // Letters in ANY script, and the joiners names really use.
  if (!/^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u.test(name)) return 'not_a_name';
  if (PLACEHOLDERS.has(name.toLowerCase())) return 'not_a_name';

  const parts = name.split(' ').filter((p) => p !== '');
  for (const part of parts) {
    const letters = part.replace(/[^\p{L}]/gu, '');
    if (letters.length < 2) return 'not_a_name';
    if (/^(.)\1+$/u.test(letters.toLowerCase())) return 'not_a_name';
    if (NEVER_A_NAME.has(part.toLowerCase()) || NEVER_A_NAME.has(letters.toLowerCase())) {
      return 'not_a_name';
    }
  }
  return undefined;
}
