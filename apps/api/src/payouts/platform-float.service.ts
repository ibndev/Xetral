import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Currency, Money } from '@xetral/shared';
import { SettingsService } from '../settings/settings.service.js';

/**
 * CAN THE PLATFORM ITSELF AFFORD THIS PAYOUT?
 *
 * THE QUESTION NOTHING ASKED. Every control in this codebase before now is
 * about the CUSTOMER's money — the overdraft guard, the daily ceiling, the
 * velocity rules. Flutterwave is a PREFUNDED wallet: it debits the balance
 * matching the payout currency, so a cedi payout needs a cedi float, and a
 * deployment that has never collected a cedi has none. The transfer is then
 * refused by Flutterwave with a message about funds, which arrives through
 * the adapter as a failure on a transfer whose customer, amount and account
 * number were all perfectly correct.
 *
 * FROM INSIDE, THAT IS INDISTINGUISHABLE FROM A BAD ACCOUNT NUMBER. It has
 * already cost three rounds of customers in Accra being told their own
 * details could not be found. This refuses first, and says which.
 *
 * WHY IT IS A PRECONDITION AND NOT A CHECK AROUND THE CALL.
 *
 * CLAUDE.md forbids pre-checking a balance, and the reason is a race: between
 * the check and the write another request spends the same money. That reason
 * applies here in full and there is no second line of defence to fall back on
 * — the ledger's overdraft guard covers `customer_*` accounts and deliberately
 * exempts `provider_float`, which goes negative routinely and by design. So
 * unlike `AffordabilityService`, this is not a courtesy in front of a rule
 * that will decide anyway: it IS the rule, and a plain read before the call
 * would be the race with nothing behind it.
 *
 * It therefore runs the way the daily ceiling does — inside the reserve
 * entry's own transaction, on the entry's own connection, under a per-currency
 * advisory lock — so two cedi payouts arriving together cannot each find the
 * same cedis available. It writes nothing and throws to refuse, which is what
 * `LedgerService.post` requires of a precondition.
 *
 * IT COUNTS WHAT IS RESERVED AND NOT YET SENT. A payout reaches `sent` by
 * posting to `provider_float`, so a sent one is already reflected in the
 * balance and counting it again would subtract it twice; a reserved one has
 * touched only the customer's wallet, so the float still shows money that is
 * spoken for.
 *
 * AND IT APPLIES ONLY TO A PREFUNDED RAIL. Paystack and Bitnob settle from
 * accounts this platform does not keep a float in, so there is nothing to run
 * out of — and `provider_float` is one account per currency rather than one
 * per provider, so a naira figure spans two rails and would answer a question
 * nobody asked. The adapter declares its own nature; this reads it.
 */
@Injectable()
export class PlatformFloatService {
  readonly #logger = new Logger(PlatformFloatService.name);

  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  /**
   * A precondition, or `undefined` when there is nothing to enforce.
   *
   * `undefined` rather than a hook that runs and decides to do nothing — the
   * rule `SpendingLimitsService` states: a hook that always runs and
   * sometimes declines to act is a hook somebody later adds a side effect to.
   */
  async precondition(options: {
    readonly prefunded: boolean;
    readonly amount: Money<Currency>;
  }): Promise<((client: PoolClient) => Promise<void>) | undefined> {
    if (!options.prefunded) return undefined;

    // Read OUTSIDE the transaction. A cached settings lookup can itself hit
    // the database, and holding the ledger's transaction open across one
    // lengthens every payout for a value that changes once a year.
    const enabled = await this.settings.boolean('payout_float_guard_enabled', true);
    if (!enabled) return undefined;

    const { currency, amount } = options.amount;
    if (amount <= 0n) return undefined;

    return async (client: PoolClient): Promise<void> => {
      /*
       * PER CURRENCY, not per customer. What is being protected is one shared
       * float, so two different customers sending cedis at the same moment are
       * exactly the contention this has to serialise — the opposite scope from
       * the daily ceiling, and for the opposite reason.
       */
      await client.query(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [
        FLOAT_LOCK_SPACE,
        lockKeyFor(currency),
      ]);

      const read = await client.query<{ held_minor: string; committed_minor: string }>(
        `SELECT held_minor::text, committed_minor::text
           FROM platform_float_positions
          WHERE currency = $1`,
        [currency],
      );

      /*
       * NO ROW MEANS NO FLOAT ACCOUNT HAS EVER EXISTED IN THIS CURRENCY, so
       * the platform holds nothing in it — which is precisely the fresh
       * deployment this guard is for, and the refusal below is the true
       * answer rather than a gap to wave through. It is NOT read as "unknown,
       * so allow": that reading is what turns a missing row into money that
       * cannot be sent, discovered at the provider.
       */
      const held = BigInt(read.rows[0]?.held_minor ?? '0');
      const committed = BigInt(read.rows[0]?.committed_minor ?? '0');
      const available = held - committed;

      if (available >= amount) return;

      /*
       * THE FIGURES GO TO THE LOG AND NOT TO THE CUSTOMER. They are the
       * platform's treasury position, which is nobody's business outside the
       * building — and 006's rule is that what names our integration stays in
       * the log while the customer gets a code their app turns into words.
       */
      this.#logger.error(
        `PLATFORM FLOAT SHORTFALL: a ${amount} ${currency} payout was refused. ` +
          `Held ${held}, already committed ${committed}, available ${available} ` +
          `(minor units). Fund the ${currency} balance at the provider, or turn ` +
          `payout_float_guard_enabled off if this float is funded outside the ledger.`,
      );

      throw new ServiceUnavailableException({ error: 'insufficient_platform_liquidity' });
    };
  }
}

/** Its own lock space, so a currency key cannot collide with the per-customer
 *  keys the spending limits take in theirs. */
const FLOAT_LOCK_SPACE = 7_310_442;

/** A currency code is at most a few characters; this is a stable 31-bit hash
 *  of one. A collision costs two currencies a little contention and nothing
 *  else — the lock is not what makes the sum correct, only what makes it
 *  stable while it is read. */
function lockKeyFor(currency: string): number {
  let hash = 0;
  for (const character of currency) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 2147483647;
}
