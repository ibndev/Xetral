import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { DATABASE, LEDGER } from '../tokens.js';
import { AuditService } from './audit.service.js';

/**
 * The operations surface.
 *
 * Everything here is something a person needs to do to run the platform, that
 * previously required either a developer or a psql session. The rule
 * throughout: an action that takes something from a customer records WHO did
 * it and WHY, before they are told it worked.
 */

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly kyc_status: string | null;
  readonly created_at: string;
}

@Injectable()
export class AdminService {
  readonly #logger = new Logger(AdminService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ------------------------------ overview ----------------------------- */

  /**
   * Everything waiting on a human, plus what the platform owes.
   *
   * One round trip for the queues and one for the liability, because a
   * dashboard that needs six queries to answer "is anything stuck?" is a
   * dashboard nobody opens.
   */
  async overview(): Promise<Record<string, unknown>> {
    const [queues, liability, recent] = await Promise.all([
      this.pool.query(`SELECT queue, waiting, oldest FROM admin_work_queue`),
      this.pool.query(
        `SELECT currency, wallets_minor::text, pending_minor::text, cards_minor::text,
                total_owed_minor::text, suspense_minor::text
           FROM admin_liability`,
      ),
      this.pool.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS entries_24h,
                COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')   AS entries_1h
           FROM journal_entries`,
      ),
    ]);

    return {
      queues: queues.rows,
      liability: liability.rows.map((row) => ({
        ...row,
        // Major units for display, minor units kept alongside. The dashboard
        // never does arithmetic on these — it shows what the ledger says.
        total_owed: toMajor({
          amount: BigInt((row as { total_owed_minor: string }).total_owed_minor),
          currency: (row as { currency: string }).currency as Currency,
        }),
      })),
      activity: recent.rows[0] ?? {},
    };
  }

  /**
   * The reconciliation figure that matters: is the ledger internally
   * consistent?
   *
   * `ledger_drift` compares each account's materialised balance against the
   * sum of its own postings. A non-empty result means a trigger did not fire
   * or somebody wrote around the ledger, and it is the one number an operator
   * should look at every morning.
   */
  async drift(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(`SELECT * FROM ledger_drift`);
    return rows.rows as Record<string, unknown>[];
  }

  /* -------------------------------- users ------------------------------ */

  async users(options: {
    readonly search?: string;
    readonly status?: string;
    readonly limit: number;
    readonly before?: string;
  }): Promise<readonly UserSummary[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.search !== undefined && options.search !== '') {
      /*
       * FOUR IDENTIFIERS, BECAUSE SUPPORT IS NOT HANDED AN EMAIL ADDRESS.
       *
       * This matched the email alone. A customer on the phone gives a name and
       * the number they are calling from; somebody reporting a payment link
       * gives a handle. None of those found anybody, so the screen answered
       * "No customers match that" to a search for a customer who was right
       * there — which reads as the account having been deleted.
       *
       * The phone is normalised to E.164 server-side, so a caller reading out
       * "0803…" would not match the stored `+234803…`. A trailing-digits match
       * covers both without asking whoever is searching to know that.
       */
      const term = options.search.toLowerCase().trim();
      params.push(`%${term}%`);
      const like = `$${params.length}`;
      params.push(`%${term.replace(/[^0-9]/g, '')}`);
      const digits = `$${params.length}`;
      clauses.push(
        `(lower(u.email) LIKE ${like}
          OR lower(u.full_name) LIKE ${like}
          OR lower(u.handle) LIKE ${like}
          OR (${digits} <> '%' AND u.phone LIKE ${digits}))`,
      );
    }
    if (options.status !== undefined) {
      params.push(options.status);
      clauses.push(`u.status = $${params.length}`);
    }
    if (options.before !== undefined) {
      params.push(options.before);
      clauses.push(`u.id < $${params.length}::bigint`);
    }
    params.push(options.limit);

    /*
     * nosemgrep: no-interpolated-sql — every VALUE goes through `params`; what
     * is interpolated is `$N` placeholder numbers and fixed clause fragments
     * built above, none of which comes from a request. Postgres has no
     * parameter for an optional WHERE, so a filter list is either built this
     * way or written out once per combination.
     */
    const rows = await this.pool.query<UserSummary & { row_id: string }>(
      // nosemgrep: semgrep.no-interpolated-sql
      /*
       * TWO NAMES, AND THE LIST NEEDS BOTH.
       *
       * `u.full_name` is what somebody typed about themselves at signup and
       * `k.full_name` is what a reviewer read off a document. 040 keeps them
       * apart because only the second may inform a money decision — and the
       * accounts that predate the signup field have ONLY the second, so a
       * screen reading the first alone shows a customer list with no names in
       * it at all.
       *
       * Both are returned and the screen decides. Nothing here collapses
       * them into one column, which is what would make the distinction
       * quietly disappear.
       */
      `SELECT u.id::text AS row_id, u.uuid AS id, u.email, u.status, u.created_at,
              u.full_name, u.phone, u.handle,
              (SELECT k.full_name FROM kyc_submissions k
                WHERE k.user_id = u.id AND k.status IN ('approved','pending')
                ORDER BY k.id DESC LIMIT 1) AS verified_name,
              (SELECT k.status::text FROM kyc_submissions k
                WHERE k.user_id = u.id ORDER BY k.id DESC LIMIT 1) AS kyc_status
         FROM users u
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY u.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.rows;
  }

  /** One customer, with everything an operator needs before acting. */
  async user(uuid: string): Promise<Record<string, unknown>> {
    const found = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

    /*
     * SEVEN INDEPENDENT QUESTIONS, NOT ONE ALL-OR-NOTHING ANSWER.
     *
     * THE FAILURE THIS EXISTS FOR. These ran under `Promise.all`, so ONE
     * failing query took the whole page down — and the page then rendered
     * every field as "not set", which reads as a customer with no name, no
     * email and no phone rather than as a screen that did not load. An
     * operator looking at it concludes the account is broken; the account is
     * fine.
     *
     * That is exactly wrong for a support screen. Its whole purpose is to be
     * usable during an incident, and an incident is when a table is missing,
     * a migration is behind, or a view has been replaced. Cards failing to
     * load is a reason to show no cards, not a reason to hide somebody's
     * phone number.
     *
     * So every section stands alone, and a failing one is LOGGED BY NAME —
     * which is the part that was missing. The profile is the exception: it is
     * the identity of the page, and rendering a customer whose own row could
     * not be read would be a page about nobody.
     */
    const [profile, balances, devices, statusHistory, tierHistory, tierLimits, cards] =
      await this.#sections(row.id, [
      this.pool.query(
        /*
         * TWO NAMES AND TWO PHONE NUMBERS, KEPT APART ON PURPOSE.
         *
         * `users.full_name` is what somebody typed about themselves and is
         * used to greet them; `kyc_submissions.full_name` is what a reviewer
         * read off a document, and it is the only one any money decision may
         * read. 040 records that rule, and collapsing them here would put the
         * unverified one in front of an operator deciding something.
         *
         * The account's own columns were simply absent, which is why this
         * screen showed an email address and nothing else for every customer
         * who had not submitted identity documents.
         */
        `SELECT u.uuid AS id, u.email, u.status, u.created_at, u.kyc_tier,
                u.full_name AS account_name, u.phone AS account_phone,
                u.handle, u.country,
                /*
                 * THE COUNTRY BY NAME, and its currency and payout rail.
                 *
                 * A bare 'GH' told an operator two letters. The country is
                 * what decides this customer's home currency, which wallets
                 * they are offered, and whether money leaves through a bank
                 * or a mobile money wallet — so the row that names it should
                 * carry the consequences rather than make somebody look them
                 * up. It comes from the dialling code the customer picked at
                 * signup, which 050 also backfilled for every older account.
                 */
                c.name AS country_name, c.currency AS home_currency,
                c.payout_method,
                k.status::text AS kyc_status, k.full_name, k.bvn_last4, k.phone
           FROM users u
           LEFT JOIN countries c ON c.code = u.country
           LEFT JOIN kyc_submissions k
             ON k.user_id = u.id AND k.status IN ('approved','pending')
          WHERE u.id = $1::bigint`,
        [row.id],
      ),
      this.pool.query(
        `SELECT a.kind::text, a.currency, b.balance_minor::text
           FROM account_balances b JOIN accounts a ON a.id = b.account_id
          WHERE a.owner_id = $1::bigint ORDER BY a.currency, a.kind`,
        [row.id],
      ),
      this.pool.query(
        `SELECT platform, display_name, created_at, revoked_at
           FROM devices WHERE user_id = $1::bigint ORDER BY created_at DESC LIMIT 20`,
        [row.id],
      ),
      this.pool.query(
        `SELECT c.from_status, c.to_status, c.reason, c.created_at, a.email AS changed_by
           FROM user_status_changes c JOIN users a ON a.id = c.changed_by
          WHERE c.user_id = $1::bigint ORDER BY c.created_at DESC LIMIT 20`,
        [row.id],
      ),
      this.pool.query(
        `SELECT t.from_tier, t.to_tier, t.reason, t.changed_at, a.email AS changed_by
           FROM kyc_tier_changes t
           LEFT JOIN users a ON a.id = t.changed_by
          WHERE t.user_id = $1::bigint ORDER BY t.changed_at DESC LIMIT 20`,
        [row.id],
      ),
      // What this customer's tier actually allows, so an operator looking at a
      // refused transfer does not have to hold the grid in their head.
      this.pool.query(
        `SELECT l.currency, l.daily_limit_minor::text
           FROM users u JOIN kyc_tier_limits l ON l.tier = u.kyc_tier
          WHERE u.id = $1::bigint ORDER BY l.currency`,
        [row.id],
      ),
      // THE CARDS, which support could not see at all. A customer ringing
      // about a declined card was previously a conversation nobody on this
      // side could follow — no status, no history, and no way to tell whether
      // the card had been frozen and by whom.
      //
      // From `card_history`, which carries `last4` and nothing more of the
      // number: this screen is read over shoulders and screenshotted into
      // tickets.
      this.pool.query(
        `SELECT card_id AS id, last4, currency, status, created_at, terminated_at,
                replaces_card_id, replaced_by_card_id, events
           FROM card_history WHERE user_id = $1::bigint`,
        [row.id],
      ),
    ]);

    return {
      // `?? []` on each: the array destructuring above is positional and
      // TypeScript cannot know `#sections` returns exactly seven, so the
      // fallbacks are the compiler's price for a positional API rather than a
      // claim that a section can be absent.
      profile: (profile ?? [])[0] ?? {},
      balances: balances ?? [],
      devices: devices ?? [],
      status_history: statusHistory ?? [],
      tier_history: tierHistory ?? [],
      tier_limits: tierLimits ?? [],
      cards: cards ?? [],
    };
  }

