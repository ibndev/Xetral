import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import {
  ProviderContractError,
  ProviderPendingError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  providerDidNothing,
} from '@xetral/providers';
import type { FundingCustomer, FundingPort } from '@xetral/providers';
import { CURRENCIES, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { open } from '@xetral/identity';
import { API_CONFIG, DATABASE, FUNDING_PORT, LEDGER } from '../tokens.js';
import { isMissingSchema, reportMissingSchema } from '../database-schema.js';
import type { ApiConfig } from '../config.js';

/**
 * How a customer gets money into the platform.
 *
 * They are issued a dedicated Nigerian account number in their own name,
 * permanently. They transfer to it from any bank, and Bitnob tells us. That is
 * the whole product surface; almost all of the work is in making sure the
 * telling is believed exactly once.
 */

export interface VirtualAccountView {
  readonly account_number: string;
  readonly bank_name: string;
  readonly account_name: string;
  readonly currency: string;
  readonly status: string;
}

export interface DepositView {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly sender_name: string | null;
  readonly sender_bank: string | null;
  readonly created_at: string;
}

interface AccountRow {
  id: string;
  user_id: string;
  provider_account_id: string;
  account_number: string;
  bank_name: string;
  account_name: string;
  currency: string;
  status: string;
}

/**
 * WHAT AN ACCOUNT IS OPENED IN when the platform cannot say where a customer
 * is. Naira, for the reason 050 gives about a null `users.country`: such a row
 * can only have been created when this platform operated in Nigeria alone, so
 * it is a claim about history rather than a guess.
 *
 * TYPED AS A `Currency`, not as a string. `FundingRequest.currency` is the
 * compile-time union, and a bare string there would let a country row naming a
 * currency the money registry has never heard of reach a provider — which is
 * finding 72 exactly: a currency with no EXPONENT is every amount in it wrong
 * by a power of ten.
 */
const FALLBACK_ACCOUNT_CURRENCY: Currency = 'NGN';

@Injectable()
export class FundingService {
  readonly #logger = new Logger(FundingService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(FUNDING_PORT) private readonly port: FundingPort,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * The customer's account, issued on first ask and returned for ever after.
   *
   * Idempotent by construction: the unique constraint on (user, currency)
   * means a second call cannot create a second number. That matters more here
   * than almost anywhere — a customer who saved the first number as a bank
   * beneficiary will keep paying into it, and a second account would receive
   * money nobody is watching.
   */
  /**
   * The account this customer already has, or nothing.
   *
   * READING IS NOT ISSUING, and the screen needs both as separate questions.
   * `accountFor` below CREATES one — it asks Bitnob, writes a row, and refuses
   * an unverified customer — so a page that called it merely to display a
   * number was opening a bank account as a side effect of being looked at.
   * That was survivable because issuing is idempotent, and it still meant the
   * only way to find out whether somebody had an account was to make sure they
   * did.
   *
   * `undefined` rather than a refusal: not having one is the resting state of
   * every new customer, not an error about them.
   */
  async existingAccount(userUuid: string): Promise<VirtualAccountView | undefined> {
    const userId = await this.#activeUserId(userUuid);
    const existing = await this.#accountOf(userId);
    return existing === undefined ? undefined : toAccountView(existing);
  }

  /**
   * NOTHING LEAVES THIS METHOD AS A BARE 500.
   *
   * THE FAILURE THIS EXISTS FOR. Every KNOWN way of failing below is caught
   * and given a code a client can turn into real words — a provider refusal,
   * a contract change, an outage, a missing migration. What was left over is
   * everything nobody thought of: a null column, a constraint, an `ON
   * CONFLICT` naming an index that is not there, a typo in a SQL string. Each
   * of those is invisible to the compiler and to every unit test, each has
   * happened in this codebase, and each reached the customer as "Something
   * went wrong" on the one screen they opened in order to be paid.
   *
   * So the outer catch does two things the inner ones cannot. It writes the
   * exception AND ITS STACK to the log under a sentence naming this flow, so
   * the row `error_events` already records is findable rather than merely
   * present. And it answers `account_issue_unavailable`, which both apps
   * already render as "we could not open your account just now" — true of an
   * unknown failure, and better than a sentence which is true of every
   * failure there has ever been.
   *
   * It deliberately does NOT swallow an HttpException: those are the answers
   * above, already correct, and re-wrapping them would replace a specific
   * refusal with a vague one.
   *
   * AND IT CARRIES THE ORIGINAL AS `cause`, which is not a detail. Without
   * it this catch would be a REGRESSION against its own purpose: the
   * exception filter records whatever reaches it, so replacing a
   * `TypeError: cannot read properties of null` with a
   * `ServiceUnavailableException` would write "Service Unavailable" into
   * `error_events` — turning the one row that says what happened into
   * another row that says nothing. The filter unwraps it.
   */
  async accountFor(userUuid: string): Promise<VirtualAccountView> {
    try {
      return await this.#openAccount(userUuid);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.#logger.error(
        `OPENING A DEPOSIT ACCOUNT THREW SOMETHING THIS SERVICE DOES NOT CLASSIFY, ` +
          `which is why the customer saw a generic failure: ` +
          `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
      if (error instanceof Error && error.stack !== undefined) {
        this.#logger.error(error.stack);
      }
      throw new ServiceUnavailableException(
        { error: 'account_issue_unavailable' },
        { cause: error },
      );
    }
  }

  async #openAccount(userUuid: string): Promise<VirtualAccountView> {
    const userId = await this.#activeUserId(userUuid);

    /*
     * THE ACCOUNT IS OPENED IN THE CUSTOMER'S OWN CURRENCY.
     *
     * It was always naira, whoever asked — so `providerFor('collect', …)`,
     * which picks the rail FROM the currency, was asked about NGN on behalf of
     * every customer on the platform and correctly answered Paystack. A
     * Paystack account registered in Nigeria settles in naira; asked to open
     * one for a Ghanaian it either refuses or issues a number their money
     * cannot reach, and both arrived on the screen as the same shrug.
     *
     * Naming the currency first is what lets 059 do its job: GHS and KES route
     * to Flutterwave, NGN stays on Paystack, and a corridor with no route
     * falls back to the global setting rather than becoming an outage.
     */
    const currency = await this.#accountCurrencyOf(userId);

    const existing = await this.#accountOf(userId, currency);
    if (existing !== undefined) return toAccountView(existing);

    /*
     * KYC IS NO LONGER ASKED FOR HERE, and that is a correction rather than a
     * relaxation.
     *
     * This used to refuse anybody without a `provider_customers` row, on the
     * reasoning that "a bank account cannot be issued to an unidentified
     * person". That is true of BITNOB, which will not issue one without a
     * verified BVN. It is not true of the rail: CBN's tiered KYC permits a
     * tier 1 account on a name and a phone number, and
     * `029_kyc_tiers.seed.sql` has capped tier 0 at ₦50,000 a day since it
     * landed. So the platform enforced the tier 1 ceiling and refused the
     * account that ceiling is for — on the screen a customer opens in order
     * to put money in, which read as "you may not deposit until you verify".
     *
     * The requirement did not disappear; it moved to where it is true. The
     * Bitnob adapter refuses an unverified customer in its own code, with its
     * own reason, and the Paystack adapter does not need to.
     *
     * The mapping is still PASSED when we have one — a customer who has been
     * through KYC should not get a second provider-side customer record.
     */
    /*
     * EACH RAIL IN TURN, AND ONLY AFTER A DEFINITE "NO".
     *
     * Activate Account failed in Nigeria and in Ghana for one reason: naira
     * account numbers were routed to Flutterwave, which opens a permanent
     * account only with a verified BVN, and nothing else was ever asked. An
     * unverified Nigerian and every Ghanaian — who has no BVN to give — were
     * refused while another rail that opens a tier 1 account from a name sat
     * one row away. 079's `account_fallback` lets the refusal move on.
     *
     * IT MOVES ON ONLY WHEN THE RAIL CERTAINLY DID NOTHING: a refusal, or a
     * request that never left. A timeout, a 5xx or a reply we could not read
     * may have opened an account, and a second rail after that is a customer
     * with two live numbers, one of them receiving money nothing watches.
     *
     * `kyc_required` ONLY WHEN EVERY RAIL WANTED IT. The customer is told to
     * verify only if verifying is genuinely the one thing that would change
     * the answer. It used to be said whenever ANY rail had wanted it, so a
     * deployment whose Paystack key was missing — the rail that opens a
     * tier 1 account from a name — told every unverified customer to go and
     * verify, which is the KYC prompt this flow exists to not show, about a
     * problem that was an operator's. Where a rail failed for its own reason,
     * THAT is the failure relayed.
     */
    const rails = await this.#accountRailsFor(currency);
    const refusals: { rail: string; error: unknown }[] = [];
    let issued;
    for (let i = 0; i < rails.length; i += 1) {
      const rail = rails[i] as string;
      const customer = await this.#fundingCustomer(userId, rail);
      try {
        issued = await this.#createAt(rail, {
          customer,
          currency,
          // Derived from our user id AND the currency, so a retry after a
          // timeout asks for the same account rather than a second one — and
          // a customer who holds two currencies is not answered with the
          // wrong account.
          idempotencyKey: `xetral-va-${userId}-${currency}`,
        });
        if (i > 0) {
          this.#logger.log(
            `opened a ${currency} account for user ${userId} on ${rail} after ` +
              `${rails.slice(0, i).join(', ')} refused`,
          );
        }
        break;
      } catch (error) {
        // Anything but a certain "no" stops here: that rail may have opened
        // an account, and asking another is a second live number.
        if (!providerDidNothing(error)) this.#relayAccountFailure(error, rail, currency);
        refusals.push({ rail, error });
        if (i < rails.length - 1) {
          this.#logger.warn(
            `${rail} did not open a ${currency} account for user ${userId} ` +
              `(${error instanceof Error ? error.message : String(error)}); trying ${rails[i + 1]}`,
          );
        }
      }
    }
    if (issued === undefined) {
      const actionable = refusals.find(
        (r) => !(r.error instanceof ProviderRejectedError && r.error.providerCode === 'kyc_required'),
      );
      if (actionable === undefined && refusals.length > 0) {
        throw new UnprocessableEntityException({
          error: 'kyc_required',
          detail: 'Verify your identity to get your own account number.',
        });
      }
      if (actionable !== undefined) {
        this.#relayAccountFailure(actionable.error, actionable.rail, currency);
      }
    }
    if (issued === undefined) throw new Error('no funding rail was asked for an account');

    /*
     * WRAPPED, because this INSERT writes columns a MIGRATION adds.
     *
     * `provider` and `provider_customer_ref` arrive in 044. On a deployment
     * where this code rolled out and that migration did not, Postgres answers
     * `column "provider" of relation "virtual_accounts" does not exist`,
     * nothing caught it, Nest answered a bare 500, and the customer read
     * "something went wrong" on the screen they opened in order to put money
     * in. From outside that is indistinguishable from a wrong key or an
     * unapproved integration, so an operator can spend a day on the provider
     * dashboard while the answer is one `psql -f` away.
     *
     * Note WHERE this sits: after the provider call. An account may now exist
     * at the rail that we cannot record — which the log says, because the
     * adapter looks before it creates, so the retry after the migration finds
     * that account rather than opening a second live number.
     */
    let inserted;
    try {
      inserted = await this.pool.query<AccountRow>(
        `INSERT INTO virtual_accounts
           (user_id, provider, provider_account_id, provider_customer_ref,
            account_number, bank_name, account_name, currency, status)
         VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $9, $8)
         ON CONFLICT (user_id, currency) WHERE (status <> 'closed') DO NOTHING
         RETURNING id, user_id, provider_account_id, account_number, bank_name,
                   account_name, currency, status`,
        [
          userId,
          // WHO ACTUALLY ISSUED IT, off the account rather than off the port.
          // The port is a switch whose `provider` is the configured default, so
          // reading it here would relabel this row the moment an operator
          // changed the setting — and the row is what routes every later read
          // and every webhook back to the rail that holds the money.
          issued.provider,
          issued.providerAccountId,
          issued.providerCustomerRef ?? null,
          issued.accountNumber,
          issued.bankName,
          issued.accountName,
          issued.active ? 'active' : 'pending',
          /*
           * $9, appended rather than slotted into reading order. Renumbering
           * the eight above to make room is exactly how a placeholder comes to
           * name the wrong value — the fault 045 shipped, where a statement
           * referenced $9 against an array of eight and every card issue
           * answered 500 with the compiler entirely satisfied.
           */
          currency,
        ],
      );
    } catch (error) {
      if (isMissingSchema(error)) {
        reportMissingSchema(this.#logger, error, `opening a ${currency} account`);
        this.#logger.error(
          `The rail may have opened account ${issued.accountNumber} for user ${userId} ` +
            `and this deployment could not record it. The adapter looks before it ` +
            `creates, so applying the migration and retrying finds that same account ` +
            `rather than opening a second one.`,
        );
        throw new ServiceUnavailableException({ error: 'account_issue_unavailable' });
      }
      throw error;
    }

    const row = inserted.rows[0];
    if (row !== undefined) return toAccountView(row);

    // Two requests raced. The loser reads the winner's row rather than
    // failing — the customer asked once as far as they are concerned.
    const raced = await this.#accountOf(userId, currency);
    if (raced === undefined) throw new Error('virtual account insert returned no row');
    return toAccountView(raced);
  }

  async deposits(userUuid: string): Promise<readonly DepositView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<{
      uuid: string;
      amount_minor: string;
      currency: string;
      sender_name: string | null;
      sender_bank: string | null;
      created_at: string;
    }>(
      `SELECT uuid, amount_minor, currency, sender_name, sender_bank, created_at
         FROM deposits
        WHERE user_id = $1::bigint AND status = 'credited'
        ORDER BY id DESC LIMIT 100`,
      [userId],
    );

    return rows.rows.map((r) => ({
      id: r.uuid,
      amount: toMajor({ amount: BigInt(r.amount_minor), currency: r.currency as Currency }),
      currency: r.currency,
      sender_name: r.sender_name,
      sender_bank: r.sender_bank,
      created_at: r.created_at,
    }));
  }

  /* ------------------------------------------------------------------ */

  /** Resolves the account a deposit landed on, by provider id or by NUBAN. */
  /**
   * Which account a deposit landed on.
   *
   * THE PROVIDER IS AN ARGUMENT, NOT `this.port.provider`, and that changed
   * when a second rail landed. The port is now a switch whose `provider` is
   * the CONFIGURED DEFAULT, so filtering on it would have stopped resolving
   * every Bitnob-issued account the moment an operator set the default to
   * Paystack — and an unresolvable deposit does not fail loudly. It posts to
   * SUSPENSE, which is correct behaviour for money we cannot attribute and
   * completely wrong as a consequence of a settings change.
   *
   * A caller that knows which rail told it — every webhook does — passes it.
   */
  async resolveAccount(
    providerAccountId: string | undefined,
    accountNumber: string | undefined,
    provider?: string,
  ): Promise<AccountRow | undefined> {
    if (providerAccountId !== undefined) {
      const byId = await this.pool.query<AccountRow>(
        `SELECT id, user_id, provider_account_id, account_number, bank_name,
                account_name, currency, status
           FROM virtual_accounts
          WHERE provider_account_id = $2
            AND ($1::text IS NULL OR provider = $1)`,
        [provider ?? null, providerAccountId],
      );
      if (byId.rows[0] !== undefined) return byId.rows[0];
    }

    if (accountNumber !== undefined) {
      // The NUBAN is the fallback, not the primary: it is what a customer
      // types and what a provider may echo, but the provider's own id is the
      // thing that cannot be mistyped.
      const byNumber = await this.pool.query<AccountRow>(
        `SELECT id, user_id, provider_account_id, account_number, bank_name,
                account_name, currency, status
           FROM virtual_accounts WHERE account_number = $1`,
        [accountNumber],
      );
      if (byNumber.rows[0] !== undefined) return byNumber.rows[0];
    }

    return undefined;
  }

  /**
   * The customer's live account.
   *
   * IT SAID `currency = 'NGN'`, AND THAT WAS A STATEMENT ABOUT NIGERIA WRITTEN
   * AS A STATEMENT ABOUT THE PLATFORM. A customer in Accra whose account is in
   * cedis had no live account by this query, so the screen offered to open one
   * they already held — the same shape as `HOME_CURRENCY` being read as a fact
   * about the platform rather than about Nigeria, which 040 records.
   *
   * `currency` GIVEN: the open path, which must not find a cedi account and
   * conclude a naira one exists. OMITTED: the read path, which wants whichever
   * live account this customer holds — the partial unique index allows one per
   * currency, and the ordering puts their own first.
   */
  async #accountOf(userId: string, currency?: string): Promise<AccountRow | undefined> {
    if (currency !== undefined) {
      const one = await this.pool.query<AccountRow>(
        `SELECT id, user_id, provider_account_id, account_number, bank_name,
                account_name, currency, status
           FROM virtual_accounts
          WHERE user_id = $1::bigint AND currency = $2 AND status <> 'closed'`,
        [userId, currency],
      );
      return one.rows[0];
    }

    const home = await this.#homeCurrencyOf(userId);
    const result = await this.pool.query<AccountRow>(
      `SELECT id, user_id, provider_account_id, account_number, bank_name,
              account_name, currency, status
         FROM virtual_accounts
        WHERE user_id = $1::bigint AND status <> 'closed'
        ORDER BY (currency = $2) DESC, id ASC`,
      [userId, home],
    );
    return result.rows[0];
  }

  /**
   * WHAT A PROVIDER'S REFUSAL BECOMES — every branch throws, so the caller's
   * loop cannot fall through with nothing issued.
   */
  #relayAccountFailure(error: unknown, rail: string, currency: Currency): never {
      if (error instanceof ProviderPendingError) {
        this.#logger.log(
          `the funding rail accepted the account request and has not attached a number ` +
            `yet: ${error.message}`,
        );
        throw new ServiceUnavailableException({ error: 'account_issue_pending' });
      }

      if (error instanceof ProviderTimeoutError) {
        // We do not know whether an account was created. Asking again is safe
        // BECAUSE the request carried an idempotency key; inventing one here
        // would make the retry a second account.
        throw new ServiceUnavailableException({ error: 'account_issue_pending' });
      }

      /*
       * WHAT THE PROVIDER SAID, WRITTEN DOWN — because without this the whole
       * class of "Activate Account fails and nobody can say why" is a 500.
       *
       * Every other provider error fell through to Nest's default handler,
       * which answers a bare 500 with no code the client names. The customer
       * saw "something went wrong"; the operator saw a stack trace with the
       * refusal buried in it. And these are exactly the failures an operator
       * CAN fix: dedicated accounts not enabled on the integration, a
       * `preferred_bank` this business is not approved for, a key from the
       * wrong environment. Every one arrives as the provider's own sentence,
       * and every one was being thrown away.
       *
       * The sentence goes to the LOG, never to the customer: it names our
       * integration and sometimes our merchant id. What the customer gets is
       * a code their app can turn into a real message.
       */
      if (error instanceof ProviderRejectedError) {
        this.#logger.error(
          `${rail} REFUSED to open a ${currency} account: ${error.message} ` +
            `(provider code ${error.providerCode ?? 'none'}). This is a refusal, not an ` +
            `outage — the credential is reaching them.` +
            /*
             * THE ADVICE ONLY WHERE IT APPLIES. It named `paystack_preferred_bank`
             * on every refusal, including the one that means this rail has no
             * such product in this currency at all — sending an operator to
             * check a setting that has nothing to do with it, which is the same
             * fault as the log line that named the wrong provider.
             */
            (error.providerCode === 'account_not_supported_here'
              ? ''
              : ' Check that dedicated accounts are enabled on the integration and that ' +
                'paystack_preferred_bank names a bank it is approved for.'),
        );
        // `kyc_required` is a real answer a client already handles — Bitnob
        // returns it for an unverified customer — so it is passed through
        // rather than flattened into the generic code.
        /*
         * TWO PROVIDER CODES ARE PASSED THROUGH rather than flattened, and
         * both for the same reason: they are PERMANENT facts a customer's app
         * can turn into a true sentence, where the generic code invites
         * somebody to try again shortly.
         *
         * WRITTEN AS THREE THROWS RATHER THAN A NESTED TERNARY, deliberately.
         * `error-codes.test.ts` scans this source for the codes the API can
         * emit, and its own header records that a code chosen by a ternary is
         * invisible to it — two once reached customers with no client-side
         * name while the scanner reported full coverage. A second level of
         * nesting is the same trap one turn deeper, so the literals stay
         * literal.
         */
        if (error.providerCode === 'kyc_required') {
          // Bitnob's answer for a customer it has not verified a BVN for.
          throw new UnprocessableEntityException({
            error: 'kyc_required',
            detail: 'Verify your identity to get your own account number.',
          });
        }
        if (error.providerCode === 'account_not_supported_here') {
          /*
           * The rail serving this currency does not issue dedicated account
           * numbers in it AT ALL — the Ghana and Kenya case. Flutterwave's
           * virtual accounts are an NGN product, and
           * `countries.funding_methods` already records that money arrives
           * there by a mobile money charge instead.
           */
          throw new UnprocessableEntityException({ error: 'account_not_supported_here' });
        }
        throw new UnprocessableEntityException({ error: 'account_issue_refused' });
      }
      if (error instanceof ProviderContractError) {
        this.#logger.error(
          `${rail} answered a shape this adapter does not accept while opening a ` +
            `${currency} account: ${error.message}. Their API has changed, or the ` +
            `credential belongs to a different product; waiting will not fix it.`,
        );
        throw new ServiceUnavailableException({ error: 'account_issue_unavailable' });
      }
      if (error instanceof ProviderUnavailableError) {
        this.#logger.error(
          `${rail} is unreachable while opening a ${currency} account: ${error.message}`,
        );
        throw new ServiceUnavailableException({ error: 'account_issue_unavailable' });
      }
      throw error;
    throw error;
  }

  /**
   * THE CURRENCY AN ACCOUNT NUMBER IS OPENED IN.
   *
   * The customer's own, WHERE A RAIL OPENS ACCOUNTS IN IT — and naira
   * everywhere else. A Ghanaian pressing Activate Account was asking
   * Flutterwave for a CEDI account number, which no rail here issues, and
   * never got the naira one every customer is offered: the naira wallet is
   * the funding rail for everybody (040), and money paid to a Ghanaian by a
   * Nigerian lands in it. 079's coverage says where an account number is a
   * product; today that is naira alone.
   */
  async #accountCurrencyOf(userId: string): Promise<Currency> {
    const home = await this.#homeCurrencyOf(userId);
    const switching = this.port as FundingPort & {
      accountCurrencies?: () => Promise<readonly string[]>;
    };
    let offered: readonly string[] = [FALLBACK_ACCOUNT_CURRENCY];
    try {
      if (typeof switching.accountCurrencies === 'function') {
        offered = await switching.accountCurrencies();
      }
    } catch {
      // The naira answer stands: the one currency every rail has opened in.
    }
    return offered.includes(home) ? home : FALLBACK_ACCOUNT_CURRENCY;
  }

  /** The rails to ask, in order: the switch's answer, or the one port there is. */
  async #accountRailsFor(currency: Currency): Promise<readonly string[]> {
    const switching = this.port as FundingPort & {
      accountRails?: (currency: string) => Promise<readonly string[]>;
    };
    if (typeof switching.accountRails === 'function') {
      const rails = await switching.accountRails(currency);
      if (rails.length > 0) return rails;
    }
    return [await this.#railFor(currency)];
  }

  async #createAt(
    rail: string,
    request: Parameters<FundingPort['createVirtualAccount']>[0],
  ): ReturnType<FundingPort['createVirtualAccount']> {
    const switching = this.port as FundingPort & {
      createVirtualAccountAt?: FundingPort['createVirtualAccount'] extends (r: infer R) => infer O
        ? (provider: string, request: R) => O
        : never;
    };
    if (typeof switching.createVirtualAccountAt === 'function') {
      return switching.createVirtualAccountAt(rail, request);
    }
    return this.port.createVirtualAccount(request);
  }

  /**
   * WHICH CURRENCY THIS CUSTOMER'S ACCOUNT IS IN, from the country they chose.
   *
   * Allowed to fail, for the reason `describeSession` splits its two reads:
   * `countries` arrives in 040, and a deployment behind it must still be able
   * to open the account it has always opened.
   */
  async #homeCurrencyOf(userId: string): Promise<Currency> {
    try {
      const found = await this.pool.query<{ currency: string | null }>(
        `SELECT c.currency
           FROM users u LEFT JOIN countries c ON c.code = u.country
          WHERE u.id = $1::bigint`,
        [userId],
      );
      const named = found.rows[0]?.currency;
      /*
       * CHECKED AGAINST THE REGISTRY rather than cast. `countries.currency` is
       * a text column an operator writes, and a code the money primitives do
       * not know has no exponent — so every amount in it would be wrong by a
       * power of ten, which is the reason a currency is a compile-time union
       * while a country is data.
       */
      if (named !== null && named !== undefined && CURRENCIES[named as Currency] !== undefined) {
        return named as Currency;
      }
      return FALLBACK_ACCOUNT_CURRENCY;
    } catch {
      return FALLBACK_ACCOUNT_CURRENCY;
    }
  }

  /**
   * Who the account is for, from what the platform already holds.
   *
   * `users.full_name` is what somebody typed about themselves at signup, and
   * 040 is explicit that it is NOT the verified name — `kyc_submissions.full_name`
   * is what a reviewer read off a document, and only that one may inform a
   * money decision. Opening a tier 1 account is not a money decision about
   * WHO somebody is; it is giving them somewhere to be paid, under a ceiling
   * that already assumes they are unverified. So the signup name is the right
   * one to use here and would be the wrong one on a card.
   *
   * The provider mapping is passed when it exists, so a verified customer
   * does not acquire a second customer record at the provider.
   */
  /**
   * WHICH RAIL IS ACTUALLY SERVING, for a log line that has to name it.
   *
   * `port.provider` is the configured DEFAULT and the switch says so, so a
   * message built from it would name the wrong provider on a deployment that
   * had flipped the setting — which is the one moment somebody is reading
   * these logs. Falls back to the default rather than failing: a diagnostic
   * that can itself throw makes an outage harder to read, not easier.
   */
  /**
   * AND IT MUST NAME THE RAIL THIS CURRENCY ROUTES TO, not the global default.
   *
   * Asking for the default produced a sentence that was actively misleading on
   * the one line an operator reads to diagnose this: "paystack is unreachable
   * while opening a GHS account: [flutterwave] no Flutterwave secret key is
   * configured". Two provider names in one sentence, the wrong one first, and
   * an operator sent to check a Paystack credential that had nothing to do
   * with it.
   */
  async #railFor(currency: Currency): Promise<string> {
    const switching = this.port as FundingPort & {
      providerForCurrency?: (currency: string) => Promise<string>;
      activeProvider?: () => Promise<string>;
    };
    try {
      if (typeof switching.providerForCurrency === 'function') {
        return await switching.providerForCurrency(currency);
      }
      if (typeof switching.activeProvider === 'function') {
        return await switching.activeProvider();
      }
    } catch {
      // A diagnostic that can itself throw makes an outage harder to read.
    }
    return this.port.provider;
  }

  async #fundingCustomer(userId: string, rail: string): Promise<FundingCustomer> {
    const result = await this.pool.query<{
      email: string | null;
      full_name: string | null;
      phone: string | null;
      provider_customer_id: string | null;
    }>(
      `SELECT u.email, u.full_name, u.phone,
              (SELECT pc.provider_customer_id FROM provider_customers pc
                WHERE pc.user_id = u.id AND pc.provider = $2) AS provider_customer_id
         FROM users u WHERE u.id = $1::bigint`,
      /*
       * THE RAIL THAT WILL SERVE, not `port.provider` — which is the switch's
       * configured DEFAULT. Asking about the default passed Paystack's mapping
       * (none) to a Bitnob request, so a verified customer was refused by
       * Bitnob as unverified whenever the default and the route differed.
       */
      [userId, rail],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });

    if (row.email === null || row.email === '') {
      // Every rail keys a customer on an email address, and this one cannot
      // be null for a registered account. Refusing here names the reason
      // rather than letting a provider answer with its own wording.
      throw new ConflictException({ error: 'profile_incomplete', field: 'email' });
    }

    const { firstName, lastName } = splitName(row.full_name);
    return {
      reference: userId,
      email: row.email,
      firstName,
      lastName,
      phone: row.phone ?? undefined,
      providerCustomerId: row.provider_customer_id ?? undefined,
      bvn: () => this.#approvedBvn(userId),
      dateOfBirth: () => this.#approvedDateOfBirth(userId),
    };
  }

  /**
   * The date of birth off the APPROVED submission, for the rail that verifies
   * a BVN against it (Bitnob). Same rule as the BVN: a pending submission is
   * a claim nobody has checked.
   */
  async #approvedDateOfBirth(userId: string): Promise<string | undefined> {
    const found = await this.pool.query<{ dob: string }>(
      `SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS dob FROM kyc_submissions
        WHERE user_id = $1::bigint AND status = 'approved'
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    return found.rows[0]?.dob;
  }

  /**
   * The customer's BVN, unsealed — ONLY for a rail that has asked for it.
   *
   * From an APPROVED submission and no other: a pending one is a claim nobody
   * has checked, and sending it to a bank opens an account in whatever name
   * was typed. Undefined rather than a throw when there is none, so the
   * adapter that needs it refuses with `kyc_required` in its own words.
   *
   * The plaintext lives for one request and is never logged, returned or
   * stored; the sealed column is the only place it rests.
   */
  async #approvedBvn(userId: string): Promise<string | undefined> {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) return undefined;
    const found = await this.pool.query<{ bvn_sealed: string }>(
      `SELECT bvn_sealed FROM kyc_submissions
        WHERE user_id = $1::bigint AND status = 'approved'
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    const sealed = found.rows[0]?.bvn_sealed;
    if (sealed === undefined) return undefined;
    try {
      return open(sealed, keyring);
    } catch (error: unknown) {
      // A sealed value this keyring cannot open — a key version retired while
      // rows still carried it. Said LOUDLY and never with the value; the
      // adapter then refuses as for a customer with no BVN, because sending
      // nothing is the only safe thing to send.
      this.#logger.error(
        `the approved BVN for user ${userId} could not be unsealed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return undefined;
    }
  }

  async #activeUserId(uuid: string): Promise<string> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    if (row.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: row.status });
    }
    return row.id;
  }
}

