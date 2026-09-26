import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import { ProviderError, ProviderRejectedError, providerDidNothing } from '@xetral/providers';
import type { PayoutBank, PayoutBranch, PayoutPort, PayoutReceipt } from '@xetral/providers';
import { applyBasisPoints, fromMajor, money, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { DATABASE, LEDGER, PAYOUT_PORT } from '../tokens.js';
import { internationalDigits } from '../phone.js';
import { CountriesService } from '../countries/countries.service.js';
import { PlatformFloatService } from './platform-float.service.js';
import { ProviderLiquidityService } from './provider-liquidity.service.js';
import type { BranchesQuery, LookupQuery, PayoutBody } from './dto.js';
import { AffordabilityService } from '../wallet/affordability.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from '../wallet/spending-limits.service.js';
import { TaxService } from '../tax/tax.service.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Sending money to somebody's bank account.
 *
 * THE SHAPE IS PHASE 9'S, and reusing it is the point rather than a shortcut.
 * A bank payout and an on-chain withdrawal ask the same question — money is
 * leaving, to somewhere we cannot reach into, through a provider that answers
 * slowly — so the order of operations is identical and so is the rule about a
 * timeout:
 *
 *   1. Look the beneficiary up. The BANK says who holds the account.
 *   2. Reserve amount + fee. The overdraft guard and the daily ceiling decide.
 *   3. Only then send.
 *
 * WHAT IS DIFFERENT is step 1, and it has no analogue anywhere else here. A
 * crypto address either checksums or does not; a bank account number that
 * passes every format check can still belong to a stranger. So the name shown
 * on the confirmation screen is the one the bank returned, it is stored on the
 * row, and it is what is sent to the provider — a confirmation against a name
 * the sender typed themselves confirms nothing.
 */

/** The rail a payout will leave on, and whether 073's ledger guard applies. */
interface PayoutRail {
  readonly provider: string;
  readonly ledgerGuard: boolean;
}

/**
 * WHERE A PAYOUT IS GOING, resolved once and used everywhere after.
 *
 * The point of this being a value rather than three arguments is that the
 * NORMALISED number and the rail it was normalised for travel together. A
 * function that took a country and a number separately could be handed the
 * national spelling and the mobile money flag by two different callers, which
 * is precisely how the row and the rail come to disagree about where money
 * went.
 */
interface PayoutDestination {
  readonly country: string;
  /** The destination branch, where the corridor requires one — Ghana today. */
  readonly branch_code?: string | undefined;
  readonly bank_code: string;
  /** Digits only. For a wallet this is the international form — `233…` — and
   *  never the trunk-zero spelling the customer typed. */
  readonly account_number: string;
  /** Whether this rail has a name enquiry at all. It does not. */
  readonly mobile_money: boolean;
}

export interface PayoutView {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly amount: string;
  readonly fee: string;
  readonly bank_name: string;
  readonly account_number: string;
  /**
   * Who the RAIL said holds this destination, or null where the rail has no
   * name enquiry at all — a mobile money wallet. Null is not "we failed to
   * look it up": it is "there is nothing to look up", and each app renders it
   * as the network rather than as a blank that reads like a bug.
   */
  readonly account_name: string | null;
  readonly narration: string | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
}

export interface PayoutRow {
  id: string;
  uuid: string;
  user_id: string;
  reference: string;
  status: string;
  country: string;
  bank_code: string;
  bank_name: string;
  account_number: string;
  account_name: string | null;
  narration: string | null;
  currency: string;
  amount_minor: string;
  fee_minor: string;
  tax_minor: string;
  provider_payout_id: string | null;
  /** WHICH RAIL SENT IT, immutable since 046. A payout id is opaque and only
   *  its issuer can resolve one. */
  provider: string;
  /** FALSE for a row written before 080, whose `provider` is only the
   *  column's default. Optional so a row read by an older SELECT is treated
   *  as the guess it may be. */
  provider_known?: boolean;
  failure_reason: string | null;
  reserve_entry_id: string;
  /**
   * The entry that moved the hold out to the provider, or null while the
   * payout is still merely reserved.
   *
   * IT IS WHAT DECIDES WHICH REVERSAL IS THE TRUE ONE — see `fail()`. Read
   * off the row rather than inferred from `status`, because those two are
   * written by different statements and the one that names an ENTRY is the
   * one the postings have to agree with.
   */
  settle_entry_id: string | null;
  created_at: Date;
}

/**
 * Ours, and DERIVED rather than generated.
 *
 * The reserve entry is posted before the payout row exists, so a crash in that
 * gap leaves a retry with no row to find. A derived reference makes the retry
 * reuse the same ledger idempotency key and the ledger answers `replayed:
 * true`; a random one pays twice, only under a crash — which is the hardest
 * double payment to reproduce and the easiest to ship. 004's finding 1, on the
 * flow where the money cannot be clawed back.
 */
export function payoutReferenceFor(userUuid: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userUuid}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  return `xetral-payout-${digest}`;
}

