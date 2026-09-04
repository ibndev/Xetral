import { Session } from './session.js';
import { ApiError, toApiError } from './errors.js';

/**
 * The operations surface, as a separate client.
 *
 * Separate from `XetralClient` deliberately. These calls freeze accounts,
 * approve identity documents and change the transfer fee, and none of them
 * belongs within reach of a customer screen's autocomplete. Keeping them in
 * their own class means a customer page that imports the wrong thing does not
 * compile, rather than shipping an admin call behind a feature flag somebody
 * forgot.
 *
 * The server does not care which class made the request — `staff()` gates
 * every one of these routes on a role read fresh from the database, and that
 * is the real control. This is the second, cheaper one.
 */

export interface AdminOverview {
  readonly queues: readonly {
    readonly queue: string;
    readonly waiting: string;
    readonly oldest: string | null;
  }[];
  readonly liability: readonly {
    readonly currency: string;
    readonly wallets_minor: string;
    readonly pending_minor: string;
    readonly cards_minor: string;
    readonly total_owed_minor: string;
    readonly suspense_minor: string;
    readonly total_owed: string;
  }[];
  readonly activity: { readonly entries_24h?: string; readonly entries_1h?: string };
}

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly kyc_status: string | null;
  readonly created_at: string;
  /*
   * WHAT THE ACCOUNT ITSELF HOLDS, which this list did not carry at all.
   *
   * It showed an email address, a status and a date, so a support agent with
   * a name and a phone number on a call had nothing to search and nothing to
   * recognise. NOT the verified name: `users.full_name` is what somebody
   * typed about themselves and `kyc_submissions.full_name` is what a reviewer
   * read off a document — 040 keeps them apart, and only the second may reach
   * a money decision.
   */
  readonly full_name: string | null;
  /** What a REVIEWER read off a document, kept separate from `full_name` for
   *  040's reason: only this one may inform a money decision. Present here
   *  because accounts predating the signup name field have only this, and a
   *  customer list with no names in it is not a customer list. */
  readonly verified_name: string | null;
  readonly phone: string | null;
  readonly handle: string | null;
}

/**
 * One posting on a customer's account, as an operator sees it.
 *
 * WIDER THAN THE CUSTOMER'S OWN HISTORY: it includes `customer_pending`,
 * which is where a card authorization or a gift card hold sits, and which is
 * what a "missing" balance usually turns out to be.
 *
 * `amount_minor` is a STRING in minor units, like every amount that crosses
 * this boundary — a naira balance past 2^53 is not a number.
 */
export interface AdminUserTransaction {
  readonly posting_id: string;
  readonly entry_id: string;
  readonly kind: string;
  readonly description: string | null;
  readonly occurred_at: string;
  /** `customer_wallet`, `customer_pending` or `customer_card`. */
  readonly account_kind: string;
  readonly amount_minor: string;
  readonly currency: string;
  /** From `entry_status`, so it cannot disagree with the postings. */
  readonly status: string;
}

export interface AdminUserDetail {
  readonly profile: Record<string, unknown>;
  readonly balances: readonly Record<string, unknown>[];
  readonly devices: readonly Record<string, unknown>[];
  readonly status_history: readonly Record<string, unknown>[];
  /** Every tier this customer has held, and who moved them. */
  readonly tier_history: readonly Record<string, unknown>[];
  /** What their CURRENT tier allows, per currency, so an operator looking at a
   *  refused transfer does not have to hold the grid in their head. */
  readonly tier_limits: readonly Record<string, unknown>[];
  /** Their cards. Four digits of the number and no more — the same amount the
   *  database stores. */
  readonly cards: readonly Record<string, unknown>[];
}

/** Mirrors `SettingView` on the server, field for field. It did not, once:
 *  `value_type`/`min_value`/`max_value` here against `type`/`min`/`max` there
 *  rendered every bound as "min undefined" and every boolean as a text box. */
/**
 * A provider credential slot, and whether it is filled.
 *
 * THERE IS DELIBERATELY NO FIELD HERE THAT COULD HOLD A SECRET. The API has no
 * endpoint that returns one — not sealed, not masked — so this type could not
 * carry one even if somebody added the field. `hint` is the last four
 * characters, which answers "is this the key I pasted?" and nothing else.
 */
export interface AdminWebhookEndpoint {
  /** The path this API serves, exactly as the controller declares it. */
  readonly path: string;
  /** What a provider is being asked to send there. */
  readonly label: string;
  /** Which stored secret verifies its signature. */
  readonly secret: string;
  /** The whole URL when `WEBHOOK_BASE_URL` is configured, the bare path when
   *  it is not — never a hostname the server invented. */
  readonly url: string;
  readonly absolute: boolean;
}

/** A country the platform may operate in. `enabled` is whether it does. */
export interface AdminCountry {
  readonly code: string;
  readonly name: string;
  readonly dial_code: string;
  readonly currency: string;
  readonly enabled: boolean;
}

