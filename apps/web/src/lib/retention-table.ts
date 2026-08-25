/**
 * What we keep, and for how long — as the privacy notice states it.
 *
 * THIS FILE EXISTS SO THE POLICY CANNOT DRIFT FROM THE CODE. A privacy notice
 * is normally written once, by copying a template, and is then a description
 * of what somebody intended rather than of what the system does. The gap opens
 * silently: a retention period is tightened during an incident, or a table is
 * added, and the published page still says what it said in 2026.
 *
 * `retention-table.test.ts` reads `packages/ledger/sql/019_retention.sql` and
 * fails the build if any period here disagrees with the setting the sweep
 * actually reads. So the page is a rendering of the schema, and changing what
 * we keep means changing what we say.
 */
export interface RetentionRow {
  /** What a customer would call it, not what the table is called. */
  readonly what: string;
  /** The `platform_settings` key the sweep reads, or undefined when the answer
   *  is "for as long as you are a customer, and five years after". */
  readonly settingKey?: string;
  readonly period: string;
  readonly why: string;
}

export const RETENTION_ROWS: readonly RetentionRow[] = [
  {
    what: 'Your account, transactions and balances',
    period: 'While you are a customer, and five years after',
    why:
      'Nigerian anti-money-laundering rules require records of a customer ' +
      'relationship to be kept for five years after it ends. Your ledger is ' +
      'also the only record of what we owe you, so it is never deleted.',
  },
  {
    what: 'Your identity documents',
    period: 'While you are a customer, and five years after',
    why:
      'The same rule. Deleting them while you still bank with us would ' +
      'destroy the proof that you were ever verified, and every card and ' +
      'account number depends on it.',
  },
  {
    what: 'Sign-in sessions and devices',
    period: 'While you are a customer',
    why:
      'So you can see which devices are signed in and sign out the ones you ' +
      'do not recognise. This is the screen you would use if somebody else ' +
      'got into your account.',
  },
  {
    what: 'Expired sign-in and password reset tokens',
    settingKey: 'retention_tokens_days',
    period: '90 days',
    why:
      'These are one-way hashes of credentials that no longer work. Kept ' +
      'briefly so a security incident can be investigated, then deleted.',
  },
  {
    what: 'Emails we sent you',
    settingKey: 'retention_notifications_days',
    period: '180 days',
    why:
      'The contents are erased the moment a message is delivered — a password ' +
      'reset email contains a live link, and the safest place for a spent one ' +
      'is nowhere. What remains is that we wrote to you on a given day.',
  },
  {
    what: 'Declined card payments',
    settingKey: 'retention_card_declines_days',
    period: '365 days',
    why:
      'Used to spot fraud on your card. It is also a record of where you ' +
      'shop, which is why it does not stay longer.',
  },
  {
    what: 'Technical error records',
    settingKey: 'retention_error_events_days',
    period: '180 days',
    why:
      'What broke, not who it happened to: the address of the page rather ' +
      'than your identity. Kept until the fault is fixed, then deleted.',
  },
  {
    what: 'A record of when card details were shown',
    period: 'Kept',
    why:
      'That a card number was revealed, and to whom — never the number ' +
      'itself, which we do not store at all. This record is deliberately ' +
      'permanent: a log that a scheduled job can delete from is one an ' +
      'intruder can prune.',
  },
];
