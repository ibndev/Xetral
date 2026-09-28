import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import type {
  DeliveryEvent,
  NotificationMessage,
  NotificationPort,
  NotificationReceipt,
} from '../ports/notification.js';

const PROVIDER = 'brevo';

/**
 * `NotificationPort` implemented against Brevo.
 *
 * THE TRANSACTIONAL API, NOT THE CAMPAIGN ONE, and that is the first decision
 * rather than a detail. Brevo has two ways to send mail:
 *
 *   POST /v3/smtp/email        one message to a named recipient, sent NOW
 *   POST /v3/emailCampaigns    a campaign to a LIST, scheduled, unsubscribable
 *
 * Everything this platform sends is the first kind. A password reset, a
 * new-device alert and a receipt are addressed to one person, are expected
 * within seconds, and must reach somebody who has unsubscribed from
 * marketing — 033's trigger already refuses a `marketing`-class message to a
 * customer with no live grant, and the whole point of that rule is that
 * security and transactional mail is untouched by it. Sent as a campaign,
 * a reset link would be rate-shaped for bulk, carry an unsubscribe footer,
 * and be suppressed for anybody who had ever opted out. That is a customer
 * locked out of their own money by an unsubscribe.
 *
 * THE WIRE CONTRACT, from Brevo's published transactional API:
 *
 *   - base URL     `https://api.brevo.com`
 *   - send         `POST /v3/smtp/email`
 *   - auth         `api-key: <key>`  — a HEADER OF ITS OWN, not a bearer token
 *   - sender       `{ "sender": { "name": ..., "email": ... } }`
 *   - recipients   `{ "to": [{ "email": ... }] }`  — a LIST OF OBJECTS
 *   - body         `htmlContent` / `textContent`
 *   - success      `201` with `{ "messageId": "<...>" }`
 *   - failure      `{ "code": "<slug>", "message": "..." }`
 *
 * THREE PLACES THIS DIFFERS FROM RESEND IN A WAY THAT FAILS SILENTLY IF
 * COPIED, which is why the adapter is written out rather than adapted:
 *
 *   1. AUTH IS `api-key`, NOT `Authorization: Bearer`. A bearer token gets a
 *      401 that reads as a wrong key — the exact misdiagnosis `bitnob/signing.ts`
 *      exists because of.
 *   2. `to` IS A LIST OF OBJECTS, not a list of strings. A string array is
 *      rejected as a malformed body, not as a bad address.
 *   3. SUCCESS IS 201, NOT 200. `response.ok` covers both, and code that
 *      checked `=== 200` would treat every successful send as a failure and
 *      retry it for ever.
 *
 * AND ONE THING BREVO DOES NOT HAVE: an idempotency key. Resend takes
 * `Idempotency-Key` and that is what made a retry safe there. Brevo's
 * transactional endpoint has no equivalent, so the duplicate guard has to be
 * ours — see `#tag`.
 */
export type BrevoFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const BREVO_BASE_URL = 'https://api.brevo.com';

export const BREVO_ENDPOINTS = {
  send: '/v3/smtp/email',
  /** "Get the list of all your senders": `{ senders: [{ email, name, active }] }`. */
  senders: '/v3/senders',
  /**
   * "Get all your transactional email activity (unaggregated events)":
   * `{ events: [{ email, date, messageId, event, reason?, from? }] }`, filtered
   * by `messageId` or `email`. Events: requests, delivered, hardBounces,
   * softBounces, blocked, spam, invalid, deferred, opened, clicks, error.
   */
  events: '/v3/smtp/statistics/events',
  /** "Get your account information": `{ email, companyName, plan }`. */
  account: '/v3/account',
} as const;

/**
 * A Brevo SMTP KEY, which is not an API key.
 *
 * Brevo's "SMTP & API" page issues both, side by side, and they look alike:
 * `xkeysib-…` authenticates the v3 API this adapter calls; `xsmtpsib-…` is a
 * PASSWORD for their SMTP relay and is refused by every API call as a key
 * Brevo has never heard of. Pasted into `/admin/credentials`, it reads as
 * "set" on the dashboard while no message leaves — and Brevo logs nothing,
 * because the request never authenticated. Named here, before a call is made.
 */
