/**
 * What each notification actually says.
 *
 * TWO RULES HOLD ACROSS EVERY TEMPLATE HERE, and both are the kind that look
 * like style until they are not.
 *
 * 1. EVERY INTERPOLATED VALUE IS ESCAPED. A device platform string, a transfer
 *    reference, a recipient name — all of them originate outside this codebase,
 *    and an unescaped one in an HTML email is a script tag in a message the
 *    customer has every reason to trust. `escapeHtml` is applied by the `h`
 *    tag below, so the escaping happens as part of writing the template rather
 *    than as a step somebody has to remember.
 *
 * 2. MONEY IS ALREADY A STRING WHEN IT ARRIVES HERE. Same rule as the client:
 *    the amount is formatted at the edge of the ledger and passed through as
 *    text. There is no `number` in any of these payloads, so there is nothing
 *    for a float to round.
 *
 * A note on what is NOT here: none of these templates includes a balance. An
 * email is forwarded, screenshotted and read on a lock screen, and a receipt
 * that says what a customer just did is useful while one that says what they
 * are worth is a liability.
 */

export type NotificationClass = 'security' | 'transactional';

/**
 * Every message the platform can send, and the data it needs.
 *
 * A discriminated union rather than a template name plus a bag of strings: the
 * compiler is the cheapest thing available for catching a receipt rendered
 * with a password reset's fields.
 */
export type NotificationRequest =
  | {
      readonly kind: 'password_reset';
      /** Carries the one-time token. Never logged — see `redaction.ts`. */
      readonly resetUrl: string;
      readonly expiresInMinutes: number;
    }
  | { readonly kind: 'password_changed'; readonly at: string }
  | {
      readonly kind: 'new_device';
      readonly platform: string;
      readonly at: string;
      /** Absent when the request arrived without a usable client address. */
      readonly ipAddress?: string;
    }
  | { readonly kind: 'devices_revoked'; readonly count: number; readonly at: string }
  | {
      readonly kind: 'deposit_credited';
      readonly amount: string;
      readonly currency: string;
      readonly reference: string;
    }
  | {
      readonly kind: 'transfer_sent';
      readonly amount: string;
      readonly currency: string;
      readonly reference: string;
    }
  | {
      readonly kind: 'crypto_withdrawal_sent';
      readonly amount: string;
      readonly asset: string;
      readonly address: string;
      readonly network: string;
    }
  | { readonly kind: 'card_frozen'; readonly last4: string; readonly reason: string }
  /**
   * The one message not addressed to a customer.
   *
   * It goes to the operations address, and it is `security` class so it is
   * retried hardest — an alert about a platform failure that itself fails to
   * send is the worst possible thing for this table to produce.
   */
  | {
      readonly kind: 'operations_alert';
      readonly headline: string;
      readonly detail: string;
      readonly occurrences: string;
      readonly severity: string;
      readonly fingerprint: string;
    };

export type NotificationKind = NotificationRequest['kind'];

/**
 * Which messages are worth waking somebody up over.
 *
 * Security mail is what a customer needs in order to keep control of their
 * account. It is retried longer and its failure is escalated; a receipt that
 * does not arrive is a support ticket, a reset link that does not arrive is a
 * customer locked out of their own money.
 */
const CLASS_OF: Record<NotificationKind, NotificationClass> = {
  password_reset: 'security',
  password_changed: 'security',
  new_device: 'security',
  devices_revoked: 'security',
  deposit_credited: 'transactional',
  transfer_sent: 'transactional',
  crypto_withdrawal_sent: 'transactional',
  card_frozen: 'transactional',
  operations_alert: 'security',
};

/**
 * Every kind, as a value.
 *
 * Derived from `CLASS_OF` rather than written out again, so it cannot fall
 * behind the union: the Record's key type is `NotificationKind`, and the
 * compiler already refuses a missing or misspelled entry there.
 */
export const ALL_NOTIFICATION_KINDS = Object.keys(CLASS_OF) as readonly NotificationKind[];

export function classOf(kind: NotificationKind): NotificationClass {
  return CLASS_OF[kind];
}

