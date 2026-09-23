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