export function isSmtpKey(key: string): boolean {
  return key.trim().startsWith('xsmtpsib-');
}

/**
 * The failure codes a retry can actually clear.
 *
 * Everything not named here is a refusal: an unrecognised sender is not going
 * to become recognised, and spinning on it hides the real problem behind a
 * queue that never drains. `invalid_parameter` in particular is OURS to fix.
 */
const RETRYABLE_CODES = new Set(['too_many_requests', 'internal_error', 'unavailable']);

export interface BrevoAdapterOptions {
  /**
   * The v3 API key. Brevo's are prefixed `xkeysib-`.
   *
   * A STRING OR A FUNCTION, and the function is what makes a key pasted into
   * the dashboard reach this adapter. 026's rule is that the database is
   * authoritative and the environment is the fallback; an adapter built once
   * at boot from a string can only ever hold what the environment had, so an
   * operator who pasted a key saw the dashboard report it as set while every
   * message went on failing. The Bitnob and Paystack ports were joined to the
   * credential store for exactly this reason and the mailer was left behind —
   * which is worse, because the flow it breaks is password reset, and a
   * customer who cannot reset a password cannot reach their own money.
   *
   * Resolved PER SEND, so a rotation takes effect in five seconds rather than
   * at the next restart.
   */
  readonly apiKey: string | (() => Promise<string | undefined>);
  /**
   * `Xetral <no-reply@xetral.com>` — the same format the rest of this
   * codebase uses, split into Brevo's `{ name, email }` at the wire.
   *
   * THE DOMAIN MUST BE AUTHENTICATED IN BREVO or every send is refused. That
   * is a dashboard step, not a code one, and the refusal says so.
   */
  readonly from: string;
  /** Where a reply goes. Security mail that replies into a black hole trains
   *  customers to ignore it. */
  readonly replyTo?: string;
  readonly baseUrl?: string;
  readonly fetch?: BrevoFetchLike;
  readonly timeoutMs?: number;
}

export class BrevoNotificationAdapter implements NotificationPort {
  readonly provider = PROVIDER;

  readonly #apiKey: string | (() => Promise<string | undefined>);
  readonly #from: string;
  readonly #replyTo: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: BrevoFetchLike;
  readonly #timeoutMs: number;
  /** A sender Brevo has VERIFIED, used once the configured one was refused. */
  #verified: { name?: string; email: string } | undefined;
  /** Whether the configured sender has been checked against Brevo's list. */
  #checked = false;