export interface AdminCredential {
  readonly provider: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** The environment variable this slot falls back to when no row is stored. */
  readonly env_var: string;
  /** FALSE for a slot documented ahead of its adapter. A filled box would
   *  otherwise imply an integration that is running. */
  readonly in_use: boolean;
  readonly is_set: boolean;
  readonly hint: string | null;
  readonly updated_at: string | null;
}

/**
 * A transaction the monitoring rules thought worth a look.
 *
 * An OBSERVATION, never a verdict. Nothing was refused, frozen or held because
 * of this — the rules run after the fact, so anything that must decide before
 * money moves lives in a ledger precondition instead. What this is, is a queue.
 */
export interface AdminRiskSignal {
  readonly id: string;
  /** 'large_value', 'structuring', 'rapid_passthrough', 'dormant_reactivation'
   *  or 'crypto_fast_out'. */
  readonly rule: string;
  /** The numbers the rule saw, so a reviewer can check its arithmetic rather
   *  than trust it. Amounts here are STRINGS in minor units, like every other
   *  amount that crosses this boundary. */
  readonly detail: Readonly<Record<string, string>>;
  readonly observed_at: string;
  readonly user_uuid: string;
  readonly email: string | null;
  readonly user_status: string;
  /** How many OTHER open signals this customer has. One signal is a
   *  transaction; several is a pattern. */
  readonly other_open_signals: number;
}

/**
 * One investigation about one customer.
 *
 * There is deliberately no customer-facing counterpart to any of this. Tipping
 * off is an offence, so a case must not be reachable by its subject — not as a
 * status, not as a message, not through a support agent reading a note.
 */
export interface AdminRiskCase {
  readonly id: string;
  readonly user_uuid: string;
  readonly email: string | null;
  readonly user_status: string;
  readonly reason: string | null;
  readonly opened_at: string;
  readonly due_at: string;
  readonly overdue: boolean;
  /** TRUE when the monitoring sweep opened it by counting rather than a person
   *  by judging — a different starting point, so a reviewer is told which. */
  readonly opened_by_the_sweep: boolean;
  readonly opened_by_email: string | null;
  readonly signals: number;
  readonly notes: number;
}

export type AdminCaseOutcome = 'no_action' | 'reported' | 'account_restricted';

export interface AdminSetting {
  readonly key: string;
  readonly value: string;
  readonly type: string;
  readonly min: string | null;
  readonly max: string | null;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly sensitive: boolean;
  readonly updated_at: string;
}

export interface AdminSuspenseDeposit {
  readonly deposit_uuid: string;
  readonly provider: string;
  readonly provider_reference: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly sender_name: string | null;
  readonly sender_bank: string | null;
  readonly suspense_reason: string | null;
  readonly created_at: string;
  readonly unresolved_for: string;
}

export interface AdminKycSubmission {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly bvn_last4: string;
  readonly date_of_birth: string;
  readonly phone: string;
  readonly address: string;
  readonly created_at: string;
}

export interface AdminStaffGrant {
  readonly user_id: string;
  readonly email: string;
  readonly role: string;
  readonly granted_at: string;
  readonly granted_by: string | null;
}

export interface AdminAuditEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly reason: string | null;
  readonly ip_address: string | null;
  readonly created_at: string;
}

export type StaffRole =
  | 'giftcard_reviewer'
  | 'support'
  | 'compliance'
  | 'finance'
  | 'admin';

/**
 * The tax report. Minor units as strings throughout — a return is the last
 * place a JSON number should be allowed near an amount.
 */
export interface AdminTaxReport {
  readonly collected: readonly {
    readonly month: string;
    readonly kind: string;
    readonly currency: string;
    readonly transactions: string;
    readonly collected_minor: string;
    readonly base_minor: string;
  }[];
  readonly revenue: readonly {
    readonly month: string;
    readonly account: string;
    readonly currency: string;
    readonly amount_minor: string;
  }[];
  readonly payable: readonly {
    readonly currency: string;
    readonly balance_minor: string;
  }[];
  /** Tax held that no collection explains. Empty is the only good answer. */
  readonly drift: readonly {
    readonly currency: string;
    readonly collected_minor: string;
    readonly held_minor: string;
    readonly difference_minor: string;
  }[];
}

export interface AdminConsentReport {
  readonly summary: readonly {
    readonly kind: string;
    readonly version: string;
    readonly customers: string;
  }[];
  readonly outstanding: readonly {
    readonly uuid: string;
    readonly email: string | null;
    readonly kind: string;
    readonly version: string;
    readonly published_at: string;
  }[];
}

export interface AdminDataRequest {
  readonly uuid: string;
  readonly kind: string;
  readonly requested_at: string;
  readonly deadline_at: string;
  readonly user_uuid: string;
  readonly email: string | null;
  readonly overdue: boolean;
}

