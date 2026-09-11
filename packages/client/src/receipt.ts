import type { TransactionDetail } from './client.js';
import { formatAmount } from './money.js';

/**
 * A TRANSACTION, AS TEXT SOMEBODY CAN SEND.
 *
 * ONE FORMATTER FOR BOTH APPS, for the reason every other shared thing here is
 * shared: two copies of "what a receipt says" drift, and the copy that drifts
 * is the one a customer forwards to the person asking whether they were paid.
 *
 * PLAIN TEXT rather than a rendered image or a PDF. It has to survive being
 * pasted into WhatsApp, read on a feature phone and quoted back to support,
 * and each of those is worse with an attachment. It is also the only shape
 * both platforms can share with no new dependency: the web has
 * `navigator.share` with a clipboard fallback, the phone has `Share.share`.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY:
 *
 *  - A BALANCE. A receipt is forwarded to the person who asked to be paid,
 *    and what is left in the account is nobody's business but the customer's.
 *  - THE PROVIDER'S SENTENCE on a failure. It names our integration — 006's
 *    rule — so it belongs on the row an operator reads, never in a message a
 *    customer is encouraged to send to somebody else.
 *  - A FULL ACCOUNT NUMBER when the payout carries one. The last four is what
 *    identifies a destination on every bank statement, and a receipt with the
 *    whole number is a receipt that should not be forwarded at all.
 */
export function receiptText(t: TransactionDetail, appName = 'Xetral'): string {
  const outgoing = t.amount.trim().startsWith('-');
  // The sign is carried by the words, so the figure reads as a figure. A
  // customer forwarding "-5,000.00" to somebody has to explain the minus.
  const magnitude = formatAmount(t.amount.replace(/^-/, ''), t.currency);

  const lines: string[] = [
    `${appName} receipt`,
    '',
    `${outgoing ? 'Sent' : 'Received'}   ${magnitude}`,
  ];

  if (t.beneficiary !== undefined) lines.push(`To        ${t.beneficiary}`);
  if (t.bank_name !== undefined) {
    const tail = t.account_number === undefined ? '' : ` ••${t.account_number.slice(-4)}`;
    lines.push(`Bank      ${t.bank_name}${tail}`);
  }
  if (t.fee !== undefined && !/^0([.,]0+)?$/.test(t.fee)) {
    lines.push(`Fee       ${formatAmount(t.fee, t.currency)}`);
  }

  lines.push(`Status    ${statusWords(t)}`);
  lines.push(`Date      ${new Date(t.occurred_at).toLocaleString()}`);
  lines.push(`Reference ${t.reference}`);

  if (t.narration !== undefined && t.narration !== null && t.narration !== '') {
    lines.push('', t.narration);
  }
  return lines.join('\n');
}

/**
 * What happened, in words a customer can act on.
 *
 * `on_its_way` IS NOT "pending" and is not "failed". It means nobody has
 * answered for this payout yet: the money is held, the sweep will ask, and
 * telling a customer it failed would be a claim about money that may be in
 * somebody's account — the rule 043 records about a timeout settling nothing
 * and reversing nothing.
 *
 * THE ENTRY'S OWN STATUS WINS where it is not `posted`. A reversed or refunded
 * transaction is a stronger statement about what happened than a payout state,
 * and a customer reading "Sent" on money that came back would be reading the
 * wrong one of two true things.
 */
export function statusWords(t: TransactionDetail): string {
  if (t.status === 'reversed') return 'Reversed — the money was returned';
  if (t.status === 'refunded') return 'Refunded';
  if (t.status === 'disputed') return 'Under review';

  switch (t.payout_state) {
    case 'sent':
      return 'Sent';
    case 'returned':
      return 'Returned — the money is back in your wallet';
    case 'on_its_way':
      return 'On its way';
    default:
      return 'Completed';
  }
}