  constructor(options: BrevoAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#replyTo = options.replyTo;
    this.#baseUrl = (options.baseUrl ?? BREVO_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    /*
     * RESOLVED HERE, NOT IN THE CONSTRUCTOR. See `apiKey` above: this is what
     * lets a key pasted into `/admin/credentials` be the one that sends.
     *
     * An ABSENT key is a configuration fault rather than a Brevo outage, so
     * it is thrown as one — `ProviderRejectedError` is not retryable, and
     * retrying a send with no credential for six hours would fill the outbox
     * with attempts that cannot succeed and bury the messages that can.
     */
    const apiKey = typeof this.#apiKey === 'string' ? this.#apiKey : await this.#apiKey();
    if (apiKey === undefined || apiKey === '') {
      throw new ProviderRejectedError(
        PROVIDER,
        'no Brevo API key is set. Paste one at /admin/credentials, or set ' +
          'BREVO_API_KEY. Nothing can be sent until then.',
        'no_api_key',
      );
    }
    if (isSmtpKey(apiKey)) {
      throw new ProviderRejectedError(PROVIDER, SMTP_KEY_REFUSAL, 'smtp_key');
    }

    const configured = senderOf(this.#from);
    /*
     * CHECKED BEFORE THE FIRST SEND, NOT ONLY AFTER A REFUSAL. Brevo does not
     * always refuse a sender it has not verified: it can accept the message
     * and then not deliver it, and an accepted message is one the outbox
     * marks sent. So the configured address is looked up in the account's
     * own list of verified senders once per process, and a verified one on
     * the same domain — or any verified one — is used when it is not there.
     * A list that cannot be read changes nothing.
     */
    if (!this.#checked && this.#verified === undefined) {
      this.#checked = true;
      const listed = await this.#verifiedSender(apiKey, configured.email);
      if (listed !== undefined && !listed.matchedExactly) {
        this.#verified = {
          ...(configured.name === undefined ? {} : { name: configured.name }),
          ...(listed.name === undefined ? {} : { name: listed.name }),
          email: listed.email,
        };
      }
    }
    try {
      return await this.#attempt(apiKey, this.#verified ?? configured, message);
    } catch (error) {
      /*
       * A SENDER BREVO HAS NOT VERIFIED IS REFUSED ON EVERY MESSAGE, and that
       * was the reset code that never arrived. NOTIFICATION_FROM defaults to
       * `no-reply@xetral.com` so that mail is sent at all; if that address or
       * its domain was never verified in the Brevo account, every message —
       * a reset code most of all — is refused with a sentence about the
       * sender, and the customer waits for an email that is never coming.
       *
       * So a refusal ABOUT THE SENDER asks Brevo which senders this account
       * HAS verified and sends once more from one of them — the same domain
       * first. A refused send sent nothing, so the second attempt cannot be a
       * duplicate. The choice is kept for later messages and logged by the
       * caller through the rejection it would otherwise have raised.
       */
      if (this.#verified !== undefined || !isSenderRefusal(error)) throw error;
      const found = await this.#verifiedSender(apiKey, configured.email);
      if (found === undefined || found.email === configured.email) throw error;
      this.#verified = {
        ...(configured.name === undefined ? {} : { name: configured.name }),
        ...(found.name === undefined ? {} : { name: found.name }),
        email: found.email,
      };
      return this.#attempt(apiKey, this.#verified, message);
    }
  }