@Injectable()
export class PayoutService {
  readonly #logger = new Logger(PayoutService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(PAYOUT_PORT) private readonly port: PayoutPort,
    @Inject(AffordabilityService) private readonly affordability: AffordabilityService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SpendingLimitService) private readonly limits: SpendingLimitService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(CountriesService) private readonly countries: CountriesService,
    @Inject(PlatformFloatService) private readonly float: PlatformFloatService,
    @Inject(ProviderLiquidityService) private readonly liquidity: ProviderLiquidityService,
  ) {}

  /** Banks — or Mobile Money networks — a customer may send to. */
  async banks(country: string, method?: 'bank' | 'mobile_money'): Promise<readonly PayoutBank[]> {
    try {
      return await this.port.banks(country, method);
    } catch (error) {
      // See `#relay`. "The bank list could not be loaded" with a 500 behind it
      // is the exact shape 046 records: nothing broken except a credential
      // nobody had, and no way to learn that from either side of the screen.
      throw this.#relay(error, 'listing payout destinations');
    }
  }

  /**
   * Who the bank says holds this account.
   *
   * NO TRANSACTION PIN, deliberately, and for the reason raising a dispute
   * takes none: nothing is destroyed by asking, and the customer most likely
   * to check a name twice is one who is being careful. It IS rate limited, by
   * the ordinary authenticated ceiling — a lookup endpoint with no limit is a
   * way to walk a bank's account space and harvest names.
   */
  /**
   * THE SAME TRANSLATION `send` USES, AND THERE WERE TWO.
   *
   * This method — the one the SCREEN calls — collapsed every
   * `ProviderRejectedError` to `account_not_found`, while `lookupOrRefuse`
   * below, reached only from `send`, correctly told `name_unavailable` apart.
   *
   * THAT MEANT NOBODY IN GHANA OR KENYA COULD SEND MONEY AT ALL. A mobile
   * money wallet has no name enquiry, so the adapter refuses with
   * `name_unavailable` by design — and this turned that into "we could not
   * find that account". Both Send screens enable Review on
   * `beneficiary !== undefined || nameUnavailable`, so with the refusal
   * mislabelled the button never enabled, on the one screen a customer opens
   * to pay somebody. The rail was right, the adapter was right, the fact was
   * relayed as its opposite one layer up.
   *
   * One translation now. Two copies of "what a provider refusal means" is the
   * shape that put two recipient resolvers in this codebase, and the copy that
   * drifts is always the one fewer callers exercise.
   */
  async lookup(query: LookupQuery): Promise<{ account_name: string }> {
    const found = await this.lookupOrRefuse(query);
    return { account_name: found.accountName };
  }

  async list(userUuid: string): Promise<readonly PayoutView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE user_id = $1::bigint
        ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return rows.rows.map(toView);
  }

  /**
   * Send it.
   *
   * The provider call happens exactly once and only after the money is held.
   * Everything before it is the safety mechanism, because after it there is
   * nothing.
   */
  async send(userUuid: string, body: PayoutBody): Promise<PayoutView> {
    await this.settings.assertServiceEnabled('payouts');
    const userId = await this.#activeUserId(userUuid);
    const currency = body.currency as Currency;

    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return refuseIfFailed(toView(existing));

    const amount = this.#parseAmount(body.amount, currency);

    /*
     * THE NUMBER IS NORMALISED BEFORE ANYTHING ELSE READS IT, and every later
     * step uses the normalised one — the reservation, the row, and the rail.
     *
     * A Ghanaian types `0501234567` because that is how a number is written in
     * Accra. Flutterwave's transfers API takes `233501234567` and has no idea
     * what a trunk zero is, so the payout was refused at the rail with a
     * sentence about an invalid account. Doing this here rather than in the
     * adapter means the ROW records the number the money was actually sent
     * to — and `bank_payouts.account_number` is immutable, so a row saying
     * something the rail never saw could never be corrected.
     */
    const destination = await this.#destinationFor(body);

    /*
     * THE NAME IS RE-FETCHED WHERE THERE IS ONE TO FETCH, and is not taken
     * from the request.
     *
     * The client has already looked it up to show a confirmation screen, and
     * it would be easy to let it pass the answer back. That would make the
     * whole control a formality: anything a client sends is something an
     * attacker with a stolen session sends too, and the point of the lookup is
     * to produce a claim the sender did not author. One extra round trip
     * against a payment that cannot be recalled is not a cost worth saving.
     *
     * WHERE THERE IS NO SUCH CALL AT ALL, THIS IS UNDEFINED AND THE PAYOUT
     * PROCEEDS. That is the whole of the Ghana and Kenya fix: a mobile money
     * wallet has no name enquiry, `lookupOrRefuse` said so correctly, and
     * `send` treated its refusal as a reason not to send — so every cedi and
     * shilling payout was refused by us, before the rail was ever asked.
     * Requiring a claim that cannot exist is not a control; it is an outage.
     */
    const beneficiary = await this.#beneficiaryFor(destination);

    // The same basis-point fee a wallet transfer charges, applied to the same
    // shape. Rounded UP, stated at the call site, because every rounding
    // choice moves money to somebody and must be visible in review.
    const feeGross = applyBasisPoints(
      amount,
      await this.settings.transferFeeBasisPoints(),
      'up',
    );
    const split = await this.tax.splitFee(feeGross);
    const total = money(amount.amount + split.gross.amount, currency);

    /*
     * BEFORE the provider is asked, and it is not the pre-check CLAUDE.md
     * forbids — the overdraft guard still decides inside the ledger's own
     * transaction. This only refuses what the guard would certainly refuse,
     * and it does so without spending a round trip to reach an answer we
     * already hold. See AffordabilityService.
     */
    await this.affordability.assertWalletCanCover(userId, total);

    /*
     * READ ONCE, BEFORE THE MONEY IS HELD. A failure to read who is sending
     * must not happen between the reserve and the provider call, where the
     * money is committed and the recovery is a sweep.
     */
    const sender = await this.#senderFor(userId);

    /*
     * READ ONCE, not once per use. Two reads of one setting can disagree — the
     * cache expires between them — and the disagreement here would be a
     * payout whose `debit_currency` was decided by a race.
     */
    const debitCurrency = await this.settings.payoutDebitCurrency(currency);

    /*
     * THE RAIL IS CHOSEN ONCE, HERE, AND RECORDED ON THE ROW.
     *
     * The row's `provider` was never written — the INSERT did not name the
     * column, so every payout since 046 read `bitnob`, whoever sent it. The
     * status sweep and the `transfer.*` webhook both ask `row.provider`, so a
     * Flutterwave or Paystack payout was being asked about at Bitnob: on a
     * deployment without Bitnob that is a thrown error and a webhook retried
     * for ever, and with it, "no such payout". Choosing here and sending on
     * exactly this rail means what the row says and what happened cannot
     * differ.
     */
    const rail = await this.#payingRail(destination, amount, debitCurrency);

    const reference = payoutReferenceFor(userUuid, body.idempotency_key);
    const reserved = await this.#reserve(
      userId,
      body,
      destination,
      beneficiary,
      reference,
      amount,
      split,
      total,
      rail,
    );

    const request = {
      country: destination.country,
      bankCode: destination.bank_code,
      accountNumber: destination.account_number,
      /*
       * THE BRANCH, WHERE THE CORRIDOR REQUIRES ONE — Ghana, today.
       * Flutterwave refuses a Ghanaian transfer without it, which would
       * have made 070's new bank rail fail on every send.
       */
      ...(destination.branch_code === undefined
        ? {}
        : { branchCode: destination.branch_code }),
      /*
       * WHO SENT IT, because one corridor is refused without it.
       *
       * Kenya's M-PESA payout is treated as a cross-border remittance and
       * Flutterwave refuses it unless the originator is named — we sent no
       * `meta` at all, so every shilling transfer was rejected for a missing
       * required field before anything else about it was considered.
       *
       * It is the SENDING CUSTOMER and never the platform: a remittance
       * names the person the money came from, and naming ourselves would be
       * a false statement on a regulatory field.
       */
      ...(sender === undefined ? {} : { sender }),
      /*
       * WHICH OF OUR BALANCES FUNDS IT. Empty means the payout currency's
       * own float, which is the provider's default and keeps OUR published
       * spread as the price; a value here trades that float for somebody
       * else's conversion rate, which is why it is a setting an operator
       * types rather than an assumption this file makes.
       */
      ...(debitCurrency === undefined ? {} : { debitCurrency }),
      /*
       * WHAT THE RAIL TOLD US, or nothing. Never the sender's own text: a
       * confirmation against a name the sender typed confirms nothing while
       * looking exactly like one, which is 043's rule and the reason this
       * field is not on `payoutSchema` at all.
       */
      accountName: beneficiary?.accountName,
      amount,
      narration: body.narration,
      reference,
    };

    let receipt: PayoutReceipt;
    try {
      receipt =
        this.port.sendVia === undefined
          ? await this.port.send(request)
          : await this.port.sendVia(rail.provider, request);
    } catch (error) {
      if (providerDidNothing(error)) {
        // A refusal may well be for want of funds; the next read must not be
        // the cached one that said there were enough.
        this.liquidity.forget(rail.provider);
        // A definite answer: they refused it, or it never left. Nothing moved,
        // so the customer's money goes back now.
        await this.fail(reserved, describe(error));
        return refuseIfFailed(toView(await this.#reload(reserved.id)));
      }
      /*
       * WE DO NOT KNOW, and that is not only a timeout.
       *
       * A 502 from a gateway in front of their API, a connection reset after
       * the body was written, an answer we could not read, a transfer they
       * accepted and have not finished — after every one of those the
       * payment may already be in the beneficiary's account. This branch was
       * `ProviderTimeoutError` alone and everything else REVERSED, so any of
       * them refunded the customer for money that had left: the platform
       * paid twice, on the one flow where money cannot be recalled.
       *
       * Reversing would refund a transfer that may have arrived; retrying
       * would send it twice. The row stays `reserved`, the rail's own event
       * or the reconciliation sweep resolves it, and one nobody can resolve
       * is escalated to a person — the same rule as a crypto withdrawal, a
       * purchase and an FX swap.
       */
      this.#logger.warn(
        `payout ${reference}: outcome unknown (${describe(error)}); left reserved for reconciliation`,
      );
      return toView(await this.#reload(reserved.id));
    }

    await this.applyReceipt(await this.#reload(reserved.id), receipt);
    return refuseIfFailed(toView(await this.#reload(reserved.id)));
  }

  /**
   * The sending customer, as a remittance corridor requires them named.
   *
   * NOT THE PLATFORM. Flutterwave's Kenya payout asks for `sender`,
   * `sender_country` and `mobile_number` because the transfer is a
   * cross-border remittance and the originator has to be identifiable; naming
   * ourselves there would be a false statement on a regulatory field.
   *
   * UNDEFINED RATHER THAN A GUESS where the account holds no name or no
   * number. The adapter then omits the block, and the rails that do not ask
   * for it are unaffected — which is better than sending a placeholder to a
   * field somebody may one day report on.
   */
  async #senderFor(userId: string): Promise<
    { name: string; country: string; phone: string } | undefined
  > {
    const rows = await this.pool.query<{
      full_name: string | null;
      phone: string | null;
      country: string | null;
    }>(`SELECT full_name, phone, country FROM users WHERE id = $1::bigint`, [userId]);
    const row = rows.rows[0];
    if (row?.full_name == null || row.phone == null || row.country == null) {
      this.#logger.warn(
        'a payout is being sent with no originator details; a corridor that ' +
          'requires them will refuse it. The customer has no name, number or ' +
          'country on their account.',
      );
      return undefined;
    }
    return {
      name: row.full_name,
      country: row.country,
      // Digits only, the form every rail here takes on the wire.
      phone: row.phone.replace(/[^0-9]/g, ''),
    };
  }

  /**
   * WHERE THE MONEY IS GOING, in the spelling the rail accepts.
   *
   * A MOBILE MONEY DESTINATION IS A PHONE NUMBER, and a phone number is
   * written differently by the person holding it and by the API that reaches
   * it. `0501234567` in Accra is `233501234567` on Flutterwave's wire;
   * `0712345678` in Nairobi is `254712345678`. Sending the national spelling
   * is not a near miss — it is a number their transfers API cannot route, and
   * it comes back as a refusal about the account rather than about the format.
   *
   * WHICH RAIL THIS IS COMES FROM THE REQUEST NOW, AND IS CHECKED AGAINST THE
   * COUNTRY — which is 070 correcting 046 rather than reversing it.
   *
   * 046 put ONE value on `countries` so the SCREEN would stop offering a
   * product the customer's money cannot reach, and this method read the same
   * row. That was right while a country had one rail. Ghana and Kenya have
   * two: most people are paid into a wallet, plenty into a bank account, and
   * with one column the second was unreachable — worse, a bank account number
   * typed on a country marked `mobile_money` was REWRITTEN as a phone number
   * and sent to a wallet nobody holds.
   *
   * So the caller says which, and the country still decides what is allowed.
   * `payout_methods` is the set it offers; a rail outside it is refused here
   * rather than normalised the wrong way, because anything a client can send
   * a stolen session can send. An absent `method` means the country's default,
   * which is exactly what every caller written before 070 meant.
   *
   * A BANK DESTINATION IS LEFT EXACTLY AS TYPED. A NUBAN has no dialling code
   * and no trunk zero to strip, and an account number beginning with a zero is
   * an ordinary account number.
   */
  async #destinationFor(body: PayoutBody): Promise<PayoutDestination> {
    const country = await this.countries.byCode(body.country);
    const method = this.#railFor(country, body.method);

    if (method !== 'mobile_money') {
      return {
        country: body.country,
        bank_code: body.bank_code,
        account_number: body.account_number,
        mobile_money: false,
        ...(body.branch_code === undefined ? {} : { branch_code: body.branch_code }),
      };
    }

    /* `#railFor` can only answer `mobile_money` from a country row, so this is
       unreachable — stated rather than asserted, because a cast here would be
       the compiler being told something instead of asked. */
    if (country === undefined) {
      throw new UnprocessableEntityException({ error: 'country_not_supported' });
    }

    const msisdn = internationalDigits(country.dial_code, body.account_number);
    if (msisdn === undefined) {
      /*
       * REFUSED, NEVER SENT AS TYPED. This is the direction that cannot be
       * recalled, so a number we cannot put into the rail's own form is one
       * nobody should be able to send to — "we sent it to whatever you wrote"
       * is not a recovery story.
       */
      throw new BadRequestException({
        error: 'invalid_request',
        fields: ['account_number'],
      });
    }

    return {
      country: body.country,
      bank_code: body.bank_code,
      account_number: msisdn,
      mobile_money: true,
      ...(body.branch_code === undefined ? {} : { branch_code: body.branch_code }),
    };
  }

  /**
   * The rail a request means, refusing one the country does not offer.
   *
   * THE REFUSAL IS THE POINT. Normalisation follows from this answer, so a
   * rail chosen freely by a caller would let somebody post a bank account
   * number as `mobile_money` and have it rewritten into a phone number — in
   * the direction that cannot be recalled. The country's own `payout_methods`
   * is the whole of what is permitted.
   *
   * UNROUTED FALLS BACK TO THE COUNTRY'S DEFAULT rather than refusing, because
   * a deployment behind 070 has no `payout_methods` and every client that
   * predates it sends no `method` — and refusing there would turn one missing
   * column into an outage on the screen money leaves from. 059's argument
   * about an unrouted currency, applied to a migration rather than a corridor.
   */
  #railFor(
    country: { payout_method: string; payout_methods?: readonly string[] } | undefined,
    asked: 'bank' | 'mobile_money' | undefined,
  ): string {
    const fallback = country?.payout_method ?? 'bank';
    if (asked === undefined) return fallback;

    const offered = country?.payout_methods;
    if (offered === undefined || offered.length === 0) return fallback;
    if (!offered.includes(asked)) {
      throw new UnprocessableEntityException({ error: 'payout_method_not_supported' });
    }
    return asked;
  }

  /**
   * Who the rail says holds this destination, or nothing at all.
   *
   * A WALLET IS NOT ASKED ABOUT. There is no name enquiry on any mobile money
   * network — not a gap in one provider's coverage, a fact about the product —
   * so calling and translating a refusal we already know is coming is a round
   * trip that can only fail, on the screen money leaves from. The country's
   * `payout_method` already said which rail this is.
   *
   * A BANK IS ASKED, AND A REFUSAL THAT MEANS "NO SUCH NAME EXISTS" DOES NOT
   * STOP THE PAYOUT. Everything else does: an unknown account and an
   * unreachable bank still refuse, indistinguishably, which is 043's rule.
   */
  async #beneficiaryFor(
    destination: PayoutDestination,
  ): Promise<{ accountName: string } | undefined> {
    if (destination.mobile_money) return undefined;
    try {
      return await this.lookupOrRefuse({
        country: destination.country,
        bank_code: destination.bank_code,
        account_number: destination.account_number,
      });
    } catch (error) {
      if (
        error instanceof NotFoundException &&
        (error.getResponse() as { error?: string }).error === 'name_unavailable'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The lookup, refusing rather than guessing. Shared by the route and `send`.
   *
   * ONE REFUSAL IS TOLD APART FROM THE OTHERS, and only one. A MOBILE MONEY
   * WALLET HAS NO NAME ENQUIRY — there is no call to make, on any of these
   * rails, because the networks do not offer one. That is a fact about the
   * PRODUCT and not about the number, so saying it out loud leaks nothing
   * about which numbers exist, and a customer in Accra needs to hear it: the
   * alternative is a Send screen whose Review button never enables.
   *
   * Everything else stays deliberately indistinguishable. 043's rule holds:
   * "no such account" and "the bank did not answer" must read identically, or
   * the endpoint becomes a way to map which numbers are live at which bank one
   * request at a time.
   *
   * WHAT THIS DOES NOT DO is invent a name. The whole reason the beneficiary
   * is re-fetched rather than accepted from the request is that a name the
   * sender typed confirms nothing — so where the rail cannot answer, the
   * answer is an empty string and a screen that says so, never an echo.
   */
  /**
   * The branches of one bank, where the corridor requires one.
   *
   * `bankId` IS NOT `bank_code`. Flutterwave's bank list answers
   * `{ id, code, name }` and the branches path takes the ID — two different
   * values for one bank, and passing the code answers nothing. So this reads
   * the bank OUT of the list rather than trusting a caller to know the
   * difference, which also means a code this rail does not offer finds no bank
   * and answers an empty list rather than reaching the provider.
   *
   * EMPTY IS A VALID ANSWER, not a failure: only Ghana needs a branch code and
   * everywhere else the screen draws no picker. A provider that could not be
   * asked is relayed, because a bank list that cannot load is 046's fault and
   * this is the same screen.
   */
  async branches(query: BranchesQuery): Promise<readonly PayoutBranch[]> {
    try {
      const banks = await this.port.banks(query.country, 'bank');
      const bank = banks.find((b: PayoutBank) => b.code === query.bank_code);
      if (bank?.id === undefined || this.port.branches === undefined) return [];
      return await this.port.branches(query.country, bank.id);
    } catch (error) {
      throw this.#relay(error, 'listing bank branches');
    }
  }

  async lookupOrRefuse(body: LookupQuery): Promise<{ accountName: string }> {
    /* The method never reaches the adapter: it decides which CATALOGUE a code
       came from, and the adapter already tells a network code from a bank code
       by looking it up in its own table. It is on the query so a caller cannot
       be refused for sending it. */
    try {
      const found = await this.port.lookup(
        body.country,
        body.bank_code,
        body.account_number,
      );
      return { accountName: found.accountName };
    } catch (error) {
      if (error instanceof ProviderRejectedError) {
        if (error.providerCode === 'name_unavailable') {
          /*
           * TWO VERY DIFFERENT THINGS ARRIVE HERE, and only one of them is
           * fine.
           *
           * Kenya's M-PESA has no name enquiry at all — nothing was tried,
           * nothing failed, and recording it would fill an operator's screen
           * with a row a day about a product working exactly as designed.
           *
           * The other is a wallet resolver that WAS asked and refused every
           * attempt: a v4 credential that does not authorise, a malformed
           * field, a product not enabled on the account. That now degrades to
           * this same answer rather than blocking the corridor — which is the
           * right thing for the customer standing in Accra and would be
           * INVISIBLE if it were silent, because the send succeeds and nobody
           * ever learns the name lookup is broken.
           *
           * A TRAIL IS WHAT TELLS THEM APART. The adapter attaches `tried`
           * only when it actually called something, so recording on its
           * presence records the fault and not the design.
           */
          if (Array.isArray((error.cause as { tried?: unknown } | undefined)?.tried)) {
            await this.#recordRefusal(body, error);
          }
          throw new NotFoundException({ error: 'name_unavailable' });
        }
        /*
         * THE LINE THAT WAS MISSING FOR FOUR ROUNDS.
         *
         * A rejection landed here, became `account_not_found`, and NOTHING
         * WAS WRITTEN DOWN — `#relay` is the only thing on this method that
         * logs and this branch never reaches it. So Flutterwave's own sentence
         * about a Ghanaian mobile money number, the single fact that would
         * have ended "it says it cannot find the momo details", existed in no
         * log line, no table and no screen. Every round after that was
         * therefore a guess about a provider's behaviour, which is the failure
         * this repo already records twice about the Bitnob endpoint table.
         *
         * The customer's answer does not change — 043's rule is that an
         * unknown account and an unreachable bank must read identically, or
         * the endpoint maps which numbers are live where. What changes is that
         * the reason is now answerable.
         */
        await this.#recordRefusal(body, error);
        throw new NotFoundException({ error: 'account_not_found' });
      }
      throw this.#relay(error, 'looking up a beneficiary');
    }
  }

  /**
   * Write down why a name enquiry refused.
   *
   * BEST EFFORT, ALWAYS. A failure to record why a lookup failed must never
   * become a second failure on top of it — the rule `checkout_refusals`
   * already follows, and the reason `record_error` swallows everything.
   *
   * IT CARRIES NO NUMBER AND NO KEY. The adapter's trail holds the SHAPE that
   * was tried (`233…1133`) and the key's MODE, never the digits and never the
   * credential.
   */
  async #recordRefusal(body: LookupQuery, error: ProviderRejectedError): Promise<void> {
    const detail = error.cause as { keyMode?: unknown; tried?: unknown } | undefined;
    const keyMode =
      typeof detail?.keyMode === 'string' &&
      ['test', 'live', 'unset', 'unknown'].includes(detail.keyMode)
        ? detail.keyMode
        : 'unknown';
    const tried = Array.isArray(detail?.tried) ? detail.tried.join(' | ') : 'one shape';

    this.#logger.warn(
      `a name enquiry was refused by ${error.provider} for ${body.country}/` +
        `${body.bank_code} on a ${keyMode} key: ${error.message} [${tried}]`,
    );
    try {
      await this.pool.query(
        `SELECT record_name_enquiry_refusal($1, $2, $3, $4, $5, $6)`,
        [error.provider, body.country, body.bank_code, error.message, tried, keyMode],
      );
    } catch (cause) {
      this.#logger.warn(
        `could not record that name enquiry refusal: ${
          cause instanceof Error ? cause.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * A PROVIDER THAT COULD NOT BE ASKED IS NOT A BUG IN THIS APPLICATION, and
   * answering 500 said it was.
   *
   * An unconfigured key, an expired one, a rail whose transfers product is not
   * approved yet: each arrives as a `ProviderError` carrying the provider's
   * own sentence, and each fell through to a bare `internal_error` with a
   * reference. The customer read "something went wrong" and the operator read
   * a stack trace — on the screen money leaves from, about the one class of
   * failure an operator can actually fix.
   *
   * 006's rule, which the funding rail has followed since it was written and
   * this one never did: the provider's sentence goes to the LOG, because it
   * names our integration, and the customer gets a CODE their app turns into
   * words.
   */
  #relay(error: unknown, doing: string): never {
    if (!(error instanceof ProviderError)) throw error;
    this.#logger.error(
      `${doing} failed at the payout rail, so the customer saw a generic ` +
        `refusal: ${error.name}: ${error.message}`,
    );
    throw new ServiceUnavailableException(
      { error: 'payout_provider_unavailable' },
      { cause: error },
    );
  }

  /**
   * Records what the provider says happened.
   *
   * Shared by the request path and the reconciliation sweep, so both resolve a
   * payout the same way. Two copies of "how a payout settles" would drift, and
   * the copy that drifts is the one that only runs at 4am against money nobody
   * is watching — 006's finding 12.
   */
  async applyReceipt(row: PayoutRow, receipt: PayoutReceipt): Promise<void> {
    if (receipt.state === 'failed') {
      const reason = receipt.failureReason ?? 'the provider did not say';
      /*
       * THE RAIL'S OWN SENTENCE, IN THE LOG, FOR EVERY FAILED PAYOUT.
       *
       * Flutterwave's is `complete_message` and it is the only thing that
       * distinguishes "the wallet number does not exist" from "your balance
       * with us will not cover this" from "this network is down" — three
       * failures with three different remedies, one of which is ours and two
       * of which are not. Without it every one of them reads as "the transfer
       * did not go through", which is 006's rule mistaken for a reason to say
       * nothing anywhere: that rule keeps the provider's sentence away from
       * the CUSTOMER because it names our integration, and the place it
       * belongs is exactly here.
       *
       * It reaches `bank_payouts.failure_reason` and the customer's reversal
       * email as well — but a log line is what somebody has while the
       * customer is still on the phone.
       */
      this.#logger.warn(
        `payout ${row.reference} FAILED at ${row.bank_name} ` +
          `(${row.amount_minor} ${row.currency}, ${row.status}): ${reason}`,
      );
      await this.fail(row, reason);
      return;
    }

    if (row.status === 'reserved') {
      await this.#settle(row, receipt.providerPayoutId);
    }

    if (receipt.state === 'completed') {
      await this.pool.query(
        `UPDATE bank_payouts SET status = 'completed'
          WHERE id = $1::bigint AND status = 'sent'`,
        [row.id],
      );
    }
  }

  /**
   * WHAT A `transfer.*` WEBHOOK ACTUALLY DOES, and why it does so little.
   *
   * THE FAILURE THIS EXISTS FOR. `/v3/transfers` answers `NEW` or `PENDING`
   * on almost every real transfer — Flutterwave settles a mobile money payout
   * asynchronously — and this platform correctly records that as `sent`
   * rather than guessing. The outcome arrives later, on `transfer.completed`.
   * That event was parsed, its reference was read, and it was then handed to
   * the PAYMENT LINK settler, which quite rightly knows nothing about a
   * payout and acknowledged it. So the final status of every Ghanaian and
   * Kenyan transfer was delivered to us and thrown away: a failed payout
   * stayed `sent` for ever, the customer's money stayed with the provider,
   * and nothing but `PAYOUT_RECONCILE_INTERVAL_SECONDS` — which is off by
   * default — would ever ask.
   *
   * THE EVENT IS A DOORBELL, NOT A STATEMENT. Flutterwave does not sign the
   * body: `verif-hash` returns verbatim a string an operator typed into their
   * dashboard, so a valid header proves WHO rang and nothing about what they
   * said. Reading `status` and `complete_message` off the payload and acting
   * on them would let anybody holding that one shared secret mark a real
   * payout failed and have the money credited back to a wallet. So the
   * reference is the whole of what this trusts, and the outcome is re-read
   * from Flutterwave by `status()` — which returns `complete_message` anyway,
   * because it parses the same field from the same API.
   *
   * IT IS THE SAME `applyReceipt` THE SWEEP AND THE REQUEST PATH USE. Two
   * copies of "how a payout resolves" would be two sets of assumptions about
   * the ledger, and the copy that drifts is the one that only runs against a
   * webhook nobody is watching — 006's finding 12.
   */
  async resolveByReference(
    reference: string,
    transactionId?: string,
  ): Promise<'resolved' | 'held' | 'unknown'> {
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE reference = $1`,
      [reference],
    );
    const row = rows.rows[0];
    // NOT OURS. Flutterwave fires events for everything on the integration,
    // and refusing one would make them retry an event that will never become
    // a payout of ours — the rule the deposit handler already follows.
    if (row === undefined) return 'unknown';

    // Already decided. A redelivery must not reopen it, and `applyReceipt`
    // guards on `reserved` anyway — this just saves a provider call.
    if (row.status !== 'reserved' && row.status !== 'sent') return 'resolved';

    if (row.provider_payout_id === null) {
      /*
       * THE CASE THIS EVENT IS MOST OFTEN FOR. A send that timed out, or
       * came back as a 502, recorded no payout id — and it is exactly the
       * payout whose outcome only the rail's event will tell us.
       *
       * The event's transfer id is a CLAIM: the body is unsigned. So it is
       * only ever used to ASK, and the answer is accepted only if the
       * transfer the rail describes carries OUR reference. An id pointing at
       * some other real transfer settles nothing, because the reference that
       * decides comes from the provider's response and never from here.
       */
      if (transactionId === undefined) {
        this.#logger.warn(
          `payout ${reference}: a transfer event arrived with no transfer id and ` +
            `we recorded none; leaving it held for the sweep and a person`,
        );
        return 'held';
      }
      let found: PayoutReceipt | undefined;
      try {
        found = await this.askRail(row, transactionId, { requireReference: true });
      } catch (error) {
        // "No such transfer" is an answer about THEIR id, not about our
        // payout — the event may be forged or for another integration.
        if (!(error instanceof ProviderRejectedError)) throw error;
        this.#logger.warn(`payout ${reference}: transfer ${transactionId} is unknown to the rail; ignored`);
        return 'held';
      }
      if (found === undefined || found.reference !== row.reference) {
        this.#logger.warn(
          `payout ${reference}: the event named transfer ${transactionId}, which the ` +
            `rail says is ${found?.reference ?? 'unreferenced'}; ignored`,
        );
        return 'held';
      }
      await this.applyReceipt(row, found);
      return 'resolved';
    }

    // The rail that ISSUED the id, off the row — never the active one. 046
    // put `provider` on `bank_payouts` for exactly this.
    const receipt = await this.askRail(row, row.provider_payout_id);
    if (receipt === undefined || receipt.state === 'sent') return 'held';
    await this.applyReceipt(row, receipt);
    return 'resolved';
  }

  /**
   * WHAT THE RAIL THAT SENT A PAYOUT SAYS ABOUT IT — or undefined when no rail
   * can say so with evidence.
   *
   * A KNOWN RAIL is asked and believed, as since 046: its refusal propagates as
   * `ProviderRejectedError`, which the sweep reads as "no such payout" and
   * reverses. One thing is added — an answer carrying a reference that is not
   * ours is not an answer about this payout, whoever gave it.
   *
   * AN UNKNOWN RAIL — every row written before 080, whose `provider` is the
   * column default — is the dangerous case. Asking the recorded `bitnob` about
   * a Flutterwave transfer answers "no such payout", and reading THAT as a
   * refusal reverses money that has left. So every rail is asked, a refusal
   * from any of them decides nothing, and the only answer accepted is one that
   * carries OUR reference, read off the provider's own response. Nothing that
   * cannot show that is believed; the payout stays held for a person.
   */
  async askRail(
    row: Pick<PayoutRow, 'provider' | 'provider_known' | 'reference'>,
    providerPayoutId: string,
    options: { requireReference?: boolean } = {},
  ): Promise<PayoutReceipt | undefined> {
    const ours = (receipt: PayoutReceipt): boolean =>
      receipt.reference === undefined
        ? options.requireReference !== true
        : receipt.reference === row.reference;

    if (row.provider_known === true) {
      const receipt = await this.port.status(providerPayoutId, row.provider);
      return ours(receipt) ? receipt : undefined;
    }

    const switched = this.port as PayoutPort & { providers?: readonly string[] };
    const rails = [row.provider, ...(switched.providers ?? []).filter((p) => p !== row.provider)];
    for (const rail of rails) {
      try {
        const receipt = await this.port.status(providerPayoutId, rail);
        if (receipt.reference !== undefined && receipt.reference === row.reference) return receipt;
      } catch (error) {
        // A refusal from a rail that may never have seen this id is not an
        // outcome, and neither is a rail this deployment no longer builds.
        this.#logger.warn(
          `payout ${row.reference}: ${rail} could not describe ${providerPayoutId} ` +
            `(${describe(error)}); the row predates 080 so its rail is unknown`,
        );
      }
    }
    return undefined;
  }

  /**
   * The hold becomes a real payment: pending -> provider_float.
   *
   * The fee legs ride on the SAME entry, so a payout cannot exist without its
   * fee and a fee cannot exist without its payout. The tax is a LIABILITY and
   * never revenue — 032's rule, and both errors of getting it wrong point the
   * flattering way.
   */
  async #settle(row: PayoutRow, providerPayoutId: string): Promise<void> {
    const currency = row.currency as Currency;
    const amount = BigInt(row.amount_minor);
    const feeGross = BigInt(row.fee_minor);
    const taxMinor = BigInt(row.tax_minor);
    const feeNet = feeGross - taxMinor;

    const posted = await this.ledger.post({
      idempotencyKey: `bank-payout-settle:${row.reference}`,
      kind: 'wallet_withdrawal',
      occurredAt: new Date(),
      description: `bank payout to ${row.bank_name}`,
      metadata: { reference: row.reference, provider_payout_id: providerPayoutId },
      postings: [
        // The whole hold leaves pending...
        posting(pendingAccount(row.user_id, currency), money(-(amount + feeGross), currency)),
        // ...the payout goes to the provider...
        posting({ kind: 'provider_float', currency }, money(amount, currency)),
        // ...and the fee splits, but only where there is one. A zero-amount
        // posting is refused by the ledger, and a row saying zero is
        // indistinguishable from one somebody forgot to write.
        ...(feeNet > 0n
          ? [posting({ kind: 'revenue_fees', currency }, money(feeNet, currency))]
          : []),
        ...(taxMinor > 0n
          ? [posting({ kind: 'liability_tax_payable', currency }, money(taxMinor, currency))]
          : []),
      ],
    },
    {
      /*
       * THE RECEIPT IS WRITTEN ON THE ENTRY'S OWN TRANSACTION.
       *
       * Sending inside the transaction would mail a receipt for money that
       * then rolls back; enqueueing after it loses the message when the
       * process dies in the gap. A row written here has neither problem —
       * 012's rule, and `onEntry` is what makes it available. It must not
       * take a connection of its own: it is inside a transaction holding one,
       * and a second would deadlock the pool at `pool.max` writers.
       */
      onEntry: async (client, entry) => {
        const email = await this.#emailFor(client, row.user_id);
        if (email === undefined) return;
        await this.notifications.enqueueBestEffort(client, {
          userId: row.user_id,
          recipient: email,
          // The ledger key, reused. Inventing a second identity for the same
          // event is how the two drift apart under exactly the conditions
          // that make idempotency matter.
          idempotencyKey: `receipt:bank-payout-settle:${row.reference}`,
          request: {
            kind: 'transfer_sent',
            amount: toMajor(money(amount, currency)),
            currency,
            reference: entry.entryUuid,
          },
        });
      },
    });

    // Guarded on `status = 'reserved'`, so a redelivered receipt cannot move a
    // payout that has already settled.
    await this.pool.query(
      `UPDATE bank_payouts
          SET status = 'sent', provider_payout_id = $2, settle_entry_id = $3::bigint
        WHERE id = $1::bigint AND status = 'reserved'`,
      [row.id, providerPayoutId, posted.entryId],
    );

  }

  /** Reads on the entry's OWN connection — never taking one of its own, which
   *  inside a transaction holding one would deadlock the pool at `pool.max`. */
  async #emailFor(client: PoolClient, userId: string): Promise<string | undefined> {
    const rows = await client.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1::bigint`,
      [userId],
    );
    return rows.rows[0]?.email ?? undefined;
  }

  /**
   * Gives the money back by APPENDING a reversal naming the reservation.
   *
   * AND TELLS THE CUSTOMER, which is the half that was missing. The posting
   * has always been correct — the money leaves `customer_pending` and lands
   * back in the wallet, spendable — and nothing anywhere said so. What a
   * customer saw was a debit, then an unexplained credit some minutes or days
   * later, which reads as money having gone somewhere and come back by
   * accident. "It was deducted and never returned" is what that looks like
   * from the outside even when the ledger is right.
   */
  async fail(row: PayoutRow, reason: string): Promise<void> {
    const currency = row.currency as Currency;
    const amount = BigInt(row.amount_minor);
    const feeGross = BigInt(row.fee_minor);
    const taxMinor = BigInt(row.tax_minor);
    const feeNet = feeGross - taxMinor;
    const total = money(amount + feeGross, currency);

    /*
     * WHERE THE MONEY IS NOW DECIDES WHAT A REVERSAL LOOKS LIKE, and getting
     * this wrong is a hole in the books rather than a wrong screen.
     *
     * A RESERVED payout still has the whole hold in `customer_pending`, so
     * the reversal is the one this method always wrote: pending → wallet.
     *
     * A SENT one does not. `#settle` has already emptied pending — the payout
     * to `provider_float`, the fee to `revenue_fees`, the tax to
     * `liability_tax_payable` — so taking the total back out of pending posts
     * against money that is no longer there, drives a customer's pending
     * account negative and credits their wallet from nowhere. The entry
     * balances, so the ledger accepts it and `ledger_drift` reports nothing.
     *
     * AND THIS PATH IS NOT HYPOTHETICAL. 043 permits `sent -> failed`
     * deliberately, because a bank transfer really can be returned days
     * later; the reconciliation sweep claims `status IN ('reserved','sent')`
     * and calls this method on either; and a Flutterwave transfer is ASYNC —
     * their first answer is `NEW`, which this platform records as `sent`, and
     * the real outcome arrives later on `transfer.completed`. So the
     * commonest failure on the newest rail lands exactly here.
     *
     * The inverse of the settlement is therefore posted instead: the payout
     * comes back off the provider's float — which is what the platform holds
     * with them, so a failed cedi transfer returns a cedi of OUR liquidity as
     * well as the customer's money — and the fee and tax legs are unwound
     * with it, because a payout that never happened earned no fee and owes no
     * tax on one.
     */
    const settled = row.settle_entry_id !== null;

    await this.ledger.post({
      idempotencyKey: `bank-payout-reverse:${row.reference}`,
      kind: 'reversal',
      /*
       * THE ENTRY THIS ONE ACTS UPON — 023's words. For a settled payout that
       * is the settlement, not the reserve: naming the reserve would describe
       * an entry whose postings this one does not undo.
       */
      reversesEntryId: settled ? (row.settle_entry_id as string) : row.reserve_entry_id,
      occurredAt: new Date(),
      description: 'bank payout failed',
      metadata: { reference: row.reference, reason, reversed: settled ? 'settle' : 'reserve' },
      postings: settled
        ? [
            // Off the provider's float, which is where the settlement put it.
            posting({ kind: 'provider_float', currency }, money(-amount, currency)),
            // A payout that did not happen earned no fee...
            ...(feeNet > 0n
              ? [posting({ kind: 'revenue_fees', currency }, money(-feeNet, currency))]
              : []),
            // ...and owes no tax on a fee it did not earn.
            ...(taxMinor > 0n
              ? [
                  posting(
                    { kind: 'liability_tax_payable', currency },
                    money(-taxMinor, currency),
                  ),
                ]
              : []),
            posting(walletAccount(row.user_id, currency), total),
          ]
        : [
            posting(pendingAccount(row.user_id, currency), money(-total.amount, currency)),
            posting(walletAccount(row.user_id, currency), total),
          ],
    },
    {
      /*
       * ON THE REVERSAL'S OWN TRANSACTION, the rule 012 states and the same
       * hook the settlement uses. A message enqueued afterwards is lost when
       * the process dies in the gap — and the gap here is exactly the moment
       * a customer is watching a balance that has not moved yet. A message
       * enqueued inside would promise money back for an entry that then
       * rolls back.
       *
       * It must not take a connection of its own: it is inside a transaction
       * holding one, and a second would deadlock the pool at `pool.max`.
       */
      onEntry: async (client, entry) => {
        const email = await this.#emailFor(client, row.user_id);
        if (email === undefined) return;
        await this.notifications.enqueueBestEffort(client, {
          userId: row.user_id,
          recipient: email,
          // The ledger key, reused. A second identity for one event is how
          // the two drift apart under the conditions that make idempotency
          // matter — and a reversal is retried by the sweep by design.
          idempotencyKey: `receipt:bank-payout-reverse:${row.reference}`,
          request: {
            kind: 'transfer_reversed',
            amount: toMajor(total),
            currency,
            // The provider's own sentence. Without it "your transfer did not
            // go through" sends somebody to support to ask the question this
            // message could have answered.
            reason,
            reference: entry.entryUuid,
          },
        });
      },
    });

    await this.pool.query(
      `UPDATE bank_payouts SET status = 'failed', failure_reason = $2
        WHERE id = $1::bigint AND status IN ('reserved', 'sent')`,
      [row.id, reason],
    );
  }

  /* ------------------------------------------------------------------ */

  /**
   * WHICH RAIL PAYS THIS, and whether the ledger's own float guard still has
   * anything to say about it.
   *
   * THE RAIL IS ASKED WHAT IT HOLDS. The ledger's `provider_float` is one
   * account per currency for every provider together, so it reads naira
   * collected at Paystack, and cedis credited by a platform-priced conversion
   * that paid nobody, as held — while the rail that must pay them out has
   * none. So each candidate is asked in order, the routed one first, and the
   * first that can spend the amount is chosen.
   *
   * ONLY A WALLET MAY MOVE TO ANOTHER RAIL. A bank code came from the routed
   * rail's own list and means nothing to another provider; a mobile money
   * network code is OURS, and every adapter translates it by name. So a bank
   * payout is only ever asked of its one rail.
   *
   * AN UNREADABLE BALANCE CHOOSES THAT RAIL AND CHANGES NOTHING — the rail
   * itself still refuses, and the ledger guard still runs — because a balance
   * endpoint that is down must not become an outage on the screen money is
   * sent from. And it is NOT a pre-check in the sense CLAUDE.md forbids: the
   * customer's own balance is still decided by the overdraft guard inside the
   * ledger. Two payouts reading one balance can both pass; the rail refuses
   * the second, which reverses, exactly as it did before this existed.
   */
  /** Whether a rail's own per-transfer range admits this amount. No stated
   *  range admits everything: the platform's own ceilings still apply. */
  #withinLimits(provider: string, amount: Money<Currency>): boolean {
    const limit =
      this.port.limitsVia?.(provider, amount.currency) ??
      (this.port.provider === provider ? this.port.limits?.[amount.currency] : undefined);
    if (limit === undefined) return true;
    return amount.amount >= limit.minMinor && amount.amount <= limit.maxMinor;
  }

  async #payingRail(
    destination: PayoutDestination,
    amount: Money<Currency>,
    debitCurrency: string | undefined,
  ): Promise<PayoutRail> {
    const rails = (await this.port.railsFor?.(destination.country)) ?? [this.port.provider];
    const candidates = destination.mobile_money ? rails : rails.slice(0, 1);
    /*
     * A RAIL THAT CANNOT CARRY THIS AMOUNT IS NOT A CANDIDATE, and that is
     * known before anything is held. Bitnob's M-Pesa payout takes KSh 150 to
     * KSh 100,000 per transaction; asked for more, it refuses AFTER the
     * reserve, and the customer reads a failure as if their number were
     * wrong. So an out-of-range rail is passed over for the next, and where
     * none can carry it the customer is told, in words, before a kobo moves.
     */
    const eligible = candidates.filter((provider) => this.#withinLimits(provider, amount));
    if (eligible.length === 0) {
      throw new UnprocessableEntityException({ error: 'payout_amount_out_of_range' });
    }
    const funding = debitCurrency ?? amount.currency;
    const converted = funding !== amount.currency;

    const short: string[] = [];
    for (const provider of eligible) {
      const live = await this.liquidity.available(provider, funding);
      if (live === undefined) return { provider, ledgerGuard: !converted };
      /*
       * PAID FROM ANOTHER BALANCE AT THEIR RATE, the amount that balance must
       * cover is theirs to compute, so all this can say is whether there is
       * any. And the ledger's float in the PAYOUT currency is then not the
       * money being spent, so its guard stands down rather than refusing a
       * payout funded from somewhere it cannot see.
       */
      if (converted ? live > 0n : live >= amount.amount) {
        return { provider, ledgerGuard: false };
      }
      short.push(`${provider} can spend ${live} ${funding}`);
    }

    this.#logger.error(
      `PROVIDER BALANCE SHORTFALL: a ${amount.amount} ${amount.currency} payout to ` +
        `${destination.country} was refused before any money was held. ` +
        `${short.join('; ')} (minor units). Fund the ${funding} balance at the ` +
        `provider, or name another balance in payout_debit_currencies.`,
    );
    throw new ServiceUnavailableException({ error: 'insufficient_platform_liquidity' });
  }

  async #reserve(
    userId: string,
    body: PayoutBody,
    destination: PayoutDestination,
    beneficiary: { accountName: string } | undefined,
    reference: string,
    amount: Money<Currency>,
    split: { gross: Money<Currency>; tax: Money<Currency> },
    total: Money<Currency>,
    rail: PayoutRail,
  ): Promise<PayoutRow> {
    const currency = body.currency as Currency;

    let entryId: string;
    try {
      /*
       * The daily ceiling, as a PRECONDITION on the ledger's own transaction
       * under a per-customer advisory lock — never as a check around it. Two
       * payouts arriving together would otherwise each read the day's total,
       * each find room, and both leave.
       *
       * On the RESERVE, not the settle: by the time a payout settles it has
       * been sent, and refusing it would be a statement about money already
       * gone.
       */
      const limitCheck = await this.limits.precondition({
        userId,
        scope: 'transfer',
        amount: total,
        idempotencyKey: `bank-payout-reserve:${reference}`,
      });

      /*
       * AND CAN THE PLATFORM AFFORD IT? A second question, about a different
       * pot of money, asked in the same place and for the same reason.
       *
       * The daily ceiling protects the CUSTOMER's balance and this protects
       * OURS: Flutterwave is a prefunded wallet, so a cedi payout out of a
       * deployment holding no cedis is refused by them — with a message about
       * funds that reaches the app as a failure on a transfer whose customer,
       * amount and wallet number were all correct.
       *
       * On the RESERVE, like the ceiling, because that is the last moment
       * before the provider is asked. Whether the rail is prefunded is read
       * from the rail serving this destination rather than from a list of
       * provider names here — 046's rule that a fact about a rail is not a
       * `switch` in a service.
       */
      const floatCheck = await this.float.precondition({
        /* The SWITCH answers per country; a single adapter answers for
         * itself. A port with neither is not prefunded, which is the reading
         * the port's own note gives and the one that changes nothing for a
         * rail that never had this flag. */
        prefunded:
          rail.ledgerGuard &&
          ((await this.port.prefundedFor?.(destination.country)) ??
            this.port.prefunded === true),
        amount: total,
      });

      /*
       * ONE HOOK, because `post()` takes one — and composing them here rather
       * than teaching the ledger about a list keeps the ledger's contract the
       * single thing it already is. Order matters in one direction only: the
       * customer's own ceiling is checked FIRST, so a customer over their
       * limit is told that rather than told about our treasury, which is not
       * their business and not their problem.
       */
      const checks = [limitCheck, floatCheck].filter(
        (check): check is (client: PoolClient) => Promise<void> => check !== undefined,
      );
      const precondition =
        checks.length === 0
          ? undefined
          : async (client: PoolClient): Promise<void> => {
              for (const check of checks) await check(client);
            };

      const posted = await this.ledger.post(
        {
          idempotencyKey: `bank-payout-reserve:${reference}`,
          kind: 'wallet_withdrawal',
          occurredAt: new Date(),
          description: `bank payout reserved`,
          metadata: { reference, bank_code: body.bank_code },
          postings: [
            posting(walletAccount(userId, currency), money(-total.amount, currency)),
            posting(pendingAccount(userId, currency), total),
          ],
        },
        precondition === undefined ? {} : { precondition },
      );
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // NO FIGURE. Returning "you have ₦4,300" to a caller that asked to
        // send ₦5,000 turns this into a balance oracle for a stolen session.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }

    /* THE RIGHT CATALOGUE, or the name beside the code is wrong. A Ghanaian
       bank code looked up in the wallet list finds nothing and the row records
       the code as its own name — which is what an operator then reads. */
    const banks = await this.port.banks(
      destination.country,
      destination.mobile_money ? 'mobile_money' : 'bank',
    );
    const bankName =
      banks.find((bank: PayoutBank) => bank.code === destination.bank_code)?.name ??
      destination.bank_code;

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO bank_payouts
         (user_id, reference, idempotency_key, country, bank_code, bank_name,
          account_number, account_name, narration, currency, amount_minor,
          fee_minor, tax_minor, reserve_entry_id, payout_method, branch_code,
          provider)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint,
               $12::bigint, $13::bigint, $14::bigint, $15, $16, $17)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        reference,
        body.idempotency_key,
        destination.country,
        destination.bank_code,
        bankName,
        /*
         * THE NORMALISED NUMBER, which is the one the rail was given. The row
         * is immutable once written (043), so recording what the customer
         * typed rather than what was sent would leave a payout nobody could
         * reconcile against the provider.
         */
        destination.account_number,
        /*
         * NULL WHERE THE RAIL HAS NO NAME ENQUIRY, which 067 makes possible.
         * The absence is the honest record — nobody confirmed who holds this —
         * and it is what the receipt renders as "Mobile money wallet" rather
         * than as a name somebody might act on.
         */
        beneficiary?.accountName ?? null,
        body.narration ?? null,
        body.currency,
        amount.amount.toString(),
        split.gross.amount.toString(),
        split.tax.amount.toString(),
        entryId,
        /*
         * WHICH RAIL IT WENT OUT ON, recorded at the moment of sending and
         * immutable by trigger — like the provider since 046 and the
         * destination since 043. The number beside it was normalised FOR this
         * rail, so reading the rail off the country afterwards would make
         * every payout in flight unverifiable the instant an operator changed
         * what that country offers, and an unverifiable payout is one nothing
         * can settle or reverse.
         */
        destination.mobile_money ? 'mobile_money' : 'bank',
        /* PART OF THE DESTINATION, and immutable with it (043): the row
           records what the rail was GIVEN. Ghana refuses a transfer without
           one. */
        destination.branch_code ?? null,
        /* WHO WILL SEND IT, chosen before the reserve and the rail `send()`
           then uses — the column 046 added and nothing had ever written. */
        rail.provider,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return this.#reload(row.id);

    const raced = await this.#byKey(userId, body.idempotency_key);
    if (raced === undefined) throw new Error('payout insert returned no row');
    return raced;
  }

  #parseAmount(raw: string, currency: Currency): Money<Currency> {
    try {
      return fromMajor(raw, currency);
    } catch (cause) {
      throw new BadRequestException({
        error: 'invalid_amount',
        detail: cause instanceof Error ? cause.message : undefined,
      });
    }
  }

  async #activeUserId(userUuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE uuid = $1::uuid AND status = 'active'`,
      [userUuid],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });
    return row.id;
  }

  async #byKey(userId: string, key: string): Promise<PayoutRow | undefined> {
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE user_id = $1::bigint AND idempotency_key = $2`,
      [userId, key],
    );
    return rows.rows[0];
  }

  async #reload(id: string): Promise<PayoutRow> {
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE id = $1::bigint`,
      [id],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });
    return row;
  }
}