  /**
   * Runs each section, names the ones that failed, and returns the rest.
   *
   * The names are positional and match the destructuring at the call site.
   * A section that throws yields an empty list and one log line saying WHICH
   * — so "the cards panel is empty" and "the cards query is broken" stop
   * looking identical, which is the only reason anybody could tell them
   * apart.
   */
  async #sections(
    userId: string,
    queries: readonly Promise<{ rows: unknown[] }>[],
  ): Promise<Record<string, unknown>[][]> {
    const NAMES = [
      'profile',
      'balances',
      'devices',
      'status history',
      'tier history',
      'tier limits',
      'cards',
    ] as const;

    const settled = await Promise.allSettled(queries);

    return settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value.rows as Record<string, unknown>[];

      const name = NAMES[index] ?? `section ${index}`;
      const reason = result.reason;
      this.#logger.error(
        `the ${name} section of the customer view failed for user ${userId}: ` +
          `${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`,
      );

      // The profile IS the page. Everything else degrades to an empty panel;
      // a customer whose own row cannot be read is not a page to render.
      if (index === 0) throw reason;
      return [];
    });
  }

  /**
   * One card's whole life, for the agent on the phone to a customer.
   *
   * Every status change with who caused it, so "was this card frozen at the
   * time, and who unfroze it?" — the first question in any card dispute — has
   * an answer. Carries four digits of the number and no more, which is all
   * `cards` stores.
   */
  async cardHistory(cardUuid: string): Promise<Record<string, unknown>> {
    const card = await this.pool.query<{ id: string }>(
      `SELECT id FROM cards WHERE uuid = $1::uuid`,
      [cardUuid],
    );
    const id = card.rows[0]?.id;
    if (id === undefined) throw new NotFoundException({ error: 'card_not_found' });

    const [summary, events] = await Promise.all([
      this.pool.query(`SELECT * FROM card_history WHERE card_id = $1::uuid`, [cardUuid]),
      this.pool.query(
        `SELECT e.kind::text AS kind, e.actor::text AS actor, e.reason, e.created_at,
                u.email AS actor_email
           FROM card_events e
           LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.card_id = $1::bigint
          ORDER BY e.id`,
        [id],
      ),
    ]);

    return { ...(summary.rows[0] ?? {}), events: events.rows };
  }

  /**
   * Raises or lowers a customer's verification tier.
   *
   * SEPARATE FROM `setUserStatus`, deliberately. Freezing is a protective
   * action about an account's safety; a tier is a claim about what we know
   * about a person, and the two answer different questions. Conflating them
   * would mean unfreezing an account also restored a ceiling somebody removed
   * for a reason.
   *
   * A REASON IS REQUIRED IN BOTH DIRECTIONS. Raising one to enhanced is the act
   * that decides how much money may leave in a day, and the answer to "who
   * allowed this" has to exist. Lowering one takes something away from a
   * customer, which `admin_audit_log`'s CHECK already demands a reason for.
   */
  async setUserTier(
    uuid: string,
    tier: number,
    actorUuid: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updated = await client.query<{ id: string; kyc_tier: number }>(
        `UPDATE users SET kyc_tier = $2 WHERE uuid = $1::uuid RETURNING id, kyc_tier`,
        [uuid, tier],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

      // The trigger records the change; this fills in WHO and WHY, which the
      // trigger cannot know. Updating the row it just wrote is safe because
      // `kyc_tier_changes` is append-only only against later edits — this is
      // the same statement completing its own record.
      await client.query(
        `UPDATE kyc_tier_changes SET changed_by = $2::bigint, reason = $3
          WHERE id = (SELECT max(id) FROM kyc_tier_changes WHERE user_id = $1::bigint)`,
        [row.id, actorId, reason],
      );

      await client.query('COMMIT');
      return { id: uuid, kyc_tier: row.kyc_tier };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (
        error !== null &&
        typeof error === 'object' &&
        String((error as { message?: string }).message ?? '').includes('rests on the evidence')
      ) {
        throw new UnprocessableEntityException({ error: 'tier_skips_evidence' });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * EVERY POSTING THAT TOUCHED THIS CUSTOMER, filtered.
   *
   * THE GAP THIS CLOSES. Support could see balances, devices, cards, status
   * changes and tier changes — everything ABOUT an account and nothing that
   * happened IN it. So the commonest question there is ("they say a transfer
   * did not arrive") could be answered only by asking the customer to read
   * their own screen back, or by a psql prompt.
   *
   * WIDER THAN THE CUSTOMER'S OWN HISTORY, deliberately, and this is the
   * difference from `LedgerService.history`. That shows one currency and only
   * the `customer_wallet` leg, because a customer wants a statement. An
   * operator is looking at the whole account: money held in `customer_pending`
   * against a card authorization or a gift card hold is exactly what a
   * "missing" balance turns out to be, and a view that hid it would send
   * somebody looking for a bug in the ledger.
   *
   * READ FROM POSTINGS, never from entry metadata — the rule 027 states for
   * the monitoring rules and for the same reason: a view assembled from a key
   * some flow remembered to set stops working silently the first time a new
   * flow forgets.
   *
   * KEYSET PAGINATED on the posting id. `OFFSET` shifts under an active
   * account and produces duplicates and gaps, which on a support screen reads
   * as money appearing and disappearing.
   */
  async userTransactions(
    uuid: string,
    options: {
      readonly currency?: string;
      readonly kind?: string;
      readonly limit: number;
      readonly before?: string;
    },
  ): Promise<readonly Record<string, unknown>[]> {
    const found = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

    /*
     * Every filter is a PARAMETER, including the optional ones — `NULL means
     * everything` rather than a clause built by hand. One query serves the
     * filtered and unfiltered cases, so there is no combination of filters
     * that runs SQL nobody has read.
     */
    const rows = await this.pool.query(
      `SELECT p.id::text AS posting_id, e.uuid AS entry_id, e.kind::text AS kind,
              e.description, e.occurred_at,
              a.kind::text AS account_kind,
              p.amount_minor::text AS amount_minor, p.currency,
              s.status
         FROM postings p
         JOIN accounts a        ON a.id = p.account_id
         JOIN journal_entries e ON e.id = p.journal_entry_id
         JOIN entry_status s    ON s.id = e.id
        WHERE a.owner_id = $1::bigint
          AND a.owner_type = 'user'
          AND ($2::text IS NULL OR p.currency = $2)
          AND ($3::text IS NULL OR e.kind::text = $3)
          AND ($4::bigint IS NULL OR p.id < $4::bigint)
        ORDER BY p.id DESC
        LIMIT $5`,
      [
        row.id,
        options.currency ?? null,
        options.kind ?? null,
        options.before ?? null,
        Math.min(Math.max(options.limit, 1), 200),
      ],
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * Freezes, unfreezes or closes an account.
   *
   * `users.status` is checked on every money path and nothing could change it
   * before this. Note that freezing does NOT touch balances: the money stays
   * the customer's and stays owed to them. Freezing stops it moving, which is
   * a different thing from taking it, and conflating the two is how a support
   * action becomes a seizure.
   */
  async setUserStatus(
    uuid: string,
    to: 'active' | 'frozen' | 'closed',
    actorUuid: string,
    reason: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const found = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

    if (row.status === to) {
      throw new ConflictException({ error: 'already_in_status', status: to });
    }
    if (row.status === 'closed') {
      // Closing is final. Reopening would resurrect an account somebody was
      // told no longer exists, and whose closure may have been a legal
      // requirement rather than a preference.
      throw new ConflictException({ error: 'account_closed' });
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET status = $2 WHERE id = $1::bigint`, [row.id, to]);
      await client.query(
        `INSERT INTO user_status_changes (user_id, from_status, to_status, changed_by, reason)
         VALUES ($1::bigint, $2, $3, $4::bigint, $5)`,
        [row.id, row.status, to, actorId, reason],
      );

      // Freezing revokes live sessions. Leaving them means a stolen session
      // keeps working for the rest of its access token's life on an account
      // somebody just decided was compromised.
      //
      // TWO THINGS HERE WERE WRONG and both were only visible against a real
      // database. The table is `auth_sessions`, not `sessions`, so freezing an
      // account — the most important thing support can do — raised and rolled
      // back every time. And `revocation_is_complete` requires the reason to
      // be set whenever `revoked_at` is: a bare timestamp fails the CHECK, so
      // even the right table name would have failed on the next line.
      if (to !== 'active') {
        await client.query(
          `UPDATE auth_sessions
              SET revoked_at = now(), revoked_reason = 'admin'
            WHERE user_id = $1::bigint AND revoked_at IS NULL`,
          [row.id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await this.audit.record({
      actorId: actorUuid,
      action: to === 'active' ? 'user.unfreeze' : to === 'frozen' ? 'user.freeze' : 'user.close',
      subjectType: 'user',
      subjectId: uuid,
      detail: { from: row.status, to },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });

    this.#logger.warn(`user ${uuid}: ${row.status} -> ${to} by ${actorUuid} (${reason})`);
    return { id: uuid, status: to };
  }

  /* ---------------------------- notifications -------------------------- */

  /**
   * WHETHER ANYTHING IS ACTUALLY BEING SENT.
   *
   * THE FAILURE THIS EXISTS FOR is named in 012 and in the go-live list and
   * had nowhere to be seen: with `NOTIFICATION_INTERVAL_SECONDS` unset, rows
   * accumulate in the outbox, the API keeps answering "check your email", and
   * NOTHING ERRORS — because writing the row succeeded. A password reset that
   * is never sent is a customer locked out of their own money, and the only
   * evidence was a table nobody could look at without psql.
   *
   * THREE QUESTIONS, NOT ONE. What is waiting (and how long the oldest has
   * been waiting, because a queue of three that has been three since Tuesday
   * is a queue nobody is working); what was given up on, which on staging is
   * every address outside the allowlist and in production is a real provider
   * refusal; and what went out, so "did they get it?" has an answer.
   *
   * NO BODY, EVER. `payload_sealed` is sealed precisely because a rendered
   * reset email carries a live bearer token, and a sent message has had its
   * body erased. This returns the recipient, the kind and the state — never a
   * column that could hold the message.
   */
  async notifications(): Promise<Record<string, unknown>> {
    const [backlog, abandoned, recent] = await Promise.all([
      this.pool.query(
        `SELECT class::text, kind::text, waiting::text, oldest, worst_attempts
           FROM notification_backlog ORDER BY class, kind`,
      ),
      this.pool.query(
        `SELECT id::text, kind::text, class::text, recipient, attempts,
                last_error, created_at
           FROM notifications_abandoned LIMIT 50`,
      ),
      // Straight from the table rather than a view, because "what went out"
      // is not an alert and 012 only built views for the two that are.
      this.pool.query(
        `SELECT id::text, kind::text, class::text, recipient, status::text,
                provider, sent_at, created_at
           FROM notification_outbox
          ORDER BY id DESC LIMIT 50`,
      ),
    ]);

    return {
      backlog: backlog.rows,
      abandoned: abandoned.rows,
      recent: recent.rows,
    };
  }

  /* ------------------------------ suspense ----------------------------- */

  async suspense(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT deposit_uuid, provider, provider_reference, amount_minor::text,
              currency, sender_name, sender_bank, suspense_reason, created_at,
              unresolved_for::text
         FROM admin_suspense LIMIT 200`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * Gives a suspense deposit to the customer it belongs to.
   *
   * By APPENDING a correcting entry, never by editing the original. The
   * original posting was a true statement — money arrived and we could not say
   * whose — and the correction is a second true statement made later. Editing
   * the first would erase the fact that we ever did not know.
   */
  async attributeDeposit(
    depositUuid: string,
    userUuid: string,
    actorUuid: string,
    reason: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const targetId = await this.#userId(userUuid);

    const found = await this.pool.query<{
      id: string;
      status: string;
      amount_minor: string;
      currency: string;
      provider_reference: string;
    }>(
      `SELECT id, status::text, amount_minor::text, currency, provider_reference
         FROM deposits WHERE uuid = $1`,
      [depositUuid],
    );
    const deposit = found.rows[0];
    if (deposit === undefined) throw new NotFoundException({ error: 'deposit_not_found' });
    if (deposit.status !== 'suspense') {
      throw new ConflictException({ error: 'not_in_suspense', status: deposit.status });
    }

    const currency = deposit.currency as Currency;
    const amount = money(BigInt(deposit.amount_minor), currency);

    await this.ledger.post({
      // Derived from the deposit, so a retry after a timeout is a replay
      // rather than a second credit.
      idempotencyKey: `suspense-attribute:${deposit.provider_reference}`,
      kind: 'adjustment',
      occurredAt: new Date(),
      description: 'suspense deposit attributed to a customer',
      metadata: { deposit: depositUuid, reason },
      postings: [
        posting({ kind: 'suspense', currency }, money(-amount.amount, currency)),
        posting({ kind: 'customer_wallet', ownerId: targetId, currency }, amount),
      ],
    });

    await this.pool.query(
      `UPDATE deposits SET status = 'credited', user_id = $2::bigint,
              virtual_account_id = (SELECT id FROM virtual_accounts
                                     WHERE user_id = $2::bigint AND currency = $3
                                       AND status <> 'closed' LIMIT 1)
        WHERE id = $1::bigint`,
      [deposit.id, targetId, deposit.currency],
    );

    await this.audit.record({
      actorId: actorUuid,
      action: 'deposit.attribute',
      subjectType: 'deposit',
      subjectId: depositUuid,
      detail: { to_user: userUuid, amount_minor: deposit.amount_minor, currency: deposit.currency },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });

    return { id: depositUuid, status: 'credited', user: userUuid };
  }

  /* ---------------------------- monitoring ----------------------------- */

  /** Held purchases and open crypto withdrawals — money waiting on an answer. */
  async stuck(): Promise<Record<string, unknown>> {
    const [purchases, withdrawals] = await Promise.all([
      this.pool.query(
        `SELECT purchase_uuid, provider, service, amount_minor::text, currency,
                created_at, held_for::text
           FROM pending_purchases LIMIT 100`,
      ),
      this.pool.query(
        `SELECT w.uuid, w.asset, w.network::text, w.amount_minor::text, w.status::text,
                w.created_at, w.tx_hash
           FROM crypto_withdrawals w
          WHERE w.status IN ('reserved','broadcast')
          ORDER BY w.created_at LIMIT 100`,
      ),
    ]);
    return { purchases: purchases.rows, crypto_withdrawals: withdrawals.rows };
  }

  /* --------------------------------- tax -------------------------------- */

  /**
   * What finance files, and what we hold against it.
   *
   * Every figure comes from a VIEW over the ledger rather than from a counter
   * this method maintains — a revenue number computed from a second record is
   * a revenue number that drifts, and the drift is discovered while filing.
   *
   * `drift` is the row nobody wants and everybody needs: tax held that no
   * collection explains means a path posted the money and forgot the record.
   */
  async tax(months: number): Promise<Record<string, unknown>> {
    const [collected, revenue, payable, drift] = await Promise.all([
      this.pool.query(
        `SELECT month, kind, currency, transactions::text,
                collected_minor::text, base_minor::text
           FROM tax_collected_monthly LIMIT $1`,
        [months * 8],
      ),
      this.pool.query(
        `SELECT month, account, currency, amount_minor::text
           FROM revenue_monthly LIMIT $1`,
        [months * 12],
      ),
      this.pool.query(`SELECT currency, balance_minor::text FROM tax_payable`),
      this.pool.query(
        `SELECT currency, collected_minor::text, held_minor::text,
                difference_minor::text
           FROM tax_remittance_drift`,
      ),
    ]);
    return {
      collected: collected.rows,
      revenue: revenue.rows,
      payable: payable.rows,
      drift: drift.rows,
    };
  }

  /* ------------------------------- staff ------------------------------- */

  async staff(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT u.uuid AS user_id, u.email, r.role::text, r.granted_at,
              g.email AS granted_by
         FROM staff_roles r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users g ON g.id = r.granted_by
        WHERE r.revoked_at IS NULL
        ORDER BY r.granted_at DESC`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  async grantRole(
    userUuid: string,
    role: string,
    actorUuid: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const targetId = await this.#userId(userUuid);

    if (targetId === actorId) {
      // Granting yourself a role defeats the point of there being roles.
      throw new BadRequestException({ error: 'cannot_grant_to_self' });
    }

    await this.pool
      .query(
        `INSERT INTO staff_roles (user_id, role, granted_by)
         VALUES ($1::bigint, $2::staff_role, $3::bigint)`,
        [targetId, role, actorId],
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('staff_roles_live_grant')) {
          throw new ConflictException({ error: 'already_granted' });
        }
        throw new BadRequestException({ error: 'invalid_role', detail: message });
      });

    await this.audit.record({
      actorId: actorUuid,
      action: 'staff.grant',
      subjectType: 'staff',
      subjectId: userUuid,
      detail: { role },
      ...(ip === undefined ? {} : { ip }),
    });

    return { user: userUuid, role };
  }

  async revokeRole(
    userUuid: string,
    role: string,
    actorUuid: string,
    ip?: string,
  ): Promise<Record<string, unknown>> {
    const actorId = await this.#userId(actorUuid);
    const targetId = await this.#userId(userUuid);

    const revoked = await this.pool.query(
      `UPDATE staff_roles SET revoked_at = now()
        WHERE user_id = $1::bigint AND role = $2::staff_role AND revoked_at IS NULL`,
      [targetId, role],
    );
    if (revoked.rowCount === 0) {
      throw new NotFoundException({ error: 'grant_not_found' });
    }

    await this.audit.record({
      actorId: actorUuid,
      action: 'staff.revoke',
      subjectType: 'staff',
      subjectId: userUuid,
      detail: { role },
      ...(ip === undefined ? {} : { ip }),
    });

    // Roles are read fresh on every request, so this takes effect on the
    // target's very next call rather than when their token expires.
    return { user: userUuid, role, revoked: true };
  }

  async #userId(uuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }
}
