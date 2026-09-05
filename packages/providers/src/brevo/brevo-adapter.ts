import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import type {
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
} as const;

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
          sender: senderOf(this.#from),
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
      throw new ProviderRejectedError(PROVIDER, detail, code, body);
    }

    const success = payload as { messageId?: unknown };
    if (typeof success.messageId !== 'string' || success.messageId === '') {
      // Without an id we cannot answer "did this customer get their reset
      // link?" later, which is the whole reason 012 stores one.
      throw new ProviderContractError(PROVIDER, 'send succeeded with no messageId', body);
    }

    return { providerMessageId: success.messageId };
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
