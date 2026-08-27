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
}

export interface AdminUserDetail {
  readonly profile: Record<string, unknown>;
  readonly balances: readonly Record<string, unknown>[];
  readonly devices: readonly Record<string, unknown>[];
  readonly status_history: readonly Record<string, unknown>[];
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

export class AdminClient {
  readonly #baseUrl: string;
  readonly #session: Session;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; session: Session; fetch?: typeof fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#session = options.session;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
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

  /* ------------------------ provider credentials ----------------------- */

  async credentials(): Promise<readonly AdminCredential[]> {
    const body = await this.#get<{ credentials: AdminCredential[] }>('/v1/admin/credentials');
    return body.credentials;
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