function toAccountView(row: AccountRow): VirtualAccountView {
  return {
    account_number: row.account_number,
    bank_name: row.bank_name,
    account_name: customerNameOf(row.account_name),
    currency: row.currency,
    status: row.status,
  };
}

/**
 * THE CUSTOMER'S OWN NAME, not the business's and theirs.
 *
 * A rail names a dedicated account after the MERCHANT and the holder —
 * `XETRAL/OLAWALE IDRIS`, `XETRAL-OLAWALE IDRIS` — because from the bank's
 * side the account belongs to the platform and is operated for a customer.
 * That is true and it is not what somebody reads on the screen they opened to
 * be paid into: their own account, described by somebody else's name first.
 *
 * THE ROW KEEPS WHAT THE PROVIDER SAID and this trims only what is SHOWN.
 * The stored value is what the bank will display to a sender and what a
 * reconciliation has to match, so rewriting it would make our record disagree
 * with the rail's — 006's rule that a virtual account row describes what was
 * issued rather than what we would have preferred.
 *
 * IT TRIMS A PREFIX AND NEVER INVENTS ONE. A name with no separator is
 * returned unchanged, and so is one whose trailing part is empty — the
 * failure to avoid is a blank where a name was, which reads as something that
 * did not load.
 */
export function customerNameOf(accountName: string): string {
  const tail = accountName.split(/[/\\|]/).pop()?.trim() ?? '';
  return tail === '' ? accountName.trim() : tail;
}

/**
 * One name field into the two every provider asks for.
 *
 * `users.full_name` is one string because that is how a person writes their
 * own name, and both rails want it split. The last word is the surname and
 * everything before it is the rest — which is right for "Ada Obi" and for
 * "Adebayo Olusegun Adeyemi", and wrong for a mononym, where the given name
 * is empty and a provider may refuse.
 *
 * A mononym therefore repeats the single word into both halves rather than
 * sending an empty one: an account opened under "Ada Ada" is a correctable
 * cosmetic problem, and a refused account is a customer who cannot be paid.
 */
export function splitName(fullName: string | null): {
  firstName: string;
  lastName: string;
} {
  const parts = (fullName ?? '').trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return { firstName: 'Xetral', lastName: 'Customer' };
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: parts[0] as string };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1] as string,
  };
}