export interface AdminPrices {
  /** Live only: what a customer will be quoted today. */
  readonly prices: readonly {
    readonly kind: string;
    readonly uuid: string;
    readonly subject: string;
    readonly price: string;
    readonly terms: string;
    readonly effective_from: string;
  }[];
  /** Live prices with no author — written at a psql prompt rather than here. */
  readonly unattributed: readonly {
    readonly kind: string;
    readonly uuid: string;
    readonly subject: string;
  }[];
  readonly fx_policies: readonly {
    readonly uuid: string;
    readonly base_currency: string;
    readonly quote_currency: string;
    readonly spread_basis_points: number;
    readonly min_base_minor: string;
    readonly effective_from: string;
    readonly retired_at: string | null;
    readonly published_by: string | null;
  }[];
  readonly rate_cards: readonly {
    readonly uuid: string;
    readonly brand: string;
    readonly country: string;
    readonly card_type: string;
    readonly face_currency: string;
    readonly payout_currency: string;
    readonly payout_rate_minor: string;
    readonly min_face_minor: string;
    readonly max_face_minor: string;
    readonly effective_from: string;
    readonly retired_at: string | null;
    readonly published_by: string | null;
  }[];
}

/**
 * What a deployment has not been told yet.
 *
 * `state` is deliberately four values rather than a boolean. `unset-here` is
 * the one that matters: a worker interval belongs on ONE instance, so its
 * absence from the API container is correct and reporting it as a fault would
 * mean nine false findings on every production deployment.
 */
export interface AdminReadinessRow {
  readonly name: string;
  readonly kind: 'env' | 'setting' | 'credential' | 'action';
  readonly failure:
    | 'refuses-to-boot'
    | 'refuses-the-first-request'
    | 'silent'
    | 'wrong-by-default'
    | 'default-is-deliberate';
  readonly state: 'set' | 'unset' | 'unset-here' | 'not-observable';
  readonly ifMissed: string;
  readonly flow?: string;
}

export interface AdminReadiness {
  readonly instance: { readonly environment: string; readonly hostname: string };
  readonly rows: readonly AdminReadinessRow[];
  readonly summary: {
    readonly unset: number;
    readonly unsetHere: number;
    readonly notObservable: number;
    readonly silentAndUnset: number;
  };
}

/**
 * One question asked of the naira rail, and its answer.
 *
 * `detail` may quote the PROVIDER'S OWN sentence, which is the part worth
 * having and the part a customer must never see — every route that produces
 * one is `staff()`. It never carries a credential: the API has no endpoint
 * that returns one, so this type could not be filled with one even if a field
 * were added.
 */
export interface AdminDiagnosticCheck {
  readonly name: string;
  readonly state: 'pass' | 'fail' | 'warn' | 'skip';
  readonly detail: string;
}

/**
 * A failure the deployment has actually had, in the exception's own words.
 *
 * These have been recorded since 015 and nothing ever rendered them, so the
 * sentence explaining a 500 was in the database the whole time and only psql
 * could read it. `reference` joins it to the six characters somebody read off
 * their screen.
 */
export interface AdminRecentFailure {
  readonly route: string | null;
  readonly status: number | null;
  readonly message: string;
  readonly occurrences: string;
  readonly lastSeen: string;
  readonly reference: string | null;
}

/**
 * Money held against something that never completed.
 *
 * `hours_held` rather than a timestamp alone: a queue of three that has been
 * three since Tuesday is a queue nobody is working, and the age is what says
 * which. Amounts are STRINGS in minor units, like every amount that crosses
 * this boundary.
 */
export interface AdminHeldMoney {
  readonly kind: 'bank_payout' | 'purchase';
  readonly subject_uuid: string;
  readonly user_id: string;
  readonly email: string | null;
  readonly currency: string;
  readonly amount_minor: string;
  readonly status: string;
  readonly created_at: string;
  readonly hours_held: number;
  /** Where it was going — the bank and account, or the service and target. */
  readonly destination: string;
}

/** What was given back, by whom, and why. Append-only on the server. */
export interface AdminRecoveryRecord {
  readonly uuid: string;
  readonly kind: string;
  readonly subject_uuid: string;
  readonly email: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly reason: string;
  readonly actioned_by: string | null;
  readonly created_at: string;
}

export interface AdminFundingDiagnosis {
  /** Which rail opens the NEXT account. Accounts already issued keep working
   *  at whoever issued them, so this is not a claim about them. */
  readonly rail: string;
  readonly checks: readonly AdminDiagnosticCheck[];
  /** Most recent first. Empty is the good answer. */
  readonly failures: readonly AdminRecentFailure[];
}

/**
 * The outbox, as an operator sees it.
 *
 * THERE IS DELIBERATELY NO FIELD HERE THAT COULD HOLD A MESSAGE. A rendered
 * password reset carries a live bearer token, which is why 012 seals every
 * payload and erases it the moment the message is sent — so this type could
 * not carry one even if somebody added the field.
 */
