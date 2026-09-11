import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import type { AccountRef, LedgerIntent, WrittenEntry } from '@xetral/ledger';
import { applyBasisPoints, CURRENCIES, fromMajor, isCurrency, subtract, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from './spending-limits.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { TaxService } from '../tax/tax.service.js';
import type { TransferRequest } from './dto.js';
import { RecipientService } from './recipient.service.js';

export interface TransferResult {
  readonly entry_id: string;
  readonly amount: string;
  readonly fee: string;
  readonly currency: string;
  readonly replayed: boolean;
}

export interface BalanceView {
  readonly currency: string;
  readonly spendable: string;
  readonly pending: string;
  readonly total: string;
  /** So a client can group fiat and crypto without a second currency table. */
  readonly kind: 'fiat' | 'crypto';
}

/**
 * The wallet a customer is always offered when we do not know where they are.
 *
 * NOT "the home currency" any more, and the rename is the fix. This was
 * `HOME_CURRENCY = 'NGN'` and it was read as a fact about the platform rather
 * than about Nigeria — so a customer in Accra got a naira balance at the top
 * of their home screen, a naira-only activity rail, and no cedi wallet at all,
 * for the life of the account.
 *
 * The home currency is now the customer's COUNTRY's currency, from 040. This
 * constant is what remains for an account opened before that column existed,
 * where `users.country` is null: those are Nigerian accounts in fact, and
 * guessing anything else about them would be worse than the guess this makes.
 */
const FALLBACK_HOME_CURRENCY = 'NGN' as const;

/**
 * The crypto assets this platform settles in.
 *
 * IT IS A THIRD COPY OF ONE LIST — `crypto/dto.ts`'s zod enum validates a
 * withdrawal, `packages/client/src/catalogues.ts` is what both apps offer,
 * and this decides what the home screen shows a zero balance for. Three
 * copies drift, and the drift is invisible from inside any one of them: a
 * currency listed here that the enum refuses is a tile a customer can tap and
 * cannot use, and one the enum accepts that is missing here is an asset
 * nobody can find.
 *
 * `crypto-networks.test.ts` reads all three as text and fails the build if
 * they disagree, in every direction. That test was written after the web app
 * spent months sending `TRON` to a schema expecting `tron`.
 */
const CRYPTO_ASSETS = ['BTC', 'USDT', 'USDC'] as const;

/**
 * THE DOLLAR BELONGS TO NO COUNTRY, for this platform's purposes.
 *
 * Every other currency is filtered out of a customer's wallet list when it is
 * some OTHER open country's local money — a Nigerian has no use for an empty
 * cedi wallet. The dollar is the exception and has to be named: it is what
 * cross-border payment here is made of, it is what a virtual card spends, and
 * it is the quote side of most published FX pairs. Excluding it because the
 * United States happens to be a row in `countries` would take it off every
 * home screen.
 *
 * `sendableFor()` in @xetral/client states the mirror of this rule for the
 * Send screen's picker — its LOCAL_CURRENCIES is the complement of this. The
 * two must agree, and both say why.
 */
const SETTLEMENT_CURRENCY = 'USD';

@Injectable()
export class WalletService {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SpendingLimitService) private readonly limits: SpendingLimitService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(RecipientService) private readonly recipients: RecipientService,
  ) {}

  /**
   * What the customer holds, and what they could hold.
   *
   * `walletBalances` reads the ACCOUNTS TABLE, and an account is created on
   * its first posting — so a customer who has never received a dollar has no
   * USD row, and this endpoint returned naira alone. The home screen was
   * reading that faithfully and concluding the platform was naira-only, which
   * is why every other currency was invisible until the moment money happened
   * to arrive in it.
   *
   * A zero row and a missing row are different claims: the first says "you
   * hold none of this", the second says "this does not exist here". Only the
   * first is true of a currency the platform offers.
   *
   * WHAT IS OFFERED IS DERIVED, NEVER LISTED. Naira always; a fiat currency
   * when an operator has published an FX spread that reaches it, because an
   * unpublished pair is refused rather than quoted from a default and
   * offering one would be offering a wallet nothing can fund; the chains when
   * crypto is on. So switching crypto off removes the assets from this
   * response, and publishing NGN/GBP adds sterling — no deploy either way.
   *
   * A currency the customer HOLDS is always returned even if it is no longer
   * offered. Money that has arrived is owed to them whatever an operator has
   * since retired.
   */
  async balances(userUuid: string): Promise<readonly BalanceView[]> {
    const userId = await this.#userIdOf(userUuid);
    const home = await this.#homeCurrencyOf(userUuid);
    const [held, offered] = await Promise.all([
      this.ledger.walletBalances(userId),
      this.#offeredCurrencies(home),
    ]);

    const views = new Map<string, BalanceView>();
    for (const currency of offered) views.set(currency, this.#zero(currency));
    for (const b of held) {
      const currency = b.currency as Currency;
      views.set(currency, {
        currency: b.currency,
        // Formatted per currency, never with a hardcoded two decimal places.
        spendable: toMajor({ amount: b.spendableMinor, currency }),
        pending: toMajor({ amount: b.pendingMinor, currency }),
        total: toMajor({ amount: b.totalMinor, currency }),
        kind: CURRENCIES[currency].kind,
      });
    }

    // THEIR OWN currency first — the one they are paid in and read every day
    // — then the rest alphabetically, so the order does not move under
    // somebody as balances appear.
    return [...views.values()].sort((a, b) =>
      a.currency === home ? -1
      : b.currency === home ? 1
      : a.currency.localeCompare(b.currency),
    );
  }

  /**
   * The currency this customer's country leads with.
   *
   * Read per request rather than cached: the reason to change somebody's
   * country is usually that it was wrong, and a home screen that keeps
   * showing the old one for thirty seconds has not been corrected. It is one
   * indexed lookup on a column that is already being read.
   */
  async #homeCurrencyOf(userUuid: string): Promise<Currency> {
    const result = await this.pool.query<{ currency: string | null }>(
      `SELECT c.currency
         FROM users u LEFT JOIN countries c ON c.code = u.country
        WHERE u.uuid = $1`,
      [userUuid],
    );
    const code = result.rows[0]?.currency;
    // An account opened before 040, or a country row an operator has since
    // removed. Neither is a reason to show a customer no wallet at all.
    return code !== null && code !== undefined && isCurrency(code)
      ? code
      : FALLBACK_HOME_CURRENCY;
  }

  #zero(currency: Currency): BalanceView {
    const nothing = toMajor({ amount: 0n, currency });
    return {
      currency,
      spendable: nothing,
      pending: nothing,
      total: nothing,
      kind: CURRENCIES[currency].kind,
    };
  }

  async #offeredCurrencies(home: Currency): Promise<readonly Currency[]> {
    const offered = new Set<Currency>([home]);

    /*
     * THE NAIRA WALLET USED TO BE OFFERED TO EVERYBODY, and the argument for
     * it was the funding rail: naira deposits arrive through a dedicated
     * account number, and that was the one way money entered this platform
     * without already being on it.
     *
     * THE ARGUMENT WAS ABOUT NIGERIA, NOT ABOUT THE PLATFORM — the same
     * mistake `HOME_CURRENCY = 'NGN'` made one constant up. A customer in
     * Accra got a cedi wallet AND a naira one, with nothing on the screen
     * saying which was theirs, on the account they opened with a Ghanaian
     * number; and the fix for their funding is a cedi rail, not a naira
     * wallet they cannot use locally.
     *
     * Nothing is hidden by removing it. A currency the customer HOLDS is
     * merged in by the caller whatever is offered here, so a Ghanaian paid in
     * naira by a Nigerian still sees that money — which was the real half of
     * the old argument, and it is handled somewhere else.
     */

    if (await this.settings.fxEnabled()) {
      // Both sides of every live pair. A published NGN→USD is a statement
      // that dollars can be reached from here; the reverse direction is
      // published separately and says the same about naira.
      const pairs = await this.pool.query<{ base_currency: string; quote_currency: string }>(
        `SELECT base_currency, quote_currency FROM fx_spread_policies WHERE retired_at IS NULL`,
      );
      for (const row of pairs.rows) {
        for (const code of [row.base_currency, row.quote_currency]) {
          if (isCurrency(code)) offered.add(code);
        }
      }
    }

    if (await this.settings.cryptoEnabled()) {
      for (const asset of CRYPTO_ASSETS) offered.add(asset);
    }

    /*
     * ANOTHER COUNTRY'S LOCAL CURRENCY IS NOT A WALLET THIS CUSTOMER HAS.
     *
     * The FX loop above adds both sides of every published pair, which is
     * right for the dollar and the stablecoins — they belong to no country
     * and are what cross-border payment here is made of — and wrong for a
     * local one: publishing NGN→GHS so a Nigerian can pay a Ghanaian also
     * gave the Ghanaian a naira wallet, and the Nigerian a cedi one. Two
     * empty wallets on the home screen, in money neither of them can spend
     * where they live.
     *
     * READ FROM `countries`, never listed here. A local currency is by
     * definition one some country calls its own, so an operator opening a
     * fourth country gets this rule for free — the same reason the offered
     * set is derived rather than written down.
     */
    /*
     * EVERY CURRENCY THE PLATFORM CAN ACTUALLY MOVE BOTH WAYS.
     *
     * 059 routes GHS and KES to Flutterwave for collection AND payout, which
     * is the whole of what makes them wallets rather than labels: a customer
     * in Lagos can be paid in cedis and can pay a cedi wallet. They were on
     * nobody's home screen but a Ghanaian's, so cedis arriving for a Nigerian
     * landed in a currency the screen had never said existed — and the
     * customer's first sight of it was money appearing under a code that had
     * not been there the day before.
     *
     * READ FROM THE ROUTE TABLE, never listed here, for the reason the local
     * set is read from `countries`: an operator opening a fourth corridor
     * publishes two rows and gets this for free.
     *
     * BOTH DIRECTIONS ARE REQUIRED, and that is the entire test. A currency
     * we can collect and cannot pay out is one a customer could be given and
     * could not spend, which is worse than not offering it at all — GBP and
     * CAD are exactly that today, and stay off.
     */
    const movable = await this.#movableCurrencies();
    for (const code of movable) if (isCurrency(code)) offered.add(code);

    /*
     * ANOTHER COUNTRY'S LOCAL CURRENCY IS STILL NOT A WALLET, where we cannot
     * move it. The FX loop adds both sides of every published pair, so
     * publishing NGN→GBP so a Nigerian can be paid in London would otherwise
     * hand every customer a sterling wallet nothing can pay out.
     */
    const local = await this.#localCurrencies();
    for (const code of offered) {
      if (
        code !== home &&
        code !== SETTLEMENT_CURRENCY &&
        local.has(code) &&
        !movable.has(code)
      ) {
        offered.delete(code);
      }
    }

    return [...offered];
  }

  /**
   * Every currency 059 says this platform can BOTH collect and pay out.
   *
   * Not "is routed" — routed in both directions. A route names who serves an
   * operation, so a currency with only a `collect` row is one money can enter
   * and never leave, and a wallet offered on that basis is a trap rather than
   * a product.
   *
   * A deployment behind 059 has no table at all, and the answer there is the
   * empty set: nothing extra is offered, which is exactly the behaviour this
   * screen had before routing existed. A home screen must not fail to render
   * because a migration has not been applied.
   *
   * Cached for five seconds, alongside the local set and for the same reason.
   */
  async #movableCurrencies(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.#movableCache !== undefined && this.#movableCache.until > now) {
      return this.#movableCache.codes;
    }
    let codes: ReadonlySet<string> = new Set<string>();
    try {
      const rows = await this.pool.query<{ currency: string }>(
        `SELECT currency FROM provider_routes
          WHERE operation IN ('collect', 'payout')
          GROUP BY currency
         HAVING count(DISTINCT operation) = 2`,
      );
      codes = new Set(rows.rows.map((r) => r.currency));
    } catch {
      // 059 has not been applied here. See above: the empty set is the old
      // behaviour, and the old behaviour renders.
    }
    this.#movableCache = { codes, until: now + 5_000 };
    return codes;
  }

  #movableCache: { codes: ReadonlySet<string>; until: number } | undefined;

  /**
   * Every currency some OPEN country calls its own.
   *
   * `enabled`, and that word is load-bearing. 040's seed carries rows for
   * countries the platform has not opened — the United States and the United
   * Kingdom among them — so an unfiltered read makes the DOLLAR somebody
   * else's local money and takes it off every Nigerian's home screen. It
   * did: two FX suites went red asserting a USD balance that had stopped
   * being offered. A closed country has no customers, so its currency is not
   * a local currency of anywhere this platform operates.
   *
   * Cached for five seconds, the same window a provider credential gets:
   * this changes when an operator opens a country, which is rare, and
   * reading it per request would put a query in front of every home screen.
   */
  async #localCurrencies(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.#localCache !== undefined && this.#localCache.until > now) {
      return this.#localCache.codes;
    }
    const rows = await this.pool.query<{ currency: string }>(
      `SELECT DISTINCT currency FROM countries WHERE enabled`,
    );
    const codes = new Set(rows.rows.map((r) => r.currency));
    this.#localCache = { codes, until: now + 5_000 };
    return codes;
  }

  #localCache: { codes: ReadonlySet<string>; until: number } | undefined;

  async history(
    userUuid: string,
    currency: Currency,
    options: {
      readonly limit: number;
      readonly before?: string;
      /** Narrows to particular entry kinds — how "Gift" is expressed, since
       *  gift cards settle in naira and are not a currency of their own. */
      readonly kinds?: readonly string[];
    },
  ): Promise<{
    readonly entries: readonly Record<string, unknown>[];
    readonly next_cursor: string | null;
  }> {
    const userId = await this.#userIdOf(userUuid);
    const rows = await this.ledger.history(userId, currency, options);

    /*
     * WHAT LATER HAPPENED TO A BANK PAYOUT, decorated on rather than baked in.
     *
     * A payout posts TWO entries. The reserve moves wallet → pending and its
     * description is written at that moment; the settle moves pending → float,
     * and the customer has no leg in `customer_wallet` on it — so the history
     * above, which is wallet legs only and is right to be, can never show it.
     *
     * The consequence was a row reading "bank payout reserved" for ever, on
     * money that reached the bank days ago. A customer looking at their own
     * activity had no way to learn a transfer had actually gone.
     *
     * Entries are APPEND-ONLY, so the description cannot be rewritten when the
     * payout settles — and should not be: it was true when it was written.
     * `bank_payouts.reserve_entry_id` names the entry, so the LIVE status is
     * one indexed lookup away and is correct for rows written before any of
     * this existed.
     *
     * The lookup is scoped to the page, so it is one query per page rather
     * than one per row.
     */
    const payouts = await this.#payoutStateFor(
      userId,
      rows.map((row) => row.entryUuid),
    );

    return {
      entries: rows.map((row) => ({
        id: row.entryUuid,
        kind: row.kind,
        description: row.description,
        amount: toMajor({ amount: row.amountMinor, currency }),
        currency: row.currency,
        occurred_at: row.occurredAt.toISOString(),
        // What later happened to it. A customer whose charge was reversed or
        // refunded previously read a debit and an unexplained credit, with
        // nothing saying the two were the same event.
        status: row.status,
        answered_by: row.answeredBy,
        ...(payouts.get(row.entryUuid) ?? {}),
      })),
      next_cursor: rows.length === options.limit ? (rows[rows.length - 1]?.postingId ?? null) : null,
    };
  }

  /**
   * The live state of any bank payout among these entries.
   *
   * KEYED ON `reserve_entry_id`, which is the entry the customer actually has
   * a wallet leg in — the settle entry moves pending → float and is invisible
   * to a wallet history, correctly.
   *
   * Scoped to the customer as well as to the entries. The entry ids come from
   * this customer's own postings so a cross-read is not reachable, but a query
   * about somebody's money that relies on its caller having filtered correctly
   * is one refactor away from not being scoped at all.
   */
  async #payoutStateFor(
    userId: string,
    entryUuids: readonly string[],
  ): Promise<Map<string, { payout_state: string; destination: string }>> {
    const found = new Map<string, { payout_state: string; destination: string }>();
    if (entryUuids.length === 0) return found;

    const result = await this.pool.query<{
      entry_uuid: string;
      status: string;
      bank_name: string;
      account_number: string;
    }>(
      `SELECT e.uuid AS entry_uuid, b.status, b.bank_name, b.account_number
         FROM bank_payouts b
         JOIN journal_entries e ON e.id = b.reserve_entry_id
        WHERE b.user_id = $1::bigint
          AND e.uuid = ANY($2::uuid[])`,
      [userId, [...entryUuids]],
    );

    for (const row of result.rows) {
      found.set(row.entry_uuid, {
        /*
         * THE PROVIDER'S WORD, TRANSLATED ONCE.
         *
         * `reserved` deliberately does NOT become "failed" or "sent": it means
         * nobody has answered for this payout yet, the money is held, and the
         * sweep will ask. Saying either would be a claim we cannot support —
         * the rule 043 records about a timeout settling nothing and reversing
         * nothing.
         */
        payout_state:
          row.status === 'reserved'
            ? 'on_its_way'
            : row.status === 'failed'
              ? 'returned'
              : 'sent',
        // Four digits, the way a bank statement names a destination. The whole
        // number is on the detail view, which is one deliberate tap.
        destination: `${row.bank_name} ••${row.account_number.slice(-4)}`,
      });
    }
    return found;
  }

  /**
   * ONE TRANSACTION, IN FULL — what a customer gets when they tap a row.
   *
   * THE LIST IS DELIBERATELY THIN and this is why it can be: a row carries a
   * line and a figure, and everything else — the fee, the reference, where it
   * went, what has happened to it since — is one tap away rather than crammed
   * into a 320px row.
   *
   * SCOPED TO THE CUSTOMER'S OWN LEG, and the refusal for somebody else's
   * entry is the SAME 404 as for one that does not exist. Distinguishing them
   * turns this into a way to enumerate other people's transactions by id —
   * the rule 018 already applies to disputes.
   *
   * IT SHOWS EVERY LEG THIS CUSTOMER HAS IN THE ENTRY, not one. A transfer
   * that charges a fee is two postings against the same wallet, and a receipt
   * that showed only the larger one would not add up to what left the account.
   */
  async transaction(
    userUuid: string,
    entryUuid: string,
  ): Promise<Record<string, unknown>> {
    const userId = await this.#userIdOf(userUuid);

    const legs = await this.pool.query<{
      uuid: string;
      kind: string;
      description: string;
      occurred_at: Date;
      amount_minor: string;
      currency: string;
      account_kind: string;
      status: string;
      answered_by: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT e.uuid, e.kind, e.description, e.occurred_at, e.metadata,
              p.amount_minor, p.currency, a.kind::text AS account_kind,
              s.status, s.answered_by
         FROM journal_entries e
         JOIN postings p        ON p.journal_entry_id = e.id
         JOIN accounts a        ON a.id = p.account_id
         JOIN entry_status s    ON s.id = e.id
        WHERE e.uuid = $1::uuid
          AND a.owner_id = $2::bigint
          AND a.kind = 'customer_wallet'
        ORDER BY p.id`,
      [entryUuid, userId],
    );

    const first = legs.rows[0];
    if (first === undefined) {
      throw new NotFoundException({ error: 'transaction_not_found' });
    }

    const currency = first.currency as Currency;
    /*
     * THE NET MOVEMENT, summed across this customer's own legs.
     *
     * A transfer posts the amount and the fee separately, so the figure a
     * customer should read as "what this cost me" is the sum rather than the
     * first leg. Summed as BIGINT, never as a number: these are minor units
     * and a float here is the rule this codebase exists to keep.
     */
    let net = 0n;
    for (const leg of legs.rows) net += BigInt(leg.amount_minor);

    const payout = await this.#payoutDetailFor(userId, entryUuid);

    return {
      id: first.uuid,
      kind: first.kind,
      description: first.description,
      occurred_at: first.occurred_at.toISOString(),
      amount: toMajor({ amount: net, currency }),
      currency,
      status: first.status,
      answered_by: first.answered_by,
      /*
       * EACH LEG, so a receipt can show the amount and the fee as the two
       * things they are rather than as one number the customer cannot
       * reconcile against their balance.
       */
      legs: legs.rows.map((leg) => ({
        amount: toMajor({ amount: BigInt(leg.amount_minor), currency }),
        currency: leg.currency,
      })),
      /*
       * THE REFERENCE A CUSTOMER QUOTES TO SUPPORT. It is the entry's own
       * uuid rather than anything a provider issued: a provider reference is
       * opaque and only its issuer can resolve it, and this one names the row
       * every internal screen can find.
       */
      reference: first.uuid,
      ...(payout ?? {}),
    };
  }

  /**
   * The payout behind an entry, for the detail view — the destination in full
   * and the reason where there is one.
   *
   * THE PROVIDER'S SENTENCE IS NOT HERE. `failure_reason` names our
   * integration — 006's rule — so it stays on the row an operator reads. What
   * a customer gets is the state.
   */
  async #payoutDetailFor(
    userId: string,
    entryUuid: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query<{
      status: string;
      bank_name: string;
      account_number: string;
      account_name: string;
      narration: string | null;
      fee_minor: string;
      currency: string;
    }>(
      `SELECT b.status, b.bank_name, b.account_number, b.account_name,
              b.narration, b.fee_minor, b.currency
         FROM bank_payouts b
         JOIN journal_entries e ON e.id = b.reserve_entry_id
        WHERE b.user_id = $1::bigint AND e.uuid = $2::uuid`,
      [userId, entryUuid],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;

    const currency = row.currency as Currency;
    return {
      payout_state:
        row.status === 'reserved'
          ? 'on_its_way'
          : row.status === 'failed'
            ? 'returned'
            : 'sent',
      destination: `${row.bank_name} ••${row.account_number.slice(-4)}`,
      beneficiary: row.account_name,
      bank_name: row.bank_name,
      account_number: row.account_number,
      narration: row.narration,
      fee: toMajor({ amount: BigInt(row.fee_minor), currency }),
    };
  }

  /**
   * A customer-to-customer transfer.
   *
   * Deliberately does NOT pre-check the sender's balance. Between a check and
   * the write another request can spend the same money, so the overdraft guard
   * in the database is the only one that can be trusted — this builds the entry
   * and lets the constraint decide. A pre-check would be a second, weaker copy
   * of the same rule plus a race.
   */
  async transfer(senderUuid: string, request: TransferRequest): Promise<TransferResult> {
    const currency = request.currency;
    const amount = this.#parseAmount(request.amount, currency);

    const sender = await this.#activeUser(senderUuid);
    const recipient = await this.recipients.resolve(request.recipient);

    if (recipient.id === sender.id) {
      throw new BadRequestException({ error: 'cannot_transfer_to_self' });
    }

    // Rounding is stated explicitly at the call site, because every rounding
    // choice moves money to someone and this one moves it to us. 'up' means a
    // sub-minor-unit fee is charged rather than forgone.
    // From platform_settings, so changing a fee is an audited row rather than
    // a deploy. The environment value remains the fallback for the moments
    // before the seed has run on a fresh database.
    const fee = applyBasisPoints(
      amount,
      await this.settings.transferFeeBasisPoints(),
      'up',
    );

    /*
     * PART OF THE FEE IS NOT OURS.
     *
     * VAT on a service fee is collected for the FIRS and owed to the FIRS, so
     * it goes to `liability_tax_payable` and never to `revenue_fees`. Booking
     * it as revenue overstates what the business earned and understates what
     * it owes — both errors pointing the flattering way.
     *
     * The split is INCLUSIVE by default, so the customer pays exactly what
     * they paid before and only the books change. That is what makes this safe
     * to ship without a pricing decision behind it.
     */
    const split = await this.tax.splitFee(fee);

    /*
     * The transfer levy, which is OFF by default and changes what the customer
     * pays when it is not. Whether it applies to a wallet like this one is a
     * question for a Nigerian tax adviser, so the machinery is here and the
     * decision is not.
     */
    const levy = await this.tax.levyOn(amount);

    const debit = {
      amount: amount.amount + split.gross.amount + levy.amount,
      currency,
    };

    const senderWallet: AccountRef = {
      kind: 'customer_wallet',
      ownerId: sender.id,
      currency,
    };
    const recipientWallet: AccountRef = {
      kind: 'customer_wallet',
      ownerId: recipient.id,
      currency,
    };

    const intent: LedgerIntent = {
      // Namespaced so a client-chosen key cannot collide with a provider's.
      idempotencyKey: `transfer:${request.idempotency_key}`,
      kind: 'wallet_transfer',
      occurredAt: new Date(),
      description: `transfer to ${maskIdentifier(request.recipient)}`,
      metadata: { sender_id: sender.id, recipient_id: recipient.id },
      postings: [
        posting(senderWallet, negate(debit)),
        posting(recipientWallet, amount),
        // A zero-amount posting is refused by the ledger, so each leg below
        // only exists when there is something in it. That is why the fee, the
        // tax and the levy are three conditionals rather than one: a zero-rate
        // VAT on a real fee must still post the fee.
        ...(split.net.amount > 0n
          ? [posting({ kind: 'revenue_fees', currency }, split.net)]
          : []),
        ...(split.tax.amount > 0n
          ? [posting({ kind: 'liability_tax_payable', currency }, split.tax)]
          : []),
        ...(levy.amount > 0n
          ? [posting({ kind: 'liability_tax_payable', currency }, levy)]
          : []),
      ],
    };

    // The ledger package knows nothing about HTTP, deliberately — it is used
    // by webhook handlers and jobs as well as by this controller. Translating
    // its errors is the caller's job, and this is the caller.
    //
    // The daily ceiling wraps the posting rather than preceding it, so the
    // check and the write are serialised for this customer. Note what it
    // counts: the full DEBIT, fee included, because that is what leaves the
    // wallet and what a stolen session would drain.
    //
    // The daily ceiling is a PRECONDITION on the entry rather than a check
    // around it, so it runs inside the ledger's transaction and cannot race
    // the posting it is guarding. Note what it counts: the full DEBIT, fee
    // included, because that is what leaves the wallet and what a stolen
    // session would drain.
    const precondition = await this.limits.precondition({
      userId: sender.id,
      scope: 'transfer',
      amount: debit,
      idempotencyKey: intent.idempotencyKey,
      // For the velocity rules. Stated by the caller rather than read out of
      // the intent's metadata, so the control cannot be switched off by a flow
      // that forgets a key.
      recipientId: recipient.id,
    });

    // The receipt is enqueued on the ENTRY'S OWN transaction, so a receipt
    // cannot exist for money that did not move and money cannot move without
    // one being owed. `onEntry` is deliberately not called on a replay, which
    // is exactly right here: a customer retrying a timed-out transfer must not
    // be told twice that they sent money once.
    const onEntry = async (client: PoolClient, entry: WrittenEntry): Promise<void> => {
      /*
       * WHAT WAS COLLECTED, RECORDED AGAINST WHAT MOVED IT — and on the
       * entry's own transaction, so neither half can exist without the other.
       * Written apart, the posting and the record drift, and the drift is
       * discovered while filing a return rather than by
       * `tax_remittance_drift`.
       *
       * Only what actually posted is recorded. A zero leg is not posted, so a
       * zero collection is not recorded: a row saying "we collected nothing"
       * is indistinguishable from one somebody forgot to write.
       */
      if (split.tax.amount > 0n) {
        await this.tax.record(client, {
          kind: 'vat',
          entryId: entry.entryId,
          userId: sender.id,
          amount: split.tax,
          // The fee is the base VAT was charged on, not the transfer amount.
          baseMinor: split.net.amount,
          rateApplied: `${await this.settings.vatBasisPoints()}bp`,
          occurredAt: intent.occurredAt,
        });
      }
      if (levy.amount > 0n) {
        await this.tax.record(client, {
          kind: 'transfer_levy',
          entryId: entry.entryId,
          userId: sender.id,
          amount: levy,
          // A flat levy is charged ON the transfer, so that is its base.
          baseMinor: amount.amount,
          rateApplied: 'flat',
          occurredAt: intent.occurredAt,
        });
      }

      if (sender.email === null) return;
      await this.notifications.enqueueBestEffort(client, {
        userId: sender.id,
        recipient: sender.email,
        // The ledger key, reused. It is already unique per transfer and
        // already survives a retry — inventing a second identity for the same
        // event is how the two drift apart under exactly the conditions that
        // make idempotency matter.
        idempotencyKey: `receipt:${intent.idempotencyKey}`,
        request: {
          kind: 'transfer_sent',
          amount: toMajor(amount),
          currency,
          reference: request.idempotency_key,
        },
      });
    };

    let posted;
    try {
      posted = await this.ledger.post(
        intent,
        precondition === undefined ? { onEntry } : { precondition, onEntry },
      );
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // 422, not 400: the request was well-formed and understood, and the
        // reason it cannot be carried out is a fact about the account rather
        // than a mistake in the payload. The body carries no figure — see
        // InsufficientFundsError.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      await this.#alertOnVelocityRefusal(sender, error);
      throw error;
    }

    return {
      entry_id: posted.entryUuid,
      amount: toMajor(amount),
      fee: toMajor(fee),
      currency,
      replayed: posted.replayed,
    };
  }

  /**
   * Tells the customer when a velocity rule refused a transfer.
   *
   * THIS IS THE POINT OF THE CONTROL, not a courtesy on top of it. A refusal a
   * customer did not cause is the first evidence they will get that somebody
   * else is signed in as them, and the rule stopping the money is worth much
   * less if nobody is told it fired.
   *
   * DETACHED, and it has to be. The precondition threw, so the ledger's
   * transaction is being rolled back — a message enqueued on that client would
   * be rolled back with it, and the alert about a blocked transfer would exist
   * only in the case where nothing was blocked.
   *
   * Keyed on the customer and the Lagos day, so an attacker hammering a
   * refused transfer sends the customer ONE email rather than turning our own
   * alerting into a mail bomb aimed at the person we are protecting.
   */
  async #alertOnVelocityRefusal(
    sender: { readonly id: string; readonly email: string | null },
    error: unknown,
  ): Promise<void> {
    if (sender.email === null) return;
    const code = velocityCodeOf(error);
    if (code === undefined) return;

    await this.notifications.enqueueDetached({
      userId: sender.id,
      recipient: sender.email,
      idempotencyKey: `velocity:${sender.id}:${code}:${lagosDay()}`,
      request: { kind: 'transfer_blocked', reason: code },
    });
  }

  #parseAmount(raw: string, currency: Currency): Money<Currency> {
    let amount: Money<Currency>;
    try {
      amount = fromMajor(raw, currency);
    } catch (cause) {
      throw new BadRequestException({
        error: 'invalid_amount',
        detail: cause instanceof Error ? cause.message : undefined,
      });
    }
    if (amount.amount <= 0n) {
      throw new BadRequestException({ error: 'invalid_amount', detail: 'must be positive' });
    }
    return amount;
  }

  async #userIdOf(uuid: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }

  /**
   * Status is checked HERE, at the point of the action, and never inferred from
   * the presence of a token. A frozen account's access token stays valid until
   * it expires; freezing has to bite before the money moves, not at the next
   * refresh.
   */
  async #activeUser(uuid: string): Promise<{ id: string; email: string | null }> {
    const result = await this.pool.query<{ id: string; status: string; email: string | null }>(
      `SELECT id, status, email FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    if (row.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: row.status });
    }
    return { id: row.id, email: row.email };
  }

}

