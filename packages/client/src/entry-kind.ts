import type { IconName } from './icons.js';
/**
 * What an entry kind is called, in a customer's words.
 *
 * THE COMP PUTS A DESCRIPTOR UNDER EVERY ACTIVITY ROW — "Xetral · received",
 * "Airtime · ···4021", "Bank · GTBank ···8842" — and the row's own
 * description is the counterparty above it. Without one the sub line carried
 * the TIME, which the comp puts on the right under the amount, so the row was
 * two columns where the design has three pieces of information.
 *
 * IT IS DERIVED FROM `kind`, WHICH IS THE ENTRY'S OWN, and never from the
 * description. The description is written by whichever flow posted the entry
 * and is free text; `kind` is a Postgres enum with twenty-two members, so a
 * label built from it is a label that cannot describe an entry as something
 * it is not. `entry-kind.test.ts` reads the enum out of `001_ledger.sql` and
 * fails the build on a member with no label — which is how a kind added in a
 * later migration stops silently rendering as a raw identifier with an
 * underscore in it on the screen every customer opens.
 *
 * IT SAYS WHAT HAPPENED, NOT WHICH DIRECTION. "received" and "sent" are the
 * sign of the amount, which the row already shows in red or green and with a
 * minus — repeating it here would be a third copy of one fact, and the copy
 * that drifts is the one nobody is looking at.
 *
 * ONE TABLE FOR BOTH APPS, because two copies of "what a customer calls this"
 * drift, and the copy that drifts is the one a customer reads while deciding
 * whether they recognise a transaction.
 */
const LABELS: Readonly<Record<string, string>> = {
  wallet_funding: 'Money in',
  wallet_transfer: 'Xetral transfer',
  wallet_withdrawal: 'Bank transfer',
  card_creation: 'New card',
  card_funding: 'Card top-up',
  card_authorization: 'Card hold',
  card_settlement: 'Card payment',
  card_auth_expiry: 'Hold released',
  card_refund: 'Card refund',
  card_termination: 'Card closed',
  fx_trade: 'Currency exchange',
  bill_payment: 'Bill payment',
  esim_purchase: 'eSIM',
  number_purchase: 'Phone number',
  crypto_deposit: 'Crypto in',
  crypto_withdrawal: 'Crypto out',
  fee: 'Fee',

  reversal: 'Reversed',
  adjustment: 'Adjustment',
  giftcard_purchase: 'Gift card',
  giftcard_hold_release: 'Gift card released',
  dispute_refund: 'Dispute refund',
};

/**
 * The label, or the kind tidied up.
 *
 * THE FALLBACK IS NOT A BLANK AND NOT THE RAW STRING. A kind this table has
 * not been told about renders with its underscores turned into spaces and its
 * first letter capitalised — readable, obviously provisional, and never an
 * empty line where a descriptor belongs. The build failing is what fixes it
 * properly; this is what a customer sees in the window before somebody does.
 */
export function entryKindLabel(kind: string): string {
  const known = LABELS[kind];
  if (known !== undefined) return known;
  const tidied = kind.replace(/_/g, ' ').trim();
  if (tidied === '') return 'Transaction';
  return tidied.charAt(0).toUpperCase() + tidied.slice(1);
}

/**
 * THE TITLE OF A ROW A CUSTOMER READS, from the entry's own description.
 *
 * Entries are append-only, so descriptions written before anybody chose
 * words stay as they were: every early card top-up reads "card funding" —
 * the entry KIND in lowercase — beside provider rows reading "Netflix". A
 * description that is only its kind is a label nobody wrote, so the kind's
 * label is shown instead; any other description is shown with a capital, as
 * "transfer to ***9999" is a sentence that starts a row.
 *
 * One function for both apps: two copies of "what a row is called" drift,
 * and the copy that drifts is the one on the screen a customer screenshots.
 */
export function entryTitle(description: string, kind: string): string {
  const said = description.trim();
  if (said === '' || said.toLowerCase() === kind.replace(/_/g, ' ').toLowerCase()) {
    return entryKindLabel(kind);
  }
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/** Every kind this table names. Read by the guard, never by a screen. */
export const ENTRY_KIND_LABELS = LABELS;

/**
 * THE MARK A ROW WEARS — an icon and a tone per entry kind, one table for
 * both apps.
 *
 * Every row drew the same grey arrow, so a card payment, a bill, a currency
 * exchange and a bank transfer were one shape in one colour down the whole
 * Activity screen, and the list read as a column of identical rows the eye
 * had to read word by word. The comp draws what the row IS; this is that,
 * from `kind`, the entry's own closed enum — never from its description.
 *
 * The TONE is category, not direction: whether money came or went is already
 * the amount's colour, and a green icon beside a red amount would say two
 * things at once. Money that arrives is the one exception, because "money in"
 * is the category.
 */
export type EntryTone = 'iris' | 'ok' | 'warn' | 'info' | 'neutral';
export interface EntryMark {
  readonly icon: IconName;
  readonly tone: EntryTone;
}

const MARKS: Readonly<Record<string, EntryMark>> = {
  wallet_funding: { icon: 'download', tone: 'ok' },
  wallet_withdrawal: { icon: 'bank', tone: 'info' },
  card_creation: { icon: 'card', tone: 'iris' },
  card_funding: { icon: 'card', tone: 'iris' },
  card_authorization: { icon: 'card', tone: 'iris' },
  card_settlement: { icon: 'card', tone: 'iris' },
  card_auth_expiry: { icon: 'card', tone: 'iris' },
  card_refund: { icon: 'card', tone: 'ok' },
  card_termination: { icon: 'card', tone: 'neutral' },
  fx_trade: { icon: 'swap', tone: 'info' },
  bill_payment: { icon: 'receipt', tone: 'warn' },
  esim_purchase: { icon: 'sim', tone: 'warn' },
  number_purchase: { icon: 'phone', tone: 'warn' },
  crypto_deposit: { icon: 'bitcoin', tone: 'ok' },
  crypto_withdrawal: { icon: 'bitcoin', tone: 'warn' },
  fee: { icon: 'receipt', tone: 'neutral' },
  reversal: { icon: 'swap', tone: 'neutral' },
  adjustment: { icon: 'info', tone: 'neutral' },
  giftcard_purchase: { icon: 'gift', tone: 'warn' },
  giftcard_hold_release: { icon: 'gift', tone: 'ok' },
  dispute_refund: { icon: 'shield', tone: 'ok' },
};

export function entryMark(kind: string, outgoing: boolean): EntryMark {
  if (kind === 'wallet_transfer') {
    return outgoing ? { icon: 'send', tone: 'iris' } : { icon: 'download', tone: 'ok' };
  }
  return MARKS[kind] ?? (outgoing ? { icon: 'arrowUpRight', tone: 'neutral' } : { icon: 'download', tone: 'ok' });
}
