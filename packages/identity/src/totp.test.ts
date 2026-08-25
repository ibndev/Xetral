import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUrl,
  timeStepAt,
  totpAt,
  verifyTotp,
} from './totp.js';

/**
 * RFC 6238 Appendix B, the SHA-1 rows.
 *
 * THIS IS THE TEST THAT MATTERS. The reason there is a hand-written TOTP in
 * this codebase at all is that the construction is published WITH vectors, so
 * "it produces plausible six-digit codes" can be replaced by "it produces the
 * codes the specification says". The last hand-written primitive here — a
 * Keccak-256 — produced entirely plausible digests and failed every vector it
 * was eventually shown.
 *
 * The seed is the ASCII string "12345678901234567890"; the RFC prints it as
 * hex, and base32 is what this implementation takes.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

const RFC_VECTORS: readonly { time: number; code: string }[] = [
  { time: 59, code: '94287082' },
  { time: 1_111_111_109, code: '07081804' },
  { time: 1_111_111_111, code: '14050471' },
  { time: 1_234_567_890, code: '89005924' },
  { time: 2_000_000_000, code: '69279037' },
  { time: 20_000_000_000, code: '65353130' },
];

describe('RFC 6238 test vectors', () => {
  it.each(RFC_VECTORS)('T=$time produces $code', ({ time, code }) => {
    expect(totpAt(RFC_SECRET, timeStepAt(time), 8)).toBe(code);
  });

  it('verifies each vector at its own moment', () => {
    for (const { time, code } of RFC_VECTORS) {
      expect(verifyTotp(RFC_SECRET, code, time, 8).valid, `T=${time}`).toBe(true);
    }
  });
});

describe('base32', () => {
  it('round-trips', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255, 42, 17]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('matches RFC 4648 examples', () => {
    expect(base32Encode(Buffer.from('f', 'ascii'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo', 'ascii'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foo', 'ascii'))).toBe('MZXW6');
    expect(base32Encode(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
  });

  it('accepts padding, whitespace and lower case on the way in', () => {
    // A staff member typing a secret by hand rather than scanning it should
    // not be defeated by a trailing '=' or a space.
    const canonical = base32Decode('MZXW6YTBOI');
    expect(base32Decode('mzxw6ytboi')).toEqual(canonical);
    expect(base32Decode('MZXW 6YTB OI')).toEqual(canonical);
    expect(base32Decode('MZXW6YTBOI======')).toEqual(canonical);
  });

  it('refuses a character that is not base32', () => {
    // '1', '8' and '0' are excluded from the alphabet precisely because they
    // are misread as I, B and O. Accepting them silently would decode to the
    // wrong secret and produce codes that never match, presenting as "my
    // authenticator is broken".
    expect(() => base32Decode('MZXW6YTB01')).toThrow(RangeError);
  });
});

describe('the acceptance window', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;

  it('accepts the code for this moment', () => {
    expect(verifyTotp(secret, totpAt(secret, timeStepAt(now)), now).valid).toBe(true);
  });

  it('accepts one step either side, for a phone with a drifting clock', () => {
    const before = totpAt(secret, timeStepAt(now) - 1);
    const after = totpAt(secret, timeStepAt(now) + 1);
    expect(verifyTotp(secret, before, now).valid).toBe(true);
    expect(verifyTotp(secret, after, now).valid).toBe(true);
  });

  it('refuses two steps away', () => {
    const stale = totpAt(secret, timeStepAt(now) - 2);
    expect(verifyTotp(secret, stale, now).valid).toBe(false);
  });

  it('reports WHICH step a valid code belonged to', () => {
    // The caller has to record it. Without that, a code read off a screen
    // share stays usable for the rest of a 90-second window — which is ample
    // time to type six digits.
    const step = timeStepAt(now);
    expect(verifyTotp(secret, totpAt(secret, step), now).timeStep).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), now).timeStep).toBe(step - 1);
  });

  it('is exactly 90 seconds wide', () => {
    // Stated as a number rather than left implicit, because it is the window a
    // captured code would be useful in if the replay guard were removed.
    expect((2 * TOTP_WINDOW_STEPS + 1) * TOTP_STEP_SECONDS).toBe(90);
    expect(verifyTotp(secret, totpAt(secret, timeStepAt(now) + 2), now).valid).toBe(false);
  });
});

describe('what it refuses outright', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000;

  it('rejects a wrong-length code without checking anything', () => {
    expect(verifyTotp(secret, '12345', now).valid).toBe(false);
    expect(verifyTotp(secret, '1234567', now).valid).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(verifyTotp(secret, 'abcdef', now).valid).toBe(false);
    expect(verifyTotp(secret, '12 456', now).valid).toBe(false);
  });

  it('rejects an empty code', () => {
    expect(verifyTotp(secret, '', now).valid).toBe(false);
  });

  it('tolerates surrounding whitespace, which is what a paste produces', () => {
    const code = totpAt(secret, timeStepAt(now));
    expect(verifyTotp(secret, `  ${code} `, now).valid).toBe(true);
  });
});

describe('secrets and enrolment', () => {
  it('generates 20 bytes, the length authenticators expect', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('generates a different secret every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(seen.size).toBe(50);
  });

  it('builds an otpauth URL an authenticator can read', () => {
    const url = otpauthUrl({ secret: 'ABCDEFGH', account: 'ops@xetral.com' });
    expect(url.startsWith('otpauth://totp/')).toBe(true);
    // The issuer appears in the label AND as a parameter. That is what makes
    // the entry read "Xetral (ops@xetral.com)" rather than one more bare email
    // address in a list of thirty — and an operator who cannot tell the
    // entries apart is one who deletes the wrong one.
    expect(decodeURIComponent(url)).toContain('Xetral:ops@xetral.com');
    expect(url).toContain('issuer=Xetral');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
});