function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return subtract({ amount: 0n, currency: amount.currency }, amount);
}

/** Keeps enough for the sender to recognise the recipient, without writing a
 *  full phone number or email into a metadata column and every log line. */
function maskIdentifier(identifier: string): string {
  if (identifier.includes('@')) {
    const [local = '', domain = ''] = identifier.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return `***${identifier.slice(-4)}`;
}

/**
 * The velocity code inside a refusal, or undefined if this was something else.
 *
 * Matched on the codes rather than on the exception class, because the
 * precondition throws from inside the ledger's transaction and only the body
 * says which rule fired. Anything unrecognised returns undefined and nobody is
 * emailed — a refusal for insufficient funds is the customer's own doing and
 * telling them somebody may be in their account would be a false alarm, which
 * is the one thing a security alert cannot afford to be.
 */
function velocityCodeOf(error: unknown): 'too_many_transfers' | 'too_many_new_recipients' | undefined {
  if (!(error instanceof UnprocessableEntityException)) return undefined;
  const response: unknown = error.getResponse();
  const code =
    typeof response === 'object' && response !== null && 'error' in response
      ? (response as { error?: unknown }).error
      : undefined;

  return code === 'too_many_transfers' || code === 'too_many_new_recipients' ? code : undefined;
}

/**
 * Today, in Lagos, as `YYYY-MM-DD`.
 *
 * The same day boundary the limits themselves use. An alert keyed on a UTC day
 * would let a second email through at 1am local, which is exactly when a drain
 * is running and exactly when a second identical email helps nobody.
 */
function lagosDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