export interface RenderedNotification {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Groups the digits of a decimal amount, WITHOUT going through a number.
 *
 * The same rule the client holds to, applied here because a receipt is read by
 * the same person for the same reason. `toMajor` produces "1234567.89", and an
 * email that says "NGN 1234567.89" is one a customer has to count digits in to
 * decide whether they have been overcharged — which is exactly the moment they
 * should not have to.
 *
 * `Intl.NumberFormat` is deliberately not used: it takes a number, and a BTC
 * amount with eight decimals or a large naira figure is precisely where a
 * float starts lying. Nothing here converts to a number, and no digit is
 * changed — only separators are inserted.
 *
 * A value that is not a decimal string is returned UNTOUCHED rather than
 * throwing. This runs while rendering a message that has already been decided
 * on, and a formatting nicety must never be the reason a security email fails
 * to render.
 */
export function groupDigits(amount: string): string {
  const match = /^(-?)([0-9]+)(\.[0-9]+)?$/.exec(amount.trim());
  if (match === null) return amount;

  const [, sign = '', whole = '', fraction = ''] = match;
  let grouped = '';
  for (let i = 0; i < whole.length; i += 1) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ',';
    grouped += whole[i];
  }
  return `${sign}${grouped}${fraction}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tagged template that escapes every hole.
 *
 * The literal parts are ours and are left alone; everything substituted in is
 * escaped. Writing `h\`<p>${platform}</p>\`` is therefore safe by construction,
 * and the unsafe version is the one that needs extra effort to write.
 */
function h(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  return strings.reduce((out, part, i) => {
    if (i === 0) return part;
    return out + escapeHtml(String(values[i - 1])) + part;
  }, '');
}

/**
 * The shell every message is poured into.
 *
 * Table-based and inline-styled on purpose. Email clients are not browsers:
 * Outlook renders through Word, Gmail strips `<style>` blocks, and a flexbox
 * layout that looks right in a browser preview arrives as a stack of unstyled
 * paragraphs. Inline styles on nested tables is the one layout that survives
 * all of them, and this is the rare place where the modern approach is the
 * wrong one.
 */
function shell(title: string, body: string, footer?: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#101114;">
<tr><td style="font-size:18px;font-weight:700;letter-spacing:-0.01em;padding-bottom:20px;">Xetral</td></tr>
<tr><td style="font-size:20px;font-weight:600;line-height:1.3;padding-bottom:14px;">${escapeHtml(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#33363d;">${body}</td></tr>
<tr><td style="padding-top:26px;font-size:12px;line-height:1.5;color:#7c8089;border-top:1px solid #e8e9ec;margin-top:20px;">
${escapeHtml(footer ?? 'You are receiving this because of activity on your Xetral account.')}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const button = (href: string, label: string): string =>
  `<p style="margin:22px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#101114;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600;font-size:15px;">${escapeHtml(label)}</a></p>`;

/** The line every security email ends on. Naming the action a customer should
 *  take is what makes the alert useful; "if this was not you, ignore this
 *  message" is what makes it decorative. */
const SECURITY_FOOTER =
  'If this was not you, change your password and revoke your other devices ' +
  'from Settings immediately.';

export function render(request: NotificationRequest): RenderedNotification {
  switch (request.kind) {
    case 'password_reset':
      return {
        subject: 'Reset your Xetral password',
        text:
          `Use the link below to set a new password. It expires in ` +
          `${request.expiresInMinutes} minutes and can only be used once.\n\n` +
          `${request.resetUrl}\n\n` +
          `If you did not ask to reset your password, you can ignore this email — ` +
          `your password has not changed.`,
        html: shell(
          'Reset your password',
          h`<p style="margin:0 0 8px;">Use the button below to set a new password. It expires in ${request.expiresInMinutes} minutes and can only be used once.</p>` +
            button(request.resetUrl, 'Set a new password') +
            h`<p style="margin:0;font-size:13px;color:#7c8089;">If you did not ask to reset your password, you can ignore this email — your password has not changed.</p>`,
          // Deliberately NOT the standard security footer. Telling somebody to
          // change their password in an email that they did not request a
          // password change for is how a phishing reflex gets trained.
          'Xetral will never ask you for your password, PIN or card details.',
        ),
      };

    case 'password_changed':
      return {
        subject: 'Your Xetral password was changed',
        text:
          `Your password was changed on ${request.at}.\n\n` +
          `Every other device was signed out. ${SECURITY_FOOTER}`,
        html: shell(
          'Your password was changed',
          h`<p style="margin:0 0 8px;">Your password was changed on ${request.at}.</p>` +
            h`<p style="margin:0;">Every other device has been signed out.</p>`,
          SECURITY_FOOTER,
        ),
      };

    case 'new_device':
      return {
        subject: 'New sign-in to your Xetral account',
        text:
          `Your account was signed into from a new device.\n\n` +
          `When: ${request.at}\nDevice: ${request.platform}\n` +
          (request.ipAddress === undefined ? '' : `IP address: ${request.ipAddress}\n`) +
          `\n${SECURITY_FOOTER}`,
        html: shell(
          'New sign-in to your account',
          h`<p style="margin:0 0 12px;">Your account was signed into from a device you have not used before.</p>` +
            `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#33363d;">` +
            h`<tr><td style="padding:3px 16px 3px 0;color:#7c8089;">When</td><td>${request.at}</td></tr>` +
            h`<tr><td style="padding:3px 16px 3px 0;color:#7c8089;">Device</td><td>${request.platform}</td></tr>` +
            (request.ipAddress === undefined
              ? ''
              : h`<tr><td style="padding:3px 16px 3px 0;color:#7c8089;">IP address</td><td>${request.ipAddress}</td></tr>`) +
            `</table>`,
          SECURITY_FOOTER,
        ),
      };

    case 'devices_revoked':
      return {
        subject: 'Your other devices were signed out',
        text:
          `${request.count} other device(s) were signed out of your Xetral account ` +
          `on ${request.at}.\n\n${SECURITY_FOOTER}`,
        html: shell(
          'Your other devices were signed out',
          h`<p style="margin:0;">${request.count} other device(s) were signed out of your account on ${request.at}.</p>`,
          SECURITY_FOOTER,
        ),
      };

    case 'deposit_credited': {
      const amount = `${request.currency} ${groupDigits(request.amount)}`;
      return {
        subject: `You received ${amount}`,
        text:
          `${amount} has been added to your Xetral wallet.\n\n` +
          `Reference: ${request.reference}`,
        html: shell(
          `You received ${amount}`,
          h`<p style="margin:0 0 8px;">${amount} has been added to your wallet.</p>` +
            h`<p style="margin:0;font-size:13px;color:#7c8089;">Reference ${request.reference}</p>`,
        ),
      };
    }

    case 'transfer_sent': {
      const amount = `${request.currency} ${groupDigits(request.amount)}`;
      return {
        subject: `You sent ${amount}`,
        text:
          `${amount} was sent from your Xetral wallet.\n\n` +
          `Reference: ${request.reference}`,
        html: shell(
          `You sent ${amount}`,
          h`<p style="margin:0 0 8px;">${amount} was sent from your wallet.</p>` +
            h`<p style="margin:0;font-size:13px;color:#7c8089;">Reference ${request.reference}</p>`,
        ),
      };
    }

    case 'crypto_withdrawal_sent':
      return {
        subject: `You sent ${groupDigits(request.amount)} ${request.asset}`,
        text:
          `${groupDigits(request.amount)} ${request.asset} was sent on ${request.network}.\n\n` +
          `To: ${request.address}\n\n` +
          `An on-chain transaction cannot be recalled. If you did not make this ` +
          `withdrawal, contact support immediately.`,
        html: shell(
          `You sent ${groupDigits(request.amount)} ${request.asset}`,
          h`<p style="margin:0 0 8px;">${groupDigits(request.amount)} ${request.asset} was sent on ${request.network}.</p>` +
            h`<p style="margin:0;font-size:13px;color:#7c8089;word-break:break-all;">To ${request.address}</p>`,
          'An on-chain transaction cannot be recalled. If you did not make this ' +
            'withdrawal, contact support immediately.',
        ),
      };

    case 'operations_alert':
      return {
        subject: `[Xetral ${request.severity}] ${request.headline}`,
        text:
          `${request.headline}\n\n` +
          `${request.detail}\n\n` +
          `Occurrences: ${request.occurrences}\n` +
          `Fingerprint: ${request.fingerprint}\n\n` +
          `Open the operations dashboard to see the full picture.`,
        html: shell(
          request.headline,
          h`<p style="margin:0 0 12px;">${request.detail}</p>` +
            `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#33363d;">` +
            h`<tr><td style="padding:3px 16px 3px 0;color:#7c8089;">Occurrences</td><td>${request.occurrences}</td></tr>` +
            h`<tr><td style="padding:3px 16px 3px 0;color:#7c8089;">Severity</td><td>${request.severity}</td></tr>` +
            h`<tr><td style="padding:3px 16px 3px 0;color:#7c8089;">Fingerprint</td><td><code>${request.fingerprint}</code></td></tr>` +
            `</table>`,
          'You are receiving this because you are the operations contact for this ' +
            'Xetral deployment.',
        ),
      };

    case 'card_frozen':
      return {
        subject: 'Your Xetral card was frozen',
        text:
          `Your card ending ${request.last4} was frozen: ${request.reason}.\n\n` +
          `No further charges will go through until you unfreeze it in the app.`,
        html: shell(
          'Your card was frozen',
          h`<p style="margin:0 0 8px;">Your card ending ${request.last4} was frozen: ${request.reason}.</p>` +
            `<p style="margin:0;">No further charges will go through until you unfreeze it in the app.</p>`,
        ),
      };
  }
}
