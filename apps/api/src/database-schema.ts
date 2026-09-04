import { Logger } from '@nestjs/common';

/**
 * A SCHEMA THAT IS BEHIND THE CODE, NAMED RATHER THAN THROWN.
 *
 * THE FAILURE THIS EXISTS FOR. Migration 044 adds `virtual_accounts.provider`
 * and `provider_customer_ref`; the account-issuance INSERT writes both. On a
 * deployment where the code rolled out and that migration did not, Postgres
 * answers `column "provider" of relation "virtual_accounts" does not exist`,
 * nothing catches it, Nest answers a bare 500, and the customer reads
 * "something went wrong" on the screen they opened in order to put money in.
 *
 * From the outside that is indistinguishable from a wrong Paystack key, an
 * unapproved integration, or a provider outage — so an operator can spend a
 * day on the provider dashboard while the answer is one `psql -f` away. The
 * error already carries everything needed to say so: Postgres reports
 * `42703` with the column and the relation in the message.
 *
 * This does not repair anything and deliberately cannot. It turns one
 * unreadable failure into a sentence naming the file to apply.
 */

/** `undefined_column` and `undefined_table`. A schema older than the code. */
const MISSING_SCHEMA = new Set(['42703', '42P01']);

/**
 * Which migration introduced what, for the columns a running deployment can
 * actually be missing.
 *
 * Deliberately NOT derived by scanning the SQL directory: a lookup built at
 * runtime from files that ship beside the bundle would report whatever the
 * bundle happens to carry, which is the thing already in doubt. A short
 * written list is checked by `database-schema.test.ts` against the migrations
 * themselves, so it cannot quietly describe a schema that does not exist.
 */
const INTRODUCED_BY: Readonly<Record<string, string>> = {
  'virtual_accounts.provider': '044_paystack_funding.sql',
  'virtual_accounts.provider_customer_ref': '044_paystack_funding.sql',
  'cards.colour': '045_card_fee_split.sql',
  'bank_payouts.provider': '046_payout_provider.sql',
  'countries.payout_method': '046_payout_provider.sql',
};

export function isMissingSchema(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    MISSING_SCHEMA.has((error as { code: string }).code)
  );
}

/**
 * Logs what is missing and which file adds it.
 *
 * The message goes to the LOG, never to the customer: it names our tables.
 * The caller translates to whatever code its own clients understand.
 */
export function reportMissingSchema(logger: Logger, error: unknown, during: string): void {
  const message = error instanceof Error ? error.message : String(error);

  const named = Object.keys(INTRODUCED_BY).find((column) => {
    const [table, field] = column.split('.');
    return (
      field !== undefined &&
      table !== undefined &&
      message.includes(`"${field}"`) &&
      message.includes(table)
    );
  });

  const file = named === undefined ? undefined : INTRODUCED_BY[named];

  logger.error(
    `THE DATABASE SCHEMA IS BEHIND THIS BUILD, and that is why ${during} failed: ` +
      `${message}. ` +
      (file === undefined
        ? 'Apply the outstanding migrations from packages/ledger/sql in order.'
        : `Apply packages/ledger/sql/${file} — it adds ${named}.`) +
      ' Nothing is wrong with the provider or the credential; this request never ' +
      'reached them.',
  );
}
