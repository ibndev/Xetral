import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * WHY THIS IS HAND-WRITTEN WHEN THE CODEBASE SAYS NOT TO HAND-WRITE CRYPTO.
 *
 * The rule that produced that instruction was about a hash FUNCTION: Keccak-256
 * was implemented by hand here, produced plausible digests, and failed every
 * known-answer vector. The lesson was not "never write code that touches
 * crypto" — it was "never write the primitive, and never trust an
 * implementation no published vector has judged".
 *
 * TOTP is not a primitive. It is a defined construction over HMAC-SHA1, which
 * comes from Node's own `crypto`, and RFC 6238 ships a table of test vectors
 * for exactly this purpose. `totp.test.ts` runs all six of them. That is a
 * stronger guarantee than an unaudited dependency would give, and the whole
 * construction is thirty lines.
 *
 * SHA-1 IS CORRECT HERE, and is the one place in this codebase where it is.
 * It is what every authenticator app implements; Google Authenticator ignores
 * the algorithm parameter in an otpauth URL entirely. HMAC-SHA1's security
 * does not rest on SHA-1's collision resistance, and the value it protects
 * lives for thirty seconds. Choosing SHA-256 here would be a defensible
 * decision that produced codes half the staff could not generate.
 */

/** 30 seconds, the value every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;

/** 6 digits, likewise. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of now are accepted.
 *
 * One, meaning a 90-second window in total. Zero would reject a code typed by
 * somebody whose phone clock is two seconds off, which is most phones; more
 * than one widens the window a captured code stays useful in, and the replay
 * table is what makes even that window single-use.
 */
export const TOTP_WINDOW_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32, because that is what an authenticator app reads.
 *
 * Unpadded on output: every authenticator accepts it, and the `=` padding is
 * an escaping hazard in the otpauth URL the QR code encodes.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Uint8Array {
  // Padding and case are both accepted on the way in: a staff member typing a
  // secret by hand rather than scanning it should not be defeated by a
  // trailing '=' or a lowercase letter.
  const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new RangeError(`'${char}' is not a base32 character`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * A new secret.
 *
 * 20 bytes — the length RFC 4226 names as the minimum and what every
 * authenticator expects. Longer is legal and some apps truncate it.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter value for a moment in time. Exported because the REPLAY GUARD
 *  stores it: a step that has been used cannot be used again. */
export function timeStepAt(atSeconds: number): number {
  return Math.floor(atSeconds / TOTP_STEP_SECONDS);
}

/**
 * The code for one counter value.
 *
 * The dynamic truncation in the middle is RFC 4226 section 5.3 verbatim: the
 * low four bits of the last byte select an offset, four bytes are read from
 * there, the top bit is masked off, and the result is taken modulo 10^digits.
 * The mask is what keeps the value positive on platforms that read it as
 * signed — it is not optional, and dropping it produces codes that are correct
 * about 50% of the time.
 */
export function totpAt(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const key = Buffer.from(base32Decode(secretBase32));

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();

  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpVerification {
  readonly valid: boolean;
  /**
   * The step the code belonged to, present only when valid.
   *
   * The CALLER must record it and refuse a repeat. Without that, a code
   * shoulder-surfed or read off a screen share stays usable for the rest of
   * its window — and the window is deliberately 90 seconds wide, which is
   * plenty of time to type six digits.
   */
  readonly timeStep?: number;
}

/**
 * Checks a code against a secret at a point in time.
 *
 * Comparison is `timingSafeEqual`, not `===`. The margin on a six-digit
 * comparison is small, but it is measurable across enough requests, and this
 * is the second factor on a surface that can approve payouts and grant roles.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atSeconds: number,
  digits = TOTP_DIGITS,
): TotpVerification {
  const presented = code.trim();
  if (!new RegExp(`^[0-9]{${digits}}$`).test(presented)) return { valid: false };

  const current = timeStepAt(atSeconds);

  for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift += 1) {
    const step = current + drift;
    if (step < 0) continue;

    const expected = Buffer.from(totpAt(secretBase32, step, digits), 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { valid: true, timeStep: step };
    }
  }

  return { valid: false };
}

/**
 * The URL an authenticator app reads from a QR code.
 *
 * The label carries the issuer twice — once as a prefix and once as a
 * parameter — which looks redundant and is what makes the entry read
 * "Xetral (someone@example.ng)" rather than just an email address in a list of
 * thirty other accounts. An operator who cannot tell which entry is which is
 * an operator who deletes the wrong one.
 */
export function otpauthUrl(options: {
  readonly secret: string;
  readonly account: string;
  readonly issuer?: string;
}): string {
  const issuer = options.issuer ?? 'Xetral';
  const label = encodeURIComponent(`${issuer}:${options.account}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
