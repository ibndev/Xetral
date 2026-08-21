/**
 * Redaction for anything on its way to a log, an error report or a support
 * screen.
 *
 * THE NON-OBVIOUS RULE: identifiers and secrets are redacted DIFFERENTLY.
 *
 * Showing the last four digits of a card is standard and useful — a customer
 * recognises their own card, and four digits out of sixteen is not enough to
 * reconstruct the rest. Applying the same instinct to a secret is a mistake
 * that looks identical in code review: the first eight characters of a token
 * are not "a harmless preview", they are eight characters an attacker no
 * longer has to guess, and they are usually enough to correlate a log line
 * with a session.
 *
 * So identifiers keep a tail. Secrets are replaced whole, always.
 */

const REDACTED = '[redacted]';

/** Keys whose VALUES are secrets. Matched case-insensitively, and by substring,
 *  so `x-refresh-token` and `providerApiKey` are both caught. */
const SECRET_KEY_PATTERNS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'auth',
  'apikey', 'api_key', 'privatekey', 'private_key', 'signature',
  'pin', 'otp', 'cvv', 'cvc', 'webhook_secret', 'client_secret',
];

/**
 * Keys whose values are sensitive identifiers: redacted, but keep a tail.
 *
 * The tail length is per-pattern rather than one constant, so the scrubber
 * agrees with the named helpers below. A national identifier gets a shorter
 * tail than a card, because a card can be reissued after a leak and a BVN
 * cannot.
 */
const IDENTIFIER_KEY_PATTERNS: readonly (readonly [pattern: string, visible: number])[] = [
  ['pan', 4],
  ['card_number', 4],
  ['cardnumber', 4],
  ['account_number', 4],
  ['bvn', 3],
  ['nin', 3],
];

function normalise(key: string): string {
  return key.toLowerCase().replace(/[-\s]/g, '_');
}

function matches(key: string, patterns: readonly string[]): boolean {
  const normalised = normalise(key);
  return patterns.some((p) => normalised.includes(p));
}

/** The tail length for an identifier key, or undefined if it is not one. */
function identifierTail(key: string): number | undefined {
  const normalised = normalise(key);
  for (const [pattern, visible] of IDENTIFIER_KEY_PATTERNS) {
    if (normalised.includes(pattern)) return visible;
  }
  return undefined;
}

/**
 * Keeps the last `visible` characters. Returns a fully masked value when the
 * input is too short for a tail to be safe — a 5-digit value showing its last
 * 4 is not redacted, it is printed.
 */
function keepTail(value: string, visible: number): string {
  const digits = value.replace(/\s|-/g, '');
  if (digits.length <= visible * 2) return '*'.repeat(Math.max(digits.length, 1));
  return `${'*'.repeat(digits.length - visible)}${digits.slice(-visible)}`;
}

/** A card number, keeping the last four. Never log the unredacted form. */
export function redactPan(pan: string): string {
  return keepTail(pan, 4);
}

/** A Nigerian BVN is 11 digits and is a lifelong national identifier — it
 *  cannot be reissued after a leak the way a card can. Keeps only three. */
export function redactBvn(bvn: string): string {
  return keepTail(bvn, 3);
}

/**
 * Any secret: token, key, PIN, password, provider credential.
 *
 * Takes no `visible` parameter, and that omission is the design. A caller who
 * could ask for four visible characters eventually would.
 */
export function redactSecret(_value: string): string {
  return REDACTED;
}

/**
 * Recursively scrubs a structure before it is logged.
 *
 * Depth-limited and cycle-safe because this runs on the error path, where the
 * input is whatever a provider sent and a stack overflow inside the logger
 * would replace a useful error with a useless one.
 */
export function redactPayload(value: unknown, maxDepth = 8): unknown {
  return scrub(value, maxDepth, new WeakSet<object>());
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth <= 0) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Secrets are checked FIRST. A key like `card_number_token` matches both
    // lists, and the safe reading of an ambiguous key is the stricter one.
    if (matches(key, SECRET_KEY_PATTERNS)) {
      out[key] = REDACTED;
      continue;
    }

    const visible = identifierTail(key);
    if (visible !== undefined) {
      out[key] = typeof item === 'string' ? keepTail(item, visible) : REDACTED;
    } else {
      out[key] = scrub(item, depth - 1, seen);
    }
  }
  return out;
}
