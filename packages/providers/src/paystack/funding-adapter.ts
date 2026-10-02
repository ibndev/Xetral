import { z } from 'zod';
import {
  ProviderContractError,
  ProviderPendingError,
  ProviderRejectedError,
} from '../ports/errors.js';
import {
  PAYSTACK_ENDPOINTS,
  isIdentityRequiredRefusal,
  isStaleCustomerRefusal,
  type PaystackClient,
} from './client.js';
import type {
  AccountDeactivationCapable,
  AccountIdentityCapable,
  DepositLookup,
  CreateVirtualAccountRequest,
  FundingPort,
  IdentityBank,
  ProviderDeposit,
  VirtualAccount,
} from '../ports/funding.js';
import { depositToKobo } from '../bitnob/ngn-amounts.js';

const PROVIDER = 'paystack';

/**
 * Paystack dedicated virtual accounts.
 *
 * THE REASON THIS EXISTS is that Bitnob will not open a naira account for
 * anybody it has not already verified a BVN for, and that is the wrong gate
 * on the screen a customer opens in order to put money in. CBN's tiered KYC
 * permits a tier 1 account on a name and a phone number, capped — and
 * `029_kyc_tiers.seed.sql` has capped tier 0 at ₦50,000 a day since it
 * landed. So the policy the platform already enforces and the account it
 * could actually issue had drifted apart, and this closes that.
 *
 * ISSUING IS TWO CALLS, and only the first is about identity:
 *
 *   POST /customer            name, email, phone -> customer_code
 *   POST /dedicated_account   customer_code      -> a NUBAN
 *
 * Neither is a KYC step — ON A BUSINESS PAYSTACK DOES NOT MAKE IDENTIFY ITS
 * CUSTOMERS. On one it does (Betting, Financial Services, General Services),
 * the second call answers HTTP 400 "Customer has not been identified", and
 * production recorded exactly that for every new customer. That refusal is
 * relayed as `identity_required`, the customer is asked for a BVN and a bank
 * account on it, and the request comes back with `identity` set:
 *
 *   POST /dedicated_account/assign   email, names, phone, bvn, bank, account
 *                                    -> "in progress"; the number arrives on
 *                                       `dedicatedaccount.assign.success`
 *
 * Paystack matches the BVN to the account itself. Nothing here decides
 * whether they match, and nothing here keeps the BVN.
 */

/**
 * Paystack's response envelope. Every body carries `status` and `message`
 * alongside `data`, and a refusal arrives as a 200 with `status: false` —
 * handled in the client, so anything reaching here has real `data`.
 */
const customerResponse = z.object({
  data: z.object({
    customer_code: z.string().min(1),
    id: z.union([z.string(), z.number()]).optional(),
    /*
     * WHAT THE RECORD ACTUALLY HOLDS, read rather than assumed. For an email
     * Paystack already knows, `POST /customer` answers the EXISTING record —
     * and one a checkout created from an email alone has none of these.
     */
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    phone: z.string().nullish(),
  }),
});

/*
 * `account_number` IS OPTIONAL HERE, AND THAT IS NOT LAXITY.
 *
 * Paystack assigns a NUBAN ASYNCHRONOUSLY. `POST /dedicated_account` succeeds
 * and answers a customer record whose account is not yet attached; the number
 * arrives moments later, on the `dedicatedaccount.assign.success` webhook or
 * on the next read. Requiring it here turned that ordinary, documented case
 * into `ProviderContractError` — which this service reports as "their API has
 * changed, waiting will not fix it", the opposite of the truth.
 *
 * So the schema accepts the shape they actually send, and the ABSENCE of a
 * number is decided one level up, where the answer is "check back in a
 * moment" rather than "something is broken".
 */
const dedicatedAccountResponse = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    account_number: z.string().min(1).optional(),
    account_name: z.string().min(1).optional(),
    bank: z.object({ name: z.string().min(1) }).optional(),
    active: z.boolean().optional(),
    currency: z.string().optional(),
  }),
});

