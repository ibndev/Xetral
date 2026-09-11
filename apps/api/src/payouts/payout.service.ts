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
import { ProviderError, ProviderRejectedError, ProviderTimeoutError } from '@xetral/providers';
import type { PayoutBank, PayoutPort, PayoutReceipt } from '@xetral/providers';
import { applyBasisPoints, fromMajor, money, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { DATABASE, LEDGER, PAYOUT_PORT } from '../tokens.js';
import { internationalDigits } from '../phone.js';
import { CountriesService } from '../countries/countries.service.js';
import type { LookupQuery, PayoutBody } from './dto.js';
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
  failure_reason: string | null;
  reserve_entry_id: string;
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
  ) {}

  /** Banks — or Mobile Money networks — a customer may send to. */
  async banks(country: string): Promise<readonly PayoutBank[]> {
    try {
      return await this.port.banks(country);
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
    );

    let receipt: PayoutReceipt;
    try {
      receipt = await this.port.send({
        country: destination.country,
        bankCode: destination.bank_code,
        accountNumber: destination.account_number,
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
      });
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        /*
         * WE DO NOT KNOW. Reversing would refund a transfer that may already
         * be in the beneficiary's account; retrying would send it twice. The
         * row stays `reserved` and the reconciliation sweep ASKS — the same
         * rule as a crypto withdrawal, a purchase and an FX swap, and here it
         * is the one that protects a customer from paying their landlord
         * twice.
         */
        this.#logger.warn(
          `payout ${reference} timed out; left reserved for reconciliation`,
        );
        return toView(await this.#reload(reserved.id));
      }
      // A definite refusal. Nothing left.
      await this.fail(reserved, describe(error));
      return refuseIfFailed(toView(await this.#reload(reserved.id)));
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
   * WHICH RAIL THIS IS COMES FROM THE COUNTRY, not from the bank code and not
   * from a list in this file. 046 put `payout_method` on `countries` precisely
   * so the SCREEN would stop offering a product the customer's money cannot
   * reach, and this is the server reading the same row — one source of truth
   * for one question, which is the rule this codebase keeps relearning.
   *
   * A BANK DESTINATION IS LEFT EXACTLY AS TYPED. A NUBAN has no dialling code
   * and no trunk zero to strip, and an account number beginning with a zero is
   * an ordinary account number.
   */
  async #destinationFor(body: PayoutBody): Promise<PayoutDestination> {
    const country = await this.countries.byCode(body.country);

    if (country?.payout_method !== 'mobile_money') {
      return {
        country: body.country,
        bank_code: body.bank_code,
        account_number: body.account_number,
        mobile_money: false,
      };
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
    };
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
  async lookupOrRefuse(body: LookupQuery): Promise<{ accountName: string }> {
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
          throw new NotFoundException({ error: 'name_unavailable' });
        }
        throw new NotFoundException({ error: 'account_not_found' });
      }
      throw this.#relay(error, 'looking up a beneficiary');
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
      await this.fail(row, receipt.failureReason ?? 'the provider did not say');
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
    const total = money(BigInt(row.amount_minor) + BigInt(row.fee_minor), currency);

    await this.ledger.post({
      idempotencyKey: `bank-payout-reverse:${row.reference}`,
      kind: 'reversal',
      reversesEntryId: row.reserve_entry_id,
      occurredAt: new Date(),
      description: 'bank payout failed',
      metadata: { reference: row.reference, reason },
      postings: [
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

  async #reserve(
    userId: string,
    body: PayoutBody,
    destination: PayoutDestination,
    beneficiary: { accountName: string } | undefined,
    reference: string,
    amount: Money<Currency>,
    split: { gross: Money<Currency>; tax: Money<Currency> },
    total: Money<Currency>,
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
      const precondition = await this.limits.precondition({
        userId,
        scope: 'transfer',
        amount: total,
        idempotencyKey: `bank-payout-reserve:${reference}`,
      });

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

    const banks = await this.port.banks(destination.country);
    const bankName =
      banks.find((bank: PayoutBank) => bank.code === destination.bank_code)?.name ??
      destination.bank_code;

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO bank_payouts
         (user_id, reference, idempotency_key, country, bank_code, bank_name,
          account_number, account_name, narration, currency, amount_minor,
          fee_minor, tax_minor, reserve_entry_id)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint,
               $12::bigint, $13::bigint, $14::bigint)
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