export interface AdminNotifications {
  /** What is waiting, per class and kind. `oldest` is the half that matters:
   *  a queue of three that has been three since Tuesday is a queue nobody is
   *  working. */
  readonly backlog: readonly {
    readonly class: string;
    readonly kind: string;
    readonly waiting: string;
    readonly oldest: string | null;
    readonly worst_attempts: number;
  }[];
  /** Given up on. On staging that is every address outside the allowlist; in
   *  production it is a real provider refusal. */
  readonly abandoned: readonly {
    readonly id: string;
    readonly kind: string;
    readonly class: string;
    readonly recipient: string;
    readonly attempts: number;
    readonly last_error: string | null;
    readonly created_at: string;
  }[];
  readonly recent: readonly {
    readonly id: string;
    readonly kind: string;
    readonly class: string;
    readonly recipient: string;
    readonly status: string;
    readonly provider: string | null;
    readonly sent_at: string | null;
    readonly created_at: string;
  }[];
}

export interface AdminProviderHealth {
  readonly degraded: readonly {
    readonly provider: string;
    readonly operation: string;
    readonly attempts: string;
    readonly failures: string;
    readonly failure_percent: number;
    readonly last_error: string | null;
    /** They changed their API: the same request fails for ever, so waiting
     *  does not help. The one that should page somebody. */
    readonly contract_broken: boolean;
  }[];
  readonly recent: readonly {
    readonly provider: string;
    readonly operation: string;
    readonly attempts: string;
    readonly succeeded: string;
    /** Refusals. NOT counted as ill health: a declined card is the provider
     *  working. */
    readonly rejected: string;
    readonly unavailable: string;
    readonly timed_out: string;
    readonly contract: string;
    readonly failures: string;
    readonly failure_percent: number;
    readonly last_seen: string;
    readonly last_error: string | null;
  }[];
}

export class AdminClient {
  readonly #baseUrl: string;
  readonly #session: Session;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; session: Session; fetch?: typeof fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#session = options.session;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Turning a valid authenticator code into an elevated session.
   *
   * IT LIVES HERE, AND ITS ABSENCE WAS A BUG THAT BROKE EVERY ACTING ROUTE.
   *
   * `elevation.tsx` wraps this client in a Proxy: a `totp_required` refusal
   * becomes a prompt, the code is exchanged for an elevated session, and the
   * original call is retried. That is the right shape, and it called
   * `target.elevateStaffSession(code)` on a class that did not have the
   * method — `XetralClient` did. The Proxy reached for it through a cast, so
   * the compiler was satisfied and the failure was a runtime TypeError, which
   * is not an `ApiError` and therefore rendered as "Something went wrong."
   *
   * So an operator holding a correct PIN and a correct six-digit code was
   * told, every single time, that something had gone wrong — and nothing on
   * the dashboard could be saved at all. `elevation.test.ts` now asserts the
   * method is here, because a cast asserting a method exists is exactly what
   * hid it.
   *
   * ONE CODE BUYS THE WINDOW, not one action: codes are single-use and rotate
   * every thirty seconds, so a per-action code refuses a reviewer on their
   * second approval and the end of that is a shared authenticator on a desk.
   * The transaction PIN is still required on every acting request inside it.
   */
  async elevateStaffSession(code: string): Promise<void> {
    await this.#post('/v1/auth/totp/elevate', { totp_code: code });
  }

  /* ----------------------------- monitoring ---------------------------- */

  async overview(): Promise<AdminOverview> {
    return this.#get('/v1/admin/overview');
  }

  /**
   * The number to read every morning.
   *
   * `ledger_drift` compares each account's materialised balance against the
   * sum of its own postings. A non-empty result means a trigger did not fire
   * or something wrote around the ledger, and no other figure on the dashboard
   * means anything until this one is empty.
   */
  async drift(): Promise<readonly Record<string, unknown>[]> {
    const body = await this.#get<{ drift: Record<string, unknown>[] }>('/v1/admin/drift');
    return body.drift;
  }

  /** Money held against an outcome nobody has resolved. */
  async stuck(): Promise<{
    purchases: readonly Record<string, unknown>[];
    crypto_withdrawals: readonly Record<string, unknown>[];
  }> {
    return this.#get('/v1/admin/stuck');
  }

  /* -------------------------------- users ------------------------------ */

  async users(query: {
    search?: string;
    status?: string;
    limit?: number;
    before?: string;
  } = {}): Promise<readonly AdminUser[]> {
    const params = new URLSearchParams();
    if (query.search !== undefined && query.search !== '') params.set('search', query.search);
    if (query.status !== undefined) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before !== undefined) params.set('before', query.before);