const dedicatedAccountListResponse = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      account_number: z.string().min(1),
      account_name: z.string().min(1),
      bank: z.object({ name: z.string().min(1) }),
      active: z.boolean().optional(),
    }),
  ),
});

/**
 * WHAT A TEST INTEGRATION ISSUES, AND THE ONLY THING IT WILL ISSUE.
 *
 * Paystack's test domain has one NUBAN provider. Naming `wema-bank` on a
 * `sk_test_…` key is refused with a message about the bank, which reads as a
 * wrong SETTING — and an operator who then "corrects" the setting has broken
 * the live configuration in order to fix the test one. The key already says
 * which environment this is, so the adapter answers it rather than asking
 * somebody to keep two settings in step.
 */
const TEST_PREFERRED_BANK = 'test-bank';

/** The live provider asked for when the setting is empty and Paystack lists it. */
const DEFAULT_LIVE_BANK = 'wema-bank';

const bankListResponse = z.object({
  data: z.array(
    z.object({
      name: z.string().min(1),
      code: z.string().min(1),
      type: z.string().nullish(),
      active: z.boolean().nullish(),
    }),
  ),
});

const transactionListResponse = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      reference: z.string().min(1),
      channel: z.string().nullish(),
      /** Left `unknown` and narrowed by `depositToKobo`. A `z.number()` here
       *  would accept a value JSON.parse has already rounded and hand it on
       *  looking valid — and this one becomes a customer's balance. */
      amount: z.unknown(),
      currency: z.string().optional(),
      status: z.string().optional(),
      paid_at: z.string().nullish(),
      created_at: z.string().nullish(),
      authorization: z
        .object({
          sender_bank: z.string().nullish(),
          account_name: z.string().nullish(),
          sender_bank_account_number: z.string().nullish(),
        })
        .nullish(),
    }),
  ),
});

export interface PaystackFundingOptions {
  readonly client: PaystackClient;
  /**
   * Which bank Paystack should issue the NUBAN at.
   *
   * A DEPLOYMENT VALUE, not a constant, because the answer differs by account:
   * Paystack's test integrations issue Titan accounts and live ones are
   * usually Wema, and a business can be enabled for one and not the other.
   * Hardcoding either would make a correct configuration fail with a message
   * about a bank nobody chose.
   */
  /**
   * WHICH BANK PAYSTACK ISSUES THE NUBAN AT, as a value or a resolver.
   *
   * A RESOLVER, because this used to be read ONCE at construction from the
   * environment — while `044_paystack_funding.sql` seeds a
   * `paystack_preferred_bank` SETTING, the dashboard offers a box for it, and
   * GO-LIVE tells an operator to decide it. Nothing read that setting. An
   * operator who filled the box changed nothing, and on a live integration
   * with more than one NUBAN provider Paystack refuses a create that names no
   * preferred bank — so "we configured everything" and "Activate Account
   * fails" were both true at once.
   *
   * That is the failure `kill-switches.test.ts` exists to prevent, in a
   * different table: a filled box on an operations screen reads as a thing
   * that is running.
   */
  readonly preferredBank: string | undefined | (() => Promise<string | undefined>);
}

