import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
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
import type {
  AccountIdentity,
  FundingCustomer,
  FundingPort,
  IdentityBank,
  VirtualAccount,
} from '@xetral/providers';
import { CURRENCIES, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { blindIndex, open } from '@xetral/identity';
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

/**
 * How long a submission counts as "still being matched". Paystack's own
 * documentation says assignment usually lands within a minute; half an hour
 * is the point past which silence means the event was lost, and the
 * customer may try again rather than wait on something that will not come.
 */
const IDENTITY_IN_FLIGHT = '30 minutes';

/** Submissions a customer may make in a day. A BVN form with no ceiling is a
 *  way to test BVNs against bank accounts at a provider's expense. */
const IDENTITY_ATTEMPTS_PER_DAY = 5;

function isIdentityRequired(error: unknown): boolean {
  return error instanceof ProviderRejectedError && error.providerCode === 'identity_required';
}

function isOneBvnOneCustomer(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === 'account_identity_one_bvn_one_customer';
}

/**
 * A customer whose account the rail has said "not identified" about, being
 * asked again in the background. In memory, deliberately: a restart loses
 * the schedule, and the customer's next visit to Add Money starts it again.
 */
interface RetryState {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the last schedule ran out; a visit long after starts another. */
  exhaustedAt: number | undefined;
}

/** How long an exhausted schedule stands before a visit starts a fresh one. */
const RETRY_AGAIN_AFTER_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class FundingService implements OnModuleDestroy {
  readonly #logger = new Logger(FundingService.name);
  readonly #retrying = new Map<string, RetryState>();

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

  /**
   * THE BANKS THE IDENTITY FORM OFFERS — from the rail that would receive the
   * details, because the code goes back to the provider that issued it. Empty
   * where the rail serving this customer never asks for identity.
   */
  async identityBanks(userUuid: string): Promise<readonly IdentityBank[]> {
    const userId = await this.#activeUserId(userUuid);
    const currency = await this.#accountCurrencyOf(userId);
    const rail = (await this.#accountRailsFor(currency))[0] as string;
    const switching = this.port as FundingPort & {
      identityBanksAt?: (provider: string) => Promise<readonly IdentityBank[] | undefined>;
    };
    if (typeof switching.identityBanksAt !== 'function') return [];
    try {
      return (await switching.identityBanksAt(rail)) ?? [];
    } catch (error) {
      this.#logger.error(
        `could not read ${rail}'s bank list for the identity form: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      throw new ServiceUnavailableException({ error: 'account_issue_unavailable' });
    }
  }

  /**
   * OPENS THE ACCOUNT A RAIL WOULD NOT OPEN UNTIL THE CUSTOMER WAS IDENTIFIED.
   *
   * Paystack answers "Customer has not been identified" for a business in a
   * category it requires to identify its customers, and what it wants is a
   * BVN and a bank account on it — which it matches ITSELF, with no reviewer
   * here. So this sends exactly those three values to the rail the owner
   * assigned, and nothing else of them survives the request: 089 keeps a
   * keyed fingerprint (025's blind index), the last four of each, and the
   * outcome.
   *
   * THE FINGERPRINT IS CHECKED BEFORE ANYTHING IS SENT. Every per-customer
   * control assumes one person is one customer, so a BVN already standing for
   * somebody else is refused by the database — with the same answer as a BVN
   * that does not match its account, so the form cannot be used to learn
   * whether a BVN banks here.
   *
   * NO PIN, deliberately. This brings money IN and moves none; a customer
   * without a PIN is exactly the new customer this is for. It is bounded
   * instead: five submissions a day, and one in flight at a time.
   */
  async identify(userUuid: string, identity: AccountIdentity): Promise<VirtualAccountView> {
    try {
      return await this.#identify(userUuid, identity);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.#logger.error(
        `SUBMITTING IDENTITY FOR A DEPOSIT ACCOUNT THREW SOMETHING THIS SERVICE DOES NOT ` +
          `CLASSIFY: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      if (error instanceof Error && error.stack !== undefined) this.#logger.error(error.stack);
      throw new ServiceUnavailableException({ error: 'account_issue_unavailable' }, { cause: error });
    }
  }

  async #identify(userUuid: string, identity: AccountIdentity): Promise<VirtualAccountView> {
    const userId = await this.#activeUserId(userUuid);
    const currency = await this.#accountCurrencyOf(userId);

    const existing = await this.#accountOf(userId, currency);
    if (existing !== undefined) return toAccountView(existing);

    // THE RAIL THE OWNER ASSIGNED, and only it. 089's point is that the
    // details go to one company, not to whichever will take them.
    const rail = (await this.#accountRailsFor(currency))[0] as string;
    const customer = await this.#fundingCustomer(userId, rail);
    if (customer.phone === undefined || customer.phone === '') {
      // The assign call requires one; asked for by name before anything is
      // stored or sent, so the customer can add it on Settings and come back.
      throw new ConflictException({ error: 'profile_incomplete', field: 'phone', fields: ['phone'] });
    }

    const key = this.config.kycBlindIndexKey;
    if (key === undefined) {
      // Without the key the one-BVN-one-customer check cannot run, and
      // sending a BVN nothing can match against is not a safe default.
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }

    let checkId: string;
    try {
      const recent = await this.pool.query<{ total: string; in_flight: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status = 'submitted'
                                   AND created_at > now() - $2::interval)::text AS in_flight
           FROM account_identity_checks
          WHERE user_id = $1::bigint AND created_at > now() - interval '1 day'`,
        [userId, IDENTITY_IN_FLIGHT],
      );
      if (Number(recent.rows[0]?.in_flight ?? '0') > 0) {
        // Paystack is still matching the last one. Sending again would be a
        // second assignment request for one customer.
        throw new ServiceUnavailableException({ error: 'account_issue_pending' });
      }
      if (Number(recent.rows[0]?.total ?? '0') >= IDENTITY_ATTEMPTS_PER_DAY) {
        throw new HttpException({ error: 'too_many_attempts' }, HttpStatus.TOO_MANY_REQUESTS);
      }

      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO account_identity_checks
           (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
         VALUES ($1::bigint, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          userId,
          rail,
          blindIndex(identity.bvn, key),
          identity.bvn.slice(-4),
          identity.bankCode,
          identity.accountNumber.slice(-4),
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('identity check insert returned no row');
      checkId = row.id;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isOneBvnOneCustomer(error)) {
        // The same answer as a mismatch, on purpose — see the method header.
        this.#logger.warn(`an identity submission for user ${userId} named a BVN held by another customer`);
        throw new UnprocessableEntityException({ error: 'account_identity_failed' });
      }
      if (isMissingSchema(error)) {
        reportMissingSchema(this.#logger, error, 'recording an identity check (089)');
        throw new ServiceUnavailableException({ error: 'account_issue_unavailable' });
      }
      throw error;
    }

    let issued: VirtualAccount;
    try {
      issued = await this.#createAt(rail, {
        customer,
        currency,
        idempotencyKey: `xetral-va-${userId}-${currency}`,
        identity,
      });
    } catch (error) {
      if (error instanceof ProviderPendingError || error instanceof ProviderTimeoutError) {
        // Sent, and the outcome is Paystack's to announce. The row stays
        // `submitted`; the webhook or the next visit finishes it.
        this.#relayAccountFailure(error, rail, currency);
      }
      if (error instanceof ProviderRejectedError) {
        if (error.providerCode === 'phone_required') {
          await this.#resolveCheck(checkId, 'failed', 'no phone number on the account');
          throw new ConflictException({ error: 'profile_incomplete', field: 'phone', fields: ['phone'] });
        }
        const aboutUs =
          error.providerCode === 'preferred_bank_unset' ||
          error.providerCode === 'http_401' ||
          error.providerCode === 'http_403';
        await this.#resolveCheck(checkId, 'failed', error.message);
        if (aboutUs) {
          // A key or a setting — an operator's to fix, and written down where
          // they read it. The customer is not told their details were wrong.
          this.#recordRefusal(rail, currency, error);
          this.#relayAccountFailure(error, rail, currency);
        }
        // THE RAIL'S SENTENCE, to the log and the row, never the customer:
        // it names our integration. The BVN is in neither.
        this.#logger.warn(`${rail} refused identity details for user ${userId}: ${error.message}`);
        throw new UnprocessableEntityException({ error: 'account_identity_failed' });
      }
      if (providerDidNothing(error)) {
        await this.#resolveCheck(checkId, 'failed', error instanceof Error ? error.message : 'not sent');
      }
      this.#recordRefusal(rail, currency, error);
      this.#relayAccountFailure(error, rail, currency);
    }

    await this.#resolveCheck(checkId, 'validated', null);
    return this.#record(userId, issued, currency);
  }

  /**
   * WHAT THE RAIL SAID, LATER — Paystack's `dedicatedaccount.assign.*` and
   * `customeridentification.*` events, which carry the customer's email and
   * nothing we act on beyond "success" or "failed".
   *
   * On success the account is then OPENED THROUGH THE ORDINARY PATH, which
   * looks before it creates and so finds the number Paystack just assigned:
   * the event is a doorbell, and what is recorded is Paystack's own answer to
   * our read. A failure marks the check so the customer's next visit says
   * their details did not match, rather than "still opening" for ever.
   */
  async identityOutcome(
    provider: string,
    email: string,
    outcome: 'validated' | 'failed',
    reason: string | undefined,
  ): Promise<void> {
    const found = await this.pool.query<{ id: string; uuid: string }>(
      `SELECT id, uuid FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    const user = found.rows[0];
    if (user === undefined) return;

    try {
      await this.pool.query(
        `UPDATE account_identity_checks
            SET status = $3, reason = $4, resolved_at = now()
          WHERE id = (SELECT id FROM account_identity_checks
                       WHERE user_id = $1::bigint AND provider = $2 AND status = 'submitted'
                       ORDER BY id DESC LIMIT 1)`,
        [user.id, provider, outcome, reason === undefined ? null : reason.slice(0, 500)],
      );
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
    }

    if (outcome === 'validated') {
      try {
        await this.accountFor(user.uuid);
      } catch (error) {
        // Not a reason to make Paystack retry an event that was delivered:
        // the customer's next visit asks again.
        this.#logger.warn(
          `${provider} identified user ${user.id} and the account could not be read yet: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  /** Best effort: an outcome that cannot be written must not become a second failure. */
  async #resolveCheck(
    checkId: string,
    status: 'validated' | 'failed',
    reason: string | null,
  ): Promise<void> {
    await this.pool
      .query(
        `UPDATE account_identity_checks
            SET status = $2, reason = $3, resolved_at = now()
          WHERE id = $1::bigint AND status = 'submitted'`,
        [checkId, status, reason === null ? null : reason.slice(0, 500)],
      )
      .catch((error: unknown) =>
        this.#logger.error(
          `could not record the outcome of identity check ${checkId}: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
  }

  /**
   * WHAT TO TELL A CUSTOMER THE RAIL WANTS IDENTIFIED — from the last time
   * they gave their details, if they have.
   *
   * Still being matched: "your account is being opened". Refused: "those
   * details did not match", so the form comes back with a reason rather than
   * blank. Never given, or given so long ago nothing answered: the form.
   */
  async #identityAnswer(userId: string, rail: string): Promise<HttpException> {
    let last: { status: string; fresh: boolean } | undefined;
    try {
      const found = await this.pool.query<{ status: string; fresh: boolean }>(
        `SELECT status, created_at > now() - $3::interval AS fresh
           FROM account_identity_checks
          WHERE user_id = $1::bigint AND provider = $2
          ORDER BY id DESC LIMIT 1`,
        [userId, rail, IDENTITY_IN_FLIGHT],
      );
      last = found.rows[0];
    } catch (error) {
      // A deployment behind 089 has no record to read; the form is still the
      // right answer, and submitting it names the missing migration.
      if (!isMissingSchema(error)) throw error;
    }
    if (last?.status === 'failed') {
      return new UnprocessableEntityException({ error: 'account_identity_failed' });
    }
    if (last !== undefined && last.fresh) {
      return new ServiceUnavailableException({ error: 'account_issue_pending' });
    }
    return new UnprocessableEntityException({ error: 'account_identity_required' });
  }

  /**
   * "CUSTOMER HAS NOT BEEN IDENTIFIED" IS ASKED AGAIN, NOT HANDED TO THE
   * CUSTOMER AS A BVN FORM.
   *
   * The owner's report is that Paystack opens naira accounts without a BVN —
   * accounts exist in production that were opened that way — and the
   * reference plugin's flow is what did it: on any refusal it scheduled a
   * poll that asked `POST /dedicated_account` again for about fifteen
   * minutes. This used to answer the first refusal with the BVN and bank
   * form, which the owner does not want customers to see and which was the
   * only thing between a new customer and the account they signed up for.
   *
   * So the first answer is "being opened" and the asking carries on in the
   * background, on the plugin's schedule (`accountRetryDelaysMs`); the screen
   * already asks again every few seconds while it says that. ONLY WHEN THE
   * WHOLE SCHEDULE HAS BEEN REFUSED does the customer get the form, and the
   * refusal is then written to `account_refusals` — a rail that refuses for
   * fifteen minutes is something an operator has to see, which a first
   * refusal is not.
   *
   * A customer who has already given their details is told the answer to
   * that, as before, and no schedule is started on top of it.
   */
  async #notYetIdentified(
    userUuid: string,
    userId: string,
    rail: string,
    currency: Currency,
    error: unknown,
  ): Promise<HttpException> {
    const given = await this.#identityAnswer(userId, rail);
    if (given.getStatus() !== HttpStatus.UNPROCESSABLE_ENTITY || this.#identityGiven(given)) {
      return given;
    }

    const delays = this.config.accountRetryDelaysMs;
    let state = this.#retrying.get(userId);
    if (state?.exhaustedAt !== undefined && Date.now() - state.exhaustedAt > RETRY_AGAIN_AFTER_MS) {
      state = undefined;
    }
    if (state === undefined) {
      state = { attempt: 0, timer: undefined, exhaustedAt: undefined };
      this.#retrying.set(userId, state);
    }

    if (state.exhaustedAt !== undefined) return given;
    if (state.attempt >= delays.length) {
      state.exhaustedAt = Date.now();
      // An empty schedule asked nothing again, so there is nothing to report.
      if (delays.length === 0) return given;
      this.#recordRefusal(rail, currency, error);
      this.#logger.warn(
        `${rail} refused to open a ${currency} account for user ${userId} on every one of ` +
          `${delays.length} attempts (${error instanceof Error ? error.message : String(error)}); ` +
          `the customer is now offered the identity form`,
      );
      return given;
    }

    if (state.timer === undefined) {
      const delay = delays[state.attempt] as number;
      const current = state;
      current.timer = setTimeout(() => {
        current.timer = undefined;
        current.attempt += 1;
        this.#openAccount(userUuid)
          .then(() => {
            this.#retrying.delete(userId);
            this.#logger.log(
              `opened a ${currency} account for user ${userId} on ${rail} at attempt ${current.attempt + 1}`,
            );
          })
          .catch(() => {
            // Another refusal schedules the next attempt itself; anything
            // else is the customer's next visit to find out.
          });
      }, delay);
      current.timer.unref?.();
    }
    return new ServiceUnavailableException({ error: 'account_issue_pending' });
  }

  /** The form refused before ("did not match") is an answer about details given. */
  #identityGiven(answer: HttpException): boolean {
    const body = answer.getResponse() as { error?: unknown };
    return body.error === 'account_identity_failed';
  }

  onModuleDestroy(): void {
    for (const state of this.#retrying.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    this.#retrying.clear();
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
        /*
         * "IDENTIFY THIS CUSTOMER FIRST" IS A QUESTION, NOT A REFUSAL — and it
         * is the rail the owner assigned asking it, so no other rail is tried
         * (089). The customer is asked for the BVN and bank account the rail
         * wants, or told the answer to the last time they gave them. Not
         * written to `account_refusals`: it is not a fault an operator can
         * fix, and recording it put every new customer on the diagnostics
         * screen as though something had broken.
         */
        if (isIdentityRequired(error)) {
          throw await this.#notYetIdentified(userUuid, userId, rail, currency, error);
        }
        this.#recordRefusal(rail, currency, error);
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

    return this.#record(userId, issued, currency);
  }

  /**
   * WRITES THE ACCOUNT A RAIL OPENED, and answers the row — shared by the
   * ordinary open and the identified one, so there is one INSERT and one
   * race resolution rather than two copies that drift.
   */
  async #record(
    userId: string,
    issued: VirtualAccount,
    currency: Currency,
  ): Promise<VirtualAccountView> {
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
   * WRITES DOWN WHY A RAIL SAID NO, where an operator can read it (082).
   *
   * The log line below was the only record, and on a deployment nobody can
   * page back through, a customer was told "this one is on us to fix — we
   * have been told" while nothing anybody could open said what we had been
   * told. `/admin/diagnostics` reads these rows.
   *
   * A refusal, a request that never left and an answer we could not read are
   * recorded; a timeout and a pending assignment are not, because neither is
   * a reason — the first may have worked and the second has.
   *
   * FIRE-AND-FORGET, and every error swallowed: recording why a customer was
   * refused must never become a second failure on top of the refusal, and a
   * deployment behind 082 simply has nowhere to write. No customer is
   * passed, because the row names none.
   */
  #recordRefusal(rail: string, currency: Currency, error: unknown): void {
    if (
      !(error instanceof ProviderRejectedError) &&
      !(error instanceof ProviderContractError) &&
      !(error instanceof ProviderUnavailableError)
    ) {
      return;
    }
    const code = error instanceof ProviderRejectedError ? (error.providerCode ?? null) : error.name;
    this.pool
      .query(`SELECT record_account_refusal($1, $2, $3, $4)`, [
        rail,
        currency,
        code,
        error.message,
      ])
      .catch(() => undefined);
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
      throw new ConflictException({ error: 'profile_incomplete', field: 'email', fields: ['email'] });
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