function walletAccount(userId: string, currency: Currency) {
  return { kind: 'customer_wallet' as const, ownerId: userId, currency };
}

function pendingAccount(userId: string, currency: Currency) {
  return { kind: 'customer_pending' as const, ownerId: userId, currency };
}

function toView(row: PayoutRow): PayoutView {
  const currency = row.currency as Currency;
  return {
    id: row.uuid,
    status: row.status,
    currency: row.currency,
    amount: toMajor(money(BigInt(row.amount_minor), currency)),
    fee: toMajor(money(BigInt(row.fee_minor), currency)),
    bank_name: row.bank_name,
    account_number: row.account_number,
    account_name: row.account_name,
    narration: row.narration,
    failure_reason: row.failure_reason,
    created_at: row.created_at.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'the provider refused';
}

/**
 * A PAYOUT THAT FAILED IS NOT A SUCCESSFUL REQUEST, and answering 201 with a
 * row saying `failed` is how both apps came to report one as sent.
 *
 * The service was already correct about the money: the provider refuses, the
 * reservation is reversed, and the customer's balance is whole again. What it
 * did was hand that back as an ordinary payout view — and both screens read
 * only the amount off it and said "Sent ₦5,000." So the customer saw a
 * success, saw nothing leave their balance, and saw nothing arrive at the
 * bank. Three true observations and no way to reconcile them.
 *
 * Refusing here fixes both clients at once, and it fixes the ones not written
 * yet, which a sentence in two screens does not.
 *
 * It is deliberately NOT applied to `reserved`. A payout we timed out on may
 * still be in flight — the row stays held and the sweep asks — so refusing it
 * would tell a customer their money is back when it is not. The screens say
 * "on its way" for that one.
 */
function refuseIfFailed(view: PayoutView): PayoutView {
  if (view.status !== 'failed') return view;
  /*
   * NO DETAIL. The provider's own sentence names our integration — "Paystack
   * is set to require an OTP for transfers" is exactly the shape of it — and
   * 006's rule is that such a sentence goes to the log and to the row an
   * operator reads, never to the customer. `bank_payouts.failure_reason` has
   * it, and the client turns the code into words a customer can act on.
   */
  throw new UnprocessableEntityException({ error: 'payout_failed' });
}