export class PaystackFundingAdapter
  implements FundingPort, AccountIdentityCapable, AccountDeactivationCapable
{
  readonly provider = PROVIDER;

  readonly #client: PaystackClient;
  readonly #preferredBank: string | undefined | (() => Promise<string | undefined>);

  constructor(options: PaystackFundingOptions) {
    this.#client = options.client;
    this.#preferredBank = options.preferredBank;
  }

  async createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    if (request.currency !== 'NGN') {
      // The rail is Nigerian. Failing here beats issuing a naira account and
      // labelling it something else.
      throw new ProviderContractError(
        PROVIDER,
        `dedicated accounts on this rail are NGN; got ${request.currency}`,
      );
    }

    if (request.identity !== undefined) return this.#assign(request, request.identity);
    const customer = await this.#customerCode(request);
    if (customer.incomplete) await this.#completeCustomer(request, customer.code);
    return this.#issue(request, customer.code, true);
  }

  /**
   * CREATE, IDENTIFY AND ASSIGN, for a business Paystack requires to identify
   * its customers.
   *
   * ONE CALL, AND IT ANSWERS "IN PROGRESS". Paystack validates the BVN
   * against the bank account asynchronously and then assigns the number;
   * both outcomes arrive by webhook, and the next read of this customer's
   * accounts finds the number through the look-before-create in `#issue`. So
   * a successful call here is `ProviderPendingError` — the code the apps
   * already render as "your account is being opened" — never a success
   * without a number.
   *
   * NOT RETRIED, AND NOT PRECEDED BY A GUESS. Paystack keys this on the email
   * address, so a customer a checkout already created is updated rather than
   * duplicated; and an account already assigned is looked for first, where we
   * know the customer code, so a second submission does not ask for a second
   * number.
   */
  async #assign(
    request: CreateVirtualAccountRequest,
    identity: NonNullable<CreateVirtualAccountRequest['identity']>,
  ): Promise<VirtualAccount> {
    const known = request.customer.providerCustomerId;
    if (known !== undefined && known !== '') {
      const existing = await this.#existingAccount(known);
      if (existing !== undefined) return existing;
    }

    /*
     * PAYSTACK REQUIRES A PHONE NUMBER HERE, where `POST /dedicated_account`
     * did not. Refused before anything is sent — with nothing sent, so the
     * caller may ask the customer for one — rather than by Paystack in a
     * sentence that would read as a problem with the BVN.
     */
    const phone = request.customer.phone;
    if (phone === undefined || phone === '') {
      throw new ProviderRejectedError(
        PROVIDER,
        'Paystack assigns an identified account only with a phone number, and this customer has none.',
        'phone_required',
      );
    }

    const preferredBank = (await this.#bankToAskFor()) ?? (await this.#firstApprovedBank());
    if (preferredBank === undefined) {
      /*
       * `preferred_bank` is REQUIRED on this call and optional on the other.
       * With the setting empty and Paystack naming no provider we can use,
       * there is no bank to ask for — an operator's problem, said in the
       * operator's words and sent nowhere.
       */
      throw new ProviderRejectedError(
        PROVIDER,
        'paystack_preferred_bank is empty and Paystack named no NUBAN provider for this ' +
          'integration, so there is no bank to assign an identified account at.',
        'preferred_bank_unset',
      );
    }

    await this.#client.request('POST', PAYSTACK_ENDPOINTS.assignDedicatedAccount, {
      email: request.customer.email,
      first_name: request.customer.firstName,
      last_name: request.customer.lastName,
      phone,
      preferred_bank: preferredBank,
      country: 'NG',
      bvn: identity.bvn,
      bank_code: identity.bankCode,
      account_number: identity.accountNumber,
    });

    throw new ProviderPendingError(
      PROVIDER,
      'Paystack is matching the BVN to the bank account and will assign the number when it ' +
        'has; the outcome arrives on dedicatedaccount.assign.success or .failed.',
    );
  }

  /**
   * THE BANKS A CUSTOMER MAY NAME on the identity form — Paystack's own
   * Nigerian list, so the code that goes to `/dedicated_account/assign` is one
   * Paystack issued. Filtered as the payout adapter filters it: a mobile
   * money wallet or an inactive entry cannot hold an account on a BVN.
   */
  async identityBanks(): Promise<readonly IdentityBank[]> {
    const payload = await this.#client.request('GET', PAYSTACK_ENDPOINTS.banks('nigeria', 'NGN'));
    const parsed = bankListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `bank list does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    // The same bank can appear twice under one code; one row each is enough
    // to choose from, and a doubled row reads as two different banks.
    const seen = new Set<string>();
    return parsed.data.data
      .filter((bank) => bank.active !== false && (bank.type ?? 'nuban') === 'nuban')
      .filter((bank) => {
        const key = `${bank.code}\u0000${bank.name.trim().toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((bank) => ({ code: bank.code, name: bank.name }));
  }

  /**
   * The first NUBAN provider Paystack says this integration may name, when
   * the operator named none.
   *
   * NOT A GUESS: it is Paystack's own list of banks this business is approved
   * for, and any of them is a valid answer. The setting still wins wherever
   * it is filled in — this only stops an empty box from refusing every
   * customer on the one call where the bank is required.
   *
   * WEMA FIRST WHERE IT IS ON THE LIST, because it is what the reference
   * plugin names by default on a live key and the bank its accounts were
   * opened at; otherwise the first Paystack lists.
   */
  async #firstApprovedBank(): Promise<string | undefined> {
    try {
      const payload = (await this.#client.request(
        'GET',
        PAYSTACK_ENDPOINTS.dedicatedAccountProviders,
      )) as { data?: unknown };
      if (!Array.isArray(payload.data)) return undefined;
      const slugs = payload.data
        .map((row) => (row as { provider_slug?: unknown } | null)?.provider_slug)
        .filter((slug): slug is string => typeof slug === 'string' && slug !== '');
      return slugs.includes(DEFAULT_LIVE_BANK) ? DEFAULT_LIVE_BANK : slugs[0];
    } catch {
      return undefined;
    }
  }

  /**
   * One attempt at issuing, with ONE retry reserved for a stale customer code.
   *
   * `mayRetry` is what stops that being a loop: a second domain refusal after
   * we have already minted a fresh customer is a real refusal about the
   * credential, not about the code, and asking a third time would hide it.
   */
  async #issue(
    request: CreateVirtualAccountRequest,
    customerCode: string,
    mayRetry: boolean,
  ): Promise<VirtualAccount> {
    /*
     * ALREADY ISSUED? ASK BEFORE CREATING.
     *
     * Our own unique index on (user, currency) is what actually guarantees one
     * account per customer, and it holds whatever happens here. This is the
     * other half: a retry after a timeout must not leave a SECOND account
     * number live at Paystack, receiving money against a row we never wrote
     * and nobody is watching. `POST /dedicated_account` has no idempotency
     * key, so the only way to be safe is to look.
     */
    const existing = await this.#existingAccount(customerCode);
    if (existing !== undefined) return existing;

    /*
     * A BANK IS ALWAYS NAMED WHERE ONE CAN BE. The reference plugin — whose
     * accounts the owner has watched Paystack open without a BVN — sends
     * `preferred_bank` on every live request, `wema-bank` unless told
     * otherwise; this sent none when the setting was empty, and a live
     * integration approved for more than one provider then decides for
     * itself or refuses. The setting still wins; empty, Paystack's own list
     * of the providers this business may name answers (`#firstApprovedBank`).
     */
    const preferredBank = (await this.#bankToAskFor()) ?? (await this.#firstApprovedBank());

    let payload: unknown;
    try {
      payload = await this.#client.request(
        'POST',
        PAYSTACK_ENDPOINTS.createDedicatedAccount,
        {
          customer: customerCode,
          ...(preferredBank === undefined ? {} : { preferred_bank: preferredBank }),
          /*
           * THE NAME AND PHONE GO ON THIS CALL TOO, and their absence was
           * "Customer has not been identified". A Paystack customer is often
           * created FIRST by a checkout, from an email address alone; `POST
           * /customer` then answers that existing record without adding the
           * name or the number, and a dedicated account asked for against it
           * was refused. Paystack takes `first_name`, `last_name` and `phone`
           * here for exactly that case.
           */
          first_name: request.customer.firstName,
          last_name: request.customer.lastName,
          ...(request.customer.phone === undefined ? {} : { phone: request.customer.phone }),
        },
      );
    } catch (error) {
      /*
       * A CODE FROM THE OTHER DOMAIN IS DISCARDED AND THE CUSTOMER REMADE.
       *
       * This is the failure a deployment meets the day it swaps test keys for
       * live ones, and it looks exactly like a bad credential: every customer
       * who had already been through the flow is refused, for ever, while a
       * brand-new customer works. The stored code is what is invalid, not the
       * key — so the answer is to mint a fresh customer rather than to tell
       * an operator their live key is wrong.
       *
       * Only once, and only for this refusal.
       */
      if (
        mayRetry &&
        error instanceof ProviderRejectedError &&
        isStaleCustomerRefusal(error.message)
      ) {
        const fresh = await this.#createCustomer(request);
        if (fresh.incomplete) await this.#completeCustomer(request, fresh.code);
        return this.#issue(request, fresh.code, false);
      }
      /*
       * "CUSTOMER HAS NOT BEEN IDENTIFIED" IS A QUESTION FOR THE CUSTOMER, not
       * a failure. Given its own code so the service can ask them for the BVN
       * and bank account Paystack wants, instead of telling them the account
       * "could not be opened" — which is what every new customer read.
       */
      if (error instanceof ProviderRejectedError && isIdentityRequiredRefusal(error.message)) {
        throw new ProviderRejectedError(PROVIDER, error.message, 'identity_required', error);
      }
      throw error;
    }

    const account = this.#toAccount(payload, customerCode);
    if (account !== undefined) return account;

    /*
     * CREATED, NOT YET ASSIGNED.
     *
     * Paystack accepted the request and has not attached a number yet. That
     * is not a failure and must not be reported as one: `account_issue_pending`
     * is a code the apps already render as "your account is being opened,
     * check back in a moment", and the next call to this method finds the
     * account through the look-before-create above.
     *
     * Deliberately NOT polled here. A request holding a connection open while
     * a provider finishes an asynchronous job is how one slow afternoon at
     * Paystack becomes an exhausted pool, and the customer is on a screen
     * they can refresh.
     */
    throw new ProviderPendingError(
      PROVIDER,
      'Paystack accepted the request and has not attached an account number yet. ' +
        'It is assigned asynchronously and usually lands within a minute.',
    );
  }

  /**
   * The `preferred_bank` to send, or undefined to send none.
   *
   * On a TEST key this is always `test-bank`, whatever the setting says — see
   * `TEST_PREFERRED_BANK`. On a live key it is the operator's setting,
   * resolved PER CALL so a change during an incident does not wait on a
   * deploy; the rule 009 states, and the reason the credential resolver has
   * the same shape.
   */
  async #bankToAskFor(): Promise<string | undefined> {
    if (await this.#client.isTestKey()) return TEST_PREFERRED_BANK;

    const configured =
      typeof this.#preferredBank === 'function'
        ? await this.#preferredBank()
        : this.#preferredBank;

    return configured === undefined || configured === '' ? undefined : configured;
  }

  async getVirtualAccount(providerAccountId: string): Promise<VirtualAccount> {
    const account = this.#toAccount(
      await this.#client.request(
        'GET',
        PAYSTACK_ENDPOINTS.getDedicatedAccount(providerAccountId),
      ),
    );
    if (account === undefined) {
      // A re-read of an account we hold an id for that comes back with no
      // number is a real inconsistency, not the pending case: the id exists
      // because a number once did.
      throw new ProviderContractError(
        PROVIDER,
        `dedicated account ${providerAccountId} came back with no account number`,
      );
    }
    return account;
  }

  /**
   * Switches an issued number off — for resetting a whitelisted TEST account
   * only (see `AccountDeactivationCapable`).
   *
   * A 404 is the goal already met: an account Paystack no longer knows is not
   * one that will be handed back to the next registration. Everything else is
   * rethrown, so the reset refuses rather than leaving a live number our
   * closed row still holds.
   */
  async deactivateVirtualAccount(providerAccountId: string): Promise<void> {
    try {
      await this.#client.request(
        'DELETE',
        PAYSTACK_ENDPOINTS.deactivateDedicatedAccount(providerAccountId),
      );
    } catch (error) {
      if (error instanceof ProviderRejectedError && error.providerCode === 'http_404') return;
      throw error;
    }
  }

  /**
   * What Paystack recorded that no webhook told us about.
   *
   * Keyed on the CUSTOMER rather than the account, because Paystack's
   * transaction list is a customer-level query — and the account id we hold is
   * not accepted there. `providerAccountId` is therefore the customer code for
   * this adapter, which is stated here rather than assumed at the call site.
   */
  async listDeposits(account: DepositLookup): Promise<readonly ProviderDeposit[]> {
    /*
     * THE CUSTOMER CODE, NEVER THE ACCOUNT ID. The sweep used to pass the
     * dedicated-account id here, so every Paystack account was re-checked
     * against a customer that does not exist. An account opened before 044
     * recorded a code has nothing to ask about, and saying so is the honest
     * answer rather than a query on the wrong key.
     */
    const customerCode = account.providerCustomerRef;
    if (customerCode === undefined || customerCode === '') return [];

    const payload = await this.#client.request(
      'GET',
      PAYSTACK_ENDPOINTS.transactions(customerCode),
    );

    const parsed = transactionListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `transaction list does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    /*
     * ONLY MONEY THAT CAME INTO THE DEDICATED ACCOUNT.
     *
     * Paystack keys a customer on an EMAIL ADDRESS, so this list also holds
     * every card and bank checkout the same person paid — including topping
     * up their own wallet through their payment link, which is credited under
     * `paystack:link:<reference>`. Posted again here under
     * `paystack:<reference>` it is a DIFFERENT idempotency key, and the same
     * money is credited twice. The webhook has refused anything but
     * `dedicated_nuban` since 044; the sweep now asks the same question.
     */
    return parsed.data.data.filter((row) => row.channel === 'dedicated_nuban').map((row) => ({
      // THEIR reference, which is also what the webhook carries — so a late
      // delivery and this sweep produce the SAME ledger idempotency key and
      // the second one is a replay rather than a second credit. 013's
      // finding 4, which cost a double credit before it was understood.
      providerReference: row.reference,
      // Paystack is kobo throughout. Narrowed rather than trusted as a number.
      amountMinor: depositToKobo(row.amount, 'kobo'),
      currency: 'NGN' as const,
      senderName: row.authorization?.account_name ?? undefined,
      senderBank: row.authorization?.sender_bank ?? undefined,
      senderAccount: row.authorization?.sender_bank_account_number ?? undefined,
      occurredAt: new Date(row.paid_at ?? row.created_at ?? Date.now()),
    }));
  }

  /* ------------------------------------------------------------------ */

  /**
   * The customer at Paystack, created from what signup already holds.
   *
   * `providerCustomerId` is used when the platform already has one — a
   * customer who has been through this before, or whose mapping KYC wrote.
   * Otherwise a customer record is created, and that is NOT a regulatory step:
   * it is a name and an email address, and Paystack asks for nothing more.
   */
  async #customerCode(
    request: CreateVirtualAccountRequest,
  ): Promise<{ code: string; incomplete: boolean }> {
    const known = request.customer.providerCustomerId;
    // A code we hold was made by some earlier path — a checkout, a KYC
    // mapping — and what that record carries is not known here, so it is
    // completed rather than trusted.
    if (known !== undefined && known !== '') return { code: known, incomplete: true };
    return this.#createCustomer(request);
  }

  /**
   * THE NAME AND PHONE, ON THE CUSTOMER RECORD ITSELF, before an account is
   * asked for against it.
   *
   * The reference plugin creates the customer with `first_name`, `last_name`
   * and `phone` on every account it opens, and the owner has watched those
   * open without a BVN. Ours sent the same three — but `POST /customer`
   * against an email Paystack already holds answers the existing record
   * UNCHANGED, so a customer a payment link created from an email alone
   * stayed nameless and phoneless however often we asked, and the account
   * request against it was refused as "not identified".
   *
   * BEST EFFORT, and safe to repeat: an update moves no money and two of
   * them say the same thing. Paystack refuses to rename a customer it has
   * already validated ("can only be updated by a revalidation") — correct,
   * and a reason to carry on with the record as it is, not to fail.
   */
  async #completeCustomer(request: CreateVirtualAccountRequest, code: string): Promise<void> {
    try {
      await this.#client.request('PUT', PAYSTACK_ENDPOINTS.updateCustomer(code), {
        first_name: request.customer.firstName,
        last_name: request.customer.lastName,
        ...(request.customer.phone === undefined ? {} : { phone: request.customer.phone }),
      });
    } catch {
      // The account request that follows answers for the record either way.
    }
  }

  /** Creates one unconditionally. Separate so the stale-code path can remake
   *  a customer whose stored code belongs to the other Paystack domain. */
  async #createCustomer(
    request: CreateVirtualAccountRequest,
  ): Promise<{ code: string; incomplete: boolean }> {
    const payload = await this.#client.request('POST', PAYSTACK_ENDPOINTS.createCustomer, {
      email: request.customer.email,
      first_name: request.customer.firstName,
      last_name: request.customer.lastName,
      ...(request.customer.phone === undefined ? {} : { phone: request.customer.phone }),
      // Ours, so a Paystack dashboard row can be traced back without a lookup.
      metadata: { xetral_reference: request.customer.reference },
    });

    const parsed = customerResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `customer response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    const record = parsed.data.data;
    const blank = (v: string | null | undefined): boolean => v === undefined || v === null || v.trim() === '';
    return {
      code: record.customer_code,
      // Paystack answered with a record missing what we just sent: it already
      // had this email, and kept what it had.
      incomplete:
        blank(record.first_name) ||
        blank(record.last_name) ||
        (request.customer.phone !== undefined && blank(record.phone)),
    };
  }

  async #existingAccount(customerCode: string): Promise<VirtualAccount | undefined> {
    let payload: unknown;
    try {
      payload = await this.#client.request(
        'GET',
        PAYSTACK_ENDPOINTS.listDedicatedAccounts(customerCode),
      );
    } catch (error) {
      // A customer with no accounts can answer as a refusal rather than an
      // empty list. Not being able to look is not the same as there being
      // nothing to find, but the safe reading here is "carry on and create":
      // our own unique index still refuses a second row, and refusing to
      // issue because a LOOKUP failed would leave a customer with no way to
      // be paid over a query.
      if (error instanceof ProviderRejectedError) return undefined;
      throw error;
    }

    const parsed = dedicatedAccountListResponse.safeParse(payload);
    if (!parsed.success) return undefined;

    const live = parsed.data.data.find((row) => row.active !== false);
    if (live === undefined) return undefined;

    return {
      provider: PROVIDER,
      providerAccountId: String(live.id),
      providerCustomerRef: customerCode,
      accountNumber: live.account_number,
      bankName: live.bank.name,
      accountName: live.account_name,
      currency: 'NGN',
      active: live.active ?? true,
    };
  }

  /** The account, or undefined when Paystack has not attached a number yet. */
  #toAccount(payload: unknown, customerCode?: string): VirtualAccount | undefined {
    const parsed = dedicatedAccountResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `dedicated account does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    const account = parsed.data.data;
    if (
      account.account_number === undefined ||
      account.account_name === undefined ||
      account.bank === undefined ||
      account.id === undefined
    ) {
      return undefined;
    }
    return {
      provider: PROVIDER,
      providerAccountId: String(account.id),
      // Paystack keys its transaction list on the CUSTOMER, so the sweep that
      // finds a webhook which never arrived needs this and cannot run from
      // the account id. Absent on a re-read, where the caller already has it.
      providerCustomerRef: customerCode,
      accountNumber: account.account_number,
      bankName: account.bank.name,
      accountName: account.account_name,
      currency: 'NGN',
      // Absent means active: an account Paystack has just created and not
      // described is live, and reading silence as inactive would show a
      // customer a number their app tells them not to use.
      active: account.active ?? true,
    };
  }
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.')).join(', ');
}
