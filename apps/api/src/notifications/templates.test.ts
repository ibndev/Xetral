import { describe, expect, it } from 'vitest';
import { classOf, escapeHtml, groupDigits, render } from './templates.js';
import type { NotificationKind, NotificationRequest } from './templates.js';

const ALL_KINDS: readonly NotificationKind[] = [
  'password_reset',
  'password_changed',
  'new_device',
  'devices_revoked',
  'deposit_credited',
  'transfer_sent',
  'crypto_withdrawal_sent',
  'card_frozen',
  'transfer_blocked',
  'operations_alert',
];

/** One representative request per kind, so a template cannot be added without
 *  the escaping and shape assertions below covering it. */
function example(kind: NotificationKind, injected: string): NotificationRequest {
  switch (kind) {
    case 'password_reset':
      return { kind, resetUrl: `https://app.xetral.test/reset?t=${injected}`, expiresInMinutes: 30 };
    case 'password_changed':
      return { kind, at: injected };
    case 'new_device':
      return { kind, platform: injected, at: '2026-08-25 10:00 WAT', ipAddress: injected };
    case 'devices_revoked':
      return { kind, count: 3, at: injected };
    case 'deposit_credited':
      return { kind, amount: '10,000.00', currency: 'NGN', reference: injected };
    case 'transfer_sent':
      return { kind, amount: '5,000.00', currency: 'NGN', reference: injected };
    case 'crypto_withdrawal_sent':
      return { kind, amount: '25.00', asset: 'USDT', address: injected, network: 'tron' };
    case 'card_frozen':
      return { kind, last4: '4242', reason: injected };
    // No injected value: this template deliberately carries NO
    // outside-controlled text — not the amount, not the recipient — so a
    // stolen session cannot use our own alerting to confirm what it attempted.
    case 'transfer_blocked':
      return { kind, reason: 'too_many_new_recipients' };
    case 'operations_alert':
      return {
        kind,
        headline: injected,
        detail: injected,
        occurrences: '12',
        severity: 'error',
        fingerprint: 'abcdef0123456789',
      };
  }
}

describe('escaping', () => {
  it('neutralises the characters that close a tag or an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    // Ampersand first, or every other replacement gets double-encoded.
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml(`it's`)).toBe('it&#39;s');
  });

  it('escapes interpolated values in EVERY template', () => {
    // The real risk. A device platform string, a transfer reference and a
    // withdrawal address all originate outside this codebase, and an
    // unescaped one is a script tag in a message the customer has every
    // reason to trust. Asserted per kind rather than on a sample, so a
    // template added later cannot quietly opt out.
    const payload = `"><script>alert(1)</script>`;

    for (const kind of ALL_KINDS) {
      const { html } = render(example(kind, payload));
      expect(html, `${kind} rendered a live script tag`).not.toContain('<script>');
      // The payload must not survive verbatim anywhere. Asserting on a generic
      // fragment like `"><` instead would match the shell's OWN markup — the
      // literal `...;"><p style=` between two cells — and fail on correctly
      // escaped output, which is what the first version of this test did.
      expect(html, `${kind} passed the payload through unescaped`).not.toContain(payload);
    }
  });

  it('still escapes when the value lands inside an href', () => {
    // The one position where escaping the text is not enough on its own: a
    // quote inside an attribute value ends the attribute.
    const { html } = render({
      kind: 'password_reset',
      resetUrl: `https://app.xetral.test/reset?t=a"onmouseover="alert(1)`,
      expiresInMinutes: 30,
    });
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('&quot;onmouseover=&quot;');
  });
});

describe('every kind renders something sendable', () => {
  it.each(ALL_KINDS)('%s', (kind) => {
    const { subject, text, html } = render(example(kind, 'value'));
    expect(subject.length).toBeGreaterThan(0);
    // Both parts, always. A security email that arrives blank in a text-only
    // client is a customer who cannot get back into their account.
    expect(text.length).toBeGreaterThan(0);
    expect(html).toContain('<html>');
    expect(html).toContain('Xetral');
  });

  it('classifies each kind, with no kind left unclassified', () => {
    // The class decides how hard the worker tries and whether a failure is
    // escalated, so an unclassified kind would silently get the weaker
    // treatment.
    for (const kind of ALL_KINDS) {
      expect(['security', 'transactional']).toContain(classOf(kind));
    }
    expect(classOf('password_reset')).toBe('security');
    expect(classOf('deposit_credited')).toBe('transactional');
  });
});

describe('what the templates deliberately do NOT say', () => {
  it('a receipt does not carry a balance', () => {
    // An email is forwarded, screenshotted and read on a lock screen. What a
    // customer just did is useful; what they are worth is a liability.
    const { text, html } = render({
      kind: 'deposit_credited',
      amount: '10,000.00',
      currency: 'NGN',
      reference: 'dep-1',
    });
    expect(`${text}${html}`.toLowerCase()).not.toContain('balance');
  });

  it('a reset email does not tell the reader to change their password', () => {
    // Telling somebody to change their password inside an email they did not
    // request is how a phishing reflex gets trained. The reset template says
    // the opposite: ignore this and nothing has changed.
    const { text } = render({
      kind: 'password_reset',
      resetUrl: 'https://app.xetral.test/reset?t=abc',
      expiresInMinutes: 30,
    });
    expect(text).toContain('your password has not changed');
  });
});

describe('grouping digits without a float', () => {
  it('groups in threes and changes no digit', () => {
    expect(groupDigits('1234.56')).toBe('1,234.56');
    expect(groupDigits('1000000.00')).toBe('1,000,000.00');
    expect(groupDigits('999.99')).toBe('999.99');
    expect(groupDigits('-2500.00')).toBe('-2,500.00');
    expect(groupDigits('0.00000001')).toBe('0.00000001');
  });

  it('keeps every digit of a value a float would round', () => {
    // Past MAX_SAFE_INTEGER. Any implementation that went through a number
    // would lose the tail here — in the digits a customer reads to decide
    // whether they have been paid the right amount.
    const huge = '9007199254740993.01';
    expect(groupDigits(huge)).toBe('9,007,199,254,740,993.01');
    expect(groupDigits(huge).replace(/,/g, '')).toBe(huge);
  });

  it('returns anything it does not recognise untouched', () => {
    // Rendering runs on a message that has already been decided on. A
    // formatting nicety must never be the reason a security email fails.
    expect(groupDigits('not-a-number')).toBe('not-a-number');
    expect(groupDigits('')).toBe('');
  });

  it('reaches the money templates', () => {
    const { subject } = render({
      kind: 'transfer_sent',
      amount: '1234567.89',
      currency: 'NGN',
      reference: 'r1',
    });
    expect(subject).toBe('You sent NGN 1,234,567.89');
  });
});