    const suffix = params.toString();
    const body = await this.#get<{ users: AdminUser[] }>(
      `/v1/admin/users${suffix === '' ? '' : `?${suffix}`}`,
    );
    return body.users;
  }

  async user(id: string): Promise<AdminUserDetail> {
    return this.#get(`/v1/admin/users/${encodeURIComponent(id)}`);
  }

  /**
   * Freeze, unfreeze or close.
   *
   * `reason` is required by the server and by the database, not merely by this
   * signature: `user_status_changes` has a NOT NULL reason. An operator who
   * cannot say why should not be freezing an account.
   */
  async setUserStatus(
    id: string,
    status: 'active' | 'frozen' | 'closed',
    reason: string,
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/users/${encodeURIComponent(id)}/status`, {
      status,
      reason,
      transaction_pin: pin,
    });
  }

  /* --------------------------------- kyc ------------------------------- */

  async kycQueue(): Promise<readonly AdminKycSubmission[]> {
    const body = await this.#get<{ queue: AdminKycSubmission[] }>('/v1/admin/kyc');
    return body.queue;
  }

  /**
   * Approve or reject.
   *
   * `pin` is not optional: `POST /v1/admin/kyc/:id/review` declares
   * `pin: true`, so a reviewer who walked away from an unlocked laptop has not
   * left the ability to approve identity documents behind. Approving is also
   * what creates the Bitnob `provider_customers` mapping, which is what lets
   * that customer hold a card and a bank account — it is the single most
   * consequential button in the dashboard.
   */
  async reviewKyc(
    id: string,
    decision: 'approve' | 'reject',
    pin: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/kyc/${encodeURIComponent(id)}/review`, {
      decision,
      transaction_pin: pin,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /* ----------------------------- gift cards ---------------------------- */

  /** Empty unless `gift_cards_enabled` is on. The routes still authenticate
   *  when the feature is off — a disabled feature must not become an
   *  unauthenticated one — so this answers `gift_cards_disabled`, not 401. */
  async giftCardQueue(): Promise<readonly Record<string, unknown>[]> {
    const body = await this.#get<{ queue: Record<string, unknown>[] }>(
      '/v1/admin/giftcards/queue',
    );
    return body.queue;
  }

  /** Reveals ONE card code, deliberately, against one submission. The queue
   *  listing carries none: a page of bearer instruments in a browser tab is a
   *  page of bearer instruments in a screenshot and a log. */
  async revealGiftCard(id: string): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/giftcards/${encodeURIComponent(id)}/reveal`, {});
  }

  async reviewGiftCard(
    id: string,
    decision: 'approve' | 'reject',
    pin: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/giftcards/${encodeURIComponent(id)}/review`, {
      decision,
      transaction_pin: pin,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async clawbackGiftCard(id: string, reason: string, pin: string): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/giftcards/${encodeURIComponent(id)}/clawback`, {
      reason,
      transaction_pin: pin,
    });
  }

  /* ----------------------------- data rights ---------------------------- */

  /** Requests for a copy of somebody's data, or for it to be erased. Worst
   *  deadline first: a statutory window is one of the few here whose
   *  consequence is regulatory rather than an unhappy customer. */
  async dataRequests(): Promise<readonly AdminDataRequest[]> {
    const body = await this.#get<{ requests: AdminDataRequest[] }>('/v1/admin/data-requests');
    return body.requests;
  }

  /** Carries out an erasure. The one action in this system that cannot be
   *  undone by appending, which is why it takes a PIN. */
  async eraseCustomer(id: string, pin: string): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/data-requests/${encodeURIComponent(id)}/erase`, {
      transaction_pin: pin,
    });
  }

  /** Closes a request answered some other way. The outcome is required and
   *  must be twenty characters: a queue cleared with one-word answers is
   *  indistinguishable from one nobody worked. */
  async resolveDataRequest(
    id: string,
    status: 'completed' | 'refused',
    outcome: string,
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/data-requests/${encodeURIComponent(id)}/resolve`, {
      status,
      outcome,
      transaction_pin: pin,
    });
  }

  /* ---------------------------- provider health ------------------------- */

  /**
   * Whether the providers are answering.
   *
   * `degraded` is what needs acting on; `recent` includes the ones that are
   * fine, which is what makes "quiet because nothing is wrong"
   * distinguishable from "quiet because nothing is being called".
   */
  async providerHealth(): Promise<AdminProviderHealth> {
    return this.#get<AdminProviderHealth>('/v1/admin/providers');
  }

  /* ------------------------------- readiness ---------------------------- */

  /**
   * What THIS instance has not been told yet.
   *
   * It answers for the process that served the request, which is why the
   * response names it: on a deployment where the workers run in their own
   * container, every worker interval is `unset-here` on the API and set on
   * the worker.
   */
  async readiness(): Promise<AdminReadiness> {
    return this.#get<AdminReadiness>('/v1/admin/readiness');
  }

  /**
   * Why opening a naira account is failing, in sentences.
   *
   * Distinct from `readiness`, which asks whether a value is SET. Every
   * reason this flow refuses survives that check: a key from the other
   * Paystack domain is set, a `preferred_bank` slug the business is not
   * approved for is set, and a dedicated-account product that was never
   * enabled needs no setting at all.
   */
  /**
   * Everything that happened in one customer's account.
   *
   * Keyset paginated on `posting_id`: pass the last row's id as `before` for
   * the next page. `OFFSET` shifts under an active account and produces
   * duplicates and gaps, which on a support screen reads as money appearing
   * and disappearing.
   */
  async userTransactions(
    id: string,
    options: {
      readonly currency?: string;
      readonly kind?: string;
      readonly before?: string;
      readonly limit?: number;
    } = {},
  ): Promise<readonly AdminUserTransaction[]> {
    const query = new URLSearchParams();
    if (options.currency !== undefined) query.set('currency', options.currency);
    if (options.kind !== undefined) query.set('kind', options.kind);
    if (options.before !== undefined) query.set('before', options.before);
    query.set('limit', String(options.limit ?? 50));

    const body = await this.#get<{ transactions: AdminUserTransaction[] }>(
      `/v1/admin/users/${encodeURIComponent(id)}/transactions?${query.toString()}`,
    );
    return body.transactions;
  }

  /**
   * Money waiting for a person, and what has already been given back.
   *
   * Both in one call, because "has somebody already dealt with this?" is asked
   * in the same breath as "what is waiting?".
   */
  async recoveryQueue(): Promise<{
    readonly waiting: readonly AdminHeldMoney[];
    readonly recovered: readonly AdminRecoveryRecord[];
  }> {
    return this.#get('/v1/admin/recovery');
  }

  /**
   * Give one held row back to the customer.
   *
   * THERE IS NO AMOUNT PARAMETER, deliberately. The sum comes from the held
   * row on the server, so this cannot credit an arbitrary customer an
   * arbitrary amount — and the server refuses a body carrying one rather than
   * ignoring it.
   */
  async recover(
    kind: 'bank_payout' | 'purchase',
    subjectUuid: string,
    reason: string,
    pin: string,
  ): Promise<AdminRecoveryRecord> {
    return this.#post(
      `/v1/admin/recovery/${encodeURIComponent(kind)}/${encodeURIComponent(subjectUuid)}`,
      { reason, transaction_pin: pin },
    );
  }

  /** Whether anything is actually being sent. Carries no message body. */
  async notifications(): Promise<AdminNotifications> {
    return this.#get<AdminNotifications>('/v1/admin/notifications');
  }

  async fundingDiagnostics(): Promise<AdminFundingDiagnosis> {
    return this.#get<AdminFundingDiagnosis>('/v1/admin/funding/diagnostics');
  }

  /**
   * Clear the recent-failure list.
   *
   * ACKNOWLEDGED, NOT DELETED — the records stay, and anything still failing
   * reopens itself on its next occurrence, so this cannot be used to make a
   * live fault disappear. Answers how many were cleared, which is how an
   * operator tells "I cleared them" from "they were already gone".
   */
  async clearFailures(): Promise<{ readonly resolved: number }> {
    return this.#post<{ readonly resolved: number }>('/v1/admin/errors/resolve-all', {});
  }

  /* -------------------------------- pricing ----------------------------- */

  /**
   * What a customer will be quoted today, and everything that has ever been
   * published.
   *
   * The retired rows are the point rather than clutter: a published price is
   * append-only precisely so a quote given last month can be explained.
   */
  async prices(): Promise<AdminPrices> {
    return this.#get<AdminPrices>('/v1/admin/prices');
  }

  /**
   * Publishes an FX spread for ONE PAIR AND ONE DIRECTION.
   *
   * Publishing NGN/USD does not publish USD/NGN: a rate is a ratio, and
   * "minor units per major unit" collapses in one of the two directions, so
   * each is priced on its own.
   */
  async publishFxSpread(
    input: {
      readonly base_currency: string;
      readonly quote_currency: string;
      readonly spread_basis_points: number;
      /** MINOR UNITS as a string. It is a bigint in Postgres. */
      readonly min_base_minor: string;
    },
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post('/v1/admin/prices/fx', { ...input, transaction_pin: pin });
  }

  /** Publishes a gift card rate for one brand, country, type and face band.
   *  A band overlapping a live one is REFUSED, not merged. */
  async publishRateCard(
    input: {
      readonly brand: string;
      readonly country: string;
      readonly card_type: 'ecode' | 'physical';
      readonly face_currency: string;
      readonly payout_currency: string;
      readonly payout_rate_minor: string;
      readonly min_face_minor: string;
      readonly max_face_minor: string;
    },
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post('/v1/admin/prices/giftcard', { ...input, transaction_pin: pin });
  }

  /**
   * Retires a price. It stops being quoted and stays on record.
   *
   * The reason is required, because until a replacement is published the flow
   * this priced REFUSES every customer — an unpublished FX pair is not quoted
   * from a default.
   */
  async retirePrice(
    uuid: string,
    kind: 'fx' | 'giftcard',
    reason: string,
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/prices/${encodeURIComponent(uuid)}/retire`, {
      kind,
      reason,
      transaction_pin: pin,
    });
  }

  /* ------------------------------- consent ------------------------------ */

  /**
   * Who has not agreed to the words currently in force.
   *
   * Empty is the resting state, and it fills the moment a notice is
   * republished — which is exactly when somebody needs to look at it.
   */
  async consents(): Promise<AdminConsentReport> {
    return this.#get<AdminConsentReport>('/v1/admin/consents');
  }

  /* --------------------------------- tax -------------------------------- */

  /**
   * What was collected for a revenue authority, and what is still held.
   *
   * Every amount stays a STRING, the way every amount does on this client.
   * These are the figures a return is filed from, so the one place a float
   * must never appear is here.
   */
  async tax(months = 12): Promise<AdminTaxReport> {
    return this.#get<AdminTaxReport>(`/v1/admin/tax?months=${String(months)}`);
  }

  /* ------------------------------ suspense ----------------------------- */

  async suspense(): Promise<readonly AdminSuspenseDeposit[]> {
    const body = await this.#get<{ deposits: AdminSuspenseDeposit[] }>('/v1/admin/suspense');
    return body.deposits;
  }

  async attributeDeposit(
    id: string,
    userId: string,
    reason: string,
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/suspense/${encodeURIComponent(id)}/attribute`, {
      user_id: userId,
      reason,
      transaction_pin: pin,
    });
  }

  /* ------------------------------ settings ----------------------------- */

  async settings(): Promise<readonly AdminSetting[]> {
    const body = await this.#get<{ settings: AdminSetting[] }>('/v1/admin/settings');
    return body.settings;
  }

  async settingHistory(key: string): Promise<readonly Record<string, unknown>[]> {
    const body = await this.#get<{ history: Record<string, unknown>[] }>(
      `/v1/admin/settings/${encodeURIComponent(key)}/history`,
    );
    return body.history;
  }

  async setSetting(key: string, value: string, pin: string): Promise<AdminSetting> {
    return this.#post(`/v1/admin/settings/${encodeURIComponent(key)}`, {
      value,
      transaction_pin: pin,
    });
  }

  /* --------------------------- risk monitoring ------------------------- */

  async riskSignals(): Promise<readonly AdminRiskSignal[]> {
    const body = await this.#get<{ signals: AdminRiskSignal[] }>('/v1/admin/risk/signals');
    return body.signals;
  }

  async resolveRiskSignal(
    id: string,
    resolution: string,
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/risk/signals/${encodeURIComponent(id)}/resolve`, {
      resolution,
      transaction_pin: pin,
    });
  }

  /* -------------------------------- cards ------------------------------ */

  /** One card's whole life. Carries four digits of the number and no more —
   *  there is no endpoint that returns a PAN to anybody but the customer who
   *  proved a PIN. */
  async card(id: string): Promise<Record<string, unknown>> {
    return this.#get(`/v1/admin/cards/${encodeURIComponent(id)}`);
  }

  /** Freezes a card on a customer's behalf. There is deliberately no staff
   *  terminate: it moves their money and cannot be undone. */
  async freezeCard(id: string, reason: string, pin: string): Promise<void> {
    await this.#post(`/v1/admin/cards/${encodeURIComponent(id)}/freeze`, {
      reason,
      transaction_pin: pin,
    });
  }

  /* ---------------------------- case files ----------------------------- */

  async riskCases(): Promise<readonly AdminRiskCase[]> {
    const body = await this.#get<{ cases: AdminRiskCase[] }>('/v1/admin/risk/cases');
    return body.cases;
  }

  async riskCase(id: string): Promise<Record<string, unknown>> {
    return this.#get(`/v1/admin/risk/cases/${encodeURIComponent(id)}`);
  }

  async openRiskCase(userId: string, reason: string): Promise<{ id: string }> {
    return this.#post('/v1/admin/risk/cases', { user_id: userId, reason });
  }

  /** No PIN. A reviewer writes several notes while working one case, and
   *  demanding the factor on each is how a shared authenticator ends up on
   *  somebody's desk. */
  async noteRiskCase(id: string, note: string): Promise<void> {
    await this.#post(`/v1/admin/risk/cases/${encodeURIComponent(id)}/notes`, { note });
  }

  async closeRiskCase(
    id: string,
    decision: {
      readonly outcome: AdminCaseOutcome;
      readonly summary: string;
      readonly report_reference?: string;
    },
    pin: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(`/v1/admin/risk/cases/${encodeURIComponent(id)}/close`, {
      ...decision,
      transaction_pin: pin,
    });
  }

  /* ------------------------ provider credentials ----------------------- */

  /**
   * The credential slots, and the webhook endpoints those secrets verify.
   *
   * One call, because it is one job: an operator configuring a provider pastes
   * a key here and a URL into the provider's dashboard, and showing only the
   * first half is how the second gets guessed.
   */
  /**
   * Where the platform operates, and what a country may be given.
   *
   * `currencies` comes from the MONEY REGISTRY rather than from a list on
   * this screen — an operator cannot type a currency the code does not know,
   * because one invented at runtime would have no exponent and every amount
   * in it would be wrong by a power of ten.
   */
  async countries(): Promise<{
    countries: readonly AdminCountry[];
    currencies: readonly { code: string; name: string }[];
  }> {
    return this.#get('/v1/admin/countries');
  }

  /** Added CLOSED, always. Opening it is a second, deliberate act. */
  async addCountry(input: {
    code: string;
    name: string;
    dialCode: string;
    currency: string;
  }): Promise<AdminCountry> {
    return this.#post('/v1/admin/countries', {
      code: input.code,
      name: input.name,
      dial_code: input.dialCode,
      currency: input.currency,
    });
  }

  /**
   * Open or close a country.
   *
   * The DATABASE decides whether opening is allowed: a currency with no
   * ceiling at every tier, or nothing monitoring it, is refused with a
   * message naming which — and the screen shows that message rather than a
   * generic one, because "add kyc_tier_limits rows for GHS" is the whole of
   * what an operator needs to act.
   */
  async setCountryEnabled(code: string, enabled: boolean): Promise<AdminCountry> {
    return this.#post(`/v1/admin/countries/${encodeURIComponent(code)}`, { enabled });
  }

  async credentials(): Promise<{
    slots: readonly AdminCredential[];
    webhooks: readonly AdminWebhookEndpoint[];
  }> {
    const body = await this.#get<{
      credentials: AdminCredential[];
      webhooks: AdminWebhookEndpoint[];
    }>('/v1/admin/credentials');
    return { slots: body.credentials, webhooks: body.webhooks ?? [] };
  }

  /** That a credential was replaced, by whom and when — never what it was. */
  async credentialRotations(
    provider: string,
    name: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const body = await this.#get<{ rotations: Record<string, unknown>[] }>(
      `/v1/admin/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}/rotations`,
    );
    return body.rotations;
  }

  /** Returns the slot's new STATUS, which carries a hint and no secret. There
   *  is no response shape here that could echo the pasted value back. */
  /**
   * Store a provider key.
   *
   * NO TRANSACTION PIN, and its removal is a correction rather than a
   * loosening. A transaction PIN authorises money leaving a CUSTOMER'S OWN
   * account; pasting a provider key moves nothing and is already gated by the
   * `admin` role and by a session elevated with an authenticator code. Asking
   * for it meant every operator had to hold a customer PIN to do their job.
   */
  /**
   * Pastes a provider credential. TAKES A PIN.
   *
   * It moves no money in this request and it decides where all of it goes
   * afterwards: the value written here is what every provider call
   * authenticates with, so replacing it can point the funding rail, the card
   * issuer or the payout rail somewhere else. The authenticator code is
   * handled by the elevation prompt rather than by a second field here —
   * two boxes on one form asking for two different six-digit secrets is how
   * an operator holding both correct ones gets told they are wrong.
   */
  async setCredential(
    provider: string,
    name: string,
    secret: string,
    pin: string,
  ): Promise<AdminCredential> {
    return this.#post(
      `/v1/admin/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}`,
      { secret, transaction_pin: pin },
    );
  }

  /* -------------------------------- staff ------------------------------ */

  async staff(): Promise<readonly AdminStaffGrant[]> {
    const body = await this.#get<{ staff: AdminStaffGrant[] }>('/v1/admin/staff');
    return body.staff;
  }

  async grantRole(userId: string, role: StaffRole, pin: string): Promise<Record<string, unknown>> {
    return this.#post('/v1/admin/staff/grant', {
      user_id: userId,
      role,
      transaction_pin: pin,
    });
  }

  async revokeRole(userId: string, role: StaffRole, pin: string): Promise<Record<string, unknown>> {
    return this.#post('/v1/admin/staff/revoke', {
      user_id: userId,
      role,
      transaction_pin: pin,
    });
  }

  /* -------------------------------- audit ------------------------------ */

  async audit(query: { limit?: number; before?: string } = {}): Promise<readonly AdminAuditEntry[]> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before !== undefined) params.set('before', query.before);
    const suffix = params.toString();

    const body = await this.#get<{ entries: AdminAuditEntry[] }>(
      `/v1/admin/audit${suffix === '' ? '' : `?${suffix}`}`,
    );
    return body.entries;
  }

  /* ------------------------------ plumbing ----------------------------- */

  async #get<T>(path: string): Promise<T> {
    return this.#request<T>('GET', path);
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>('POST', path, body);
  }

  async #request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.#session.accessToken();

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new ApiError('network', 0, [], String(cause));
    }

    if (response.status === 401 && !retried) {
      await this.#session.refresh();
      return this.#request<T>(method, path, body, true);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response.status, payload);
    return payload as T;
  }
}