  async #verifiedSender(
    apiKey: string,
    preferredEmail: string,
  ): Promise<{ name?: string; email: string; matchedExactly: boolean } | undefined> {
    let payload: unknown;
    try {
      const response = await this.#fetch(`${this.#baseUrl}${BREVO_ENDPOINTS.senders}`, {
        method: 'GET',
        headers: { 'api-key': apiKey, accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      payload = await response.json();
    } catch {
      return undefined;
    }
    const list = (payload as { senders?: unknown }).senders;
    if (!Array.isArray(list)) return undefined;
    const active = list
      .map((row) => row as { email?: unknown; name?: unknown; active?: unknown })
      .filter((row): row is { email: string; name?: unknown; active?: unknown } =>
        typeof row.email === 'string' && row.email.includes('@') && row.active !== false,
      );
    const exact = active.find((row) => row.email.toLowerCase() === preferredEmail.toLowerCase());
    const domain = preferredEmail.split('@')[1]?.toLowerCase();
    const pick =
      exact ?? active.find((row) => row.email.split('@')[1]?.toLowerCase() === domain) ?? active[0];
    if (pick === undefined) return undefined;
    const matchedExactly = exact !== undefined;
    return typeof pick.name === 'string' && pick.name.trim() !== ''
      ? { name: pick.name.trim(), email: pick.email, matchedExactly }
      : { email: pick.email, matchedExactly };
  }

  /**
   * WHAT BREVO DID WITH A MESSAGE AFTER ACCEPTING IT.
   *
   * The outbox knows only that Brevo said 201. A reset code that "never
   * arrives" after that was delivered to spam, blocked because the address
   * once bounced, deferred, or refused by the recipient's server — and every
   * one of those is only in Brevo's own event log. This reads it, by the
   * message id the outbox stored, or by the address when there is none.
   * Read-only; never throws for a log that cannot be read.
   */
  async deliveryEvents(ref: { messageId?: string; email?: string }): Promise<readonly DeliveryEvent[]> {
    const apiKey = typeof this.#apiKey === 'string' ? this.#apiKey : await this.#apiKey();
    if (apiKey === undefined || apiKey === '') {
      throw new ProviderRejectedError(PROVIDER, 'no Brevo API key is set', 'no_api_key');
    }
    const query = new URLSearchParams({ limit: '50', sort: 'desc', days: '30' });
    if (ref.messageId !== undefined) query.set('messageId', ref.messageId);
    else if (ref.email !== undefined) query.set('email', ref.email);
    const response = await this.#fetch(`${this.#baseUrl}${BREVO_ENDPOINTS.events}?${query.toString()}`, {
      method: 'GET',
      headers: { 'api-key': apiKey, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new ProviderRejectedError(PROVIDER, `Brevo answered ${response.status} reading its event log`, `http_${response.status}`);
    }
    const payload = (await response.json()) as { events?: unknown };
    if (!Array.isArray(payload.events)) return [];
    return payload.events.flatMap((row): DeliveryEvent[] => {
      const event = row as { date?: unknown; event?: unknown; reason?: unknown; from?: unknown };
      if (typeof event.event !== 'string' || typeof event.date !== 'string') return [];
      return [
        {
          at: event.date,
          event: event.event,
          ...(typeof event.reason === 'string' && event.reason !== '' ? { reason: event.reason } : {}),
          ...(typeof event.from === 'string' ? { from: event.from } : {}),
        },
      ];
    });
  }

  /**
   * WHICH BREVO ACCOUNT THIS KEY BELONGS TO.
   *
   * Brevo logs nothing for a request it could not attribute to an account, so
   * "the Brevo dashboard shows no mail from us" is what a key from a DIFFERENT
   * account looks like from the account being watched. The account's email
   * and company name, and nothing else — never the key, never the plan's
   * credits — are enough for an operator to say "that is not ours".
   */
  async account(): Promise<{ email?: string; company?: string } | undefined> {
    const apiKey = typeof this.#apiKey === 'string' ? this.#apiKey : await this.#apiKey();
    if (apiKey === undefined || apiKey === '' || isSmtpKey(apiKey)) return undefined;
    try {
      const response = await this.#fetch(`${this.#baseUrl}${BREVO_ENDPOINTS.account}`, {
        method: 'GET',
        headers: { 'api-key': apiKey, accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { email?: unknown; companyName?: unknown };
      return {
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(typeof payload.companyName === 'string' && payload.companyName !== ''
          ? { company: payload.companyName }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  async #attempt(
    apiKey: string,
    sender: { name?: string; email: string },
    message: NotificationMessage,
  ): Promise<NotificationReceipt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${BREVO_ENDPOINTS.send}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          // NOT a bearer token. See the header comment.
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          /*
           * A LIST OF OBJECTS, even though the port carries ONE address.
           *
           * `NotificationMessage.to` is a single string deliberately —
           * batching is not modelled, because every message this platform
           * sends is addressed to one person about their own account. Brevo's
           * wire format is a list regardless, and a list of STRINGS is a
           * malformed body which they report as a parameter error rather than
           * as a bad address, so the message names the wrong thing and
           * somebody goes looking at the recipient.
           */
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
          ...(this.#replyTo === undefined ? {} : { replyTo: { email: this.#replyTo } }),
          /*
           * THE DUPLICATE GUARD, BECAUSE BREVO HAS NO IDEMPOTENCY KEY.
           *
           * The port's rule is that a notification timeout IS retryable —
           * inverted from every money path, because not sending a reset link
           * is worse than sending it twice. Resend made that safe with
           * `Idempotency-Key`; Brevo's transactional endpoint has no
           * equivalent, so the outbox's key travels as a TAG instead.
           *
           * It does not deduplicate — nothing here can claim it does. What it
           * does is make a duplicate ATTRIBUTABLE: two messages carrying one
           * tag are one outbox row sent twice, which is answerable from
           * Brevo's own logs rather than from guessing. The real guard stays
           * where it always was: `notification_outbox.idempotency_key` is
           * UNIQUE, so two requests racing to owe the same customer the same
           * alert produce one row.
           */
          tags: [message.idempotencyKey],
        }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `send did not answer within ${this.#timeoutMs}ms`,
          cause,
        );
      }
      throw new ProviderUnavailableError(PROVIDER, 'send failed', cause);
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();

    if (response.status >= 500) {
      throw new ProviderUnavailableError(PROVIDER, `send returned ${response.status}`, body);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      throw new ProviderContractError(
        PROVIDER,
        `send returned ${response.status} with a non-JSON body`,
        cause,
      );
    }

    // `response.ok` covers 201, which is what a successful send answers.
    // Checking `=== 200` would treat every success as a failure.
    if (!response.ok) {
      const error = payload as { code?: unknown; message?: unknown };
      const code = typeof error.code === 'string' ? error.code : undefined;
      const detail =
        typeof error.message === 'string' ? error.message : `send returned ${response.status}`;

      if (code !== undefined && RETRYABLE_CODES.has(code)) {
        throw new ProviderUnavailableError(PROVIDER, `${detail} (${code})`, body);
      }
      throw new ProviderRejectedError(
        PROVIDER,
        response.status === 401 ? `${detail}${unauthorisedHint(detail)}` : detail,
        code,
        body,
      );
    }

    const success = payload as { messageId?: unknown };
    if (typeof success.messageId !== 'string' || success.messageId === '') {
      // Without an id we cannot answer "did this customer get their reset
      // link?" later, which is the whole reason 012 stores one.
      throw new ProviderContractError(PROVIDER, 'send succeeded with no messageId', body);
    }

    return { providerMessageId: success.messageId, from: sender.email };
  }
}

/**
 * `Xetral <no-reply@xetral.com>` into Brevo's `{ name, email }`.
 *
 * The bracketed form is what the rest of this codebase and every other mail
 * provider takes, so the CONFIGURATION stays the same shape and the split
 * happens here. A bare address is accepted and sends with no display name,
 * which is worse-looking but not broken — refusing it would turn a cosmetic
 * omission into an outage in the password reset flow.
 */
export function senderOf(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
  if (match === null) return { email: from.trim() };

  const name = (match[1] ?? '').replace(/^"|"$/g, '').trim();
  const email = (match[2] ?? '').trim();
  return name === '' ? { email } : { name, email };
}

const SMTP_KEY_REFUSAL =
  'the Brevo key set on this server is an SMTP key (it starts "xsmtpsib-"), which ' +
  'is a password for their SMTP relay and not an API key. In Brevo open SMTP & API ' +
  '→ API Keys, create an API key (it starts "xkeysib-") and paste that at ' +
  '/admin/credentials.';

/**
 * What to DO about a 401, which Brevo words as "Key not found" or as an
 * unrecognised IP address. Both look like "email is broken" from the outside
 * and each has exactly one remedy.
 */
function unauthorisedHint(detail: string): string {
  if (/\bip\b|ip address/i.test(detail)) {
    return (
      ' — Brevo is refusing this server\'s IP address. In Brevo open Security → ' +
      'Authorised IPs and add it, or turn IP blocking off.'
    );
  }
  return (
    ' — Brevo does not recognise this API key. Paste an API key (starting ' +
    '"xkeysib-") from the Brevo account that owns app.xetral.com at /admin/credentials.'
  );
}

/** Is this Brevo's refusal of the SENDER, rather than of the recipient or the key? */
function isSenderRefusal(error: unknown): boolean {
  return (
    error instanceof ProviderRejectedError &&
    error.providerCode !== 'no_api_key' &&
    /sender|from address|not (?:been )?(?:verified|validated)/i.test(error.message)
  );
}
