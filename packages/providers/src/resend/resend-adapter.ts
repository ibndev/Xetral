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

const PROVIDER = 'resend';

/**
 * `NotificationPort` implemented against Resend.
 *
 * VERIFIED AGAINST THEIR OFFICIAL NODE SDK (npm `resend`, v6.22.1) rather than
 * inferred, for the reason the Bitnob table exists: every constant in that
 * table was a plausible guess, the tests were written from the same
 * assumptions, everything passed, and every single path was wrong.
 *
 * What the SDK actually does, read from `dist/index.mjs`:
 *
 *   - base URL          `https://api.resend.com`
 *   - send              `POST /emails`
 *   - auth              `Authorization: Bearer <key>`
 *   - idempotency       `Idempotency-Key: <key>` request header
 *   - success           `{ "id": "<uuid>" }`
 *   - failure           `{ "message": string, "name": <code>, "statusCode": number }`
 *
 * ONE TRAP, AND IT IS THE SAME ONE BITNOB SET. The SDK's TypeScript surface is
 * camelCase (`replyTo`), and `parseEmailToApiOptions` renames it to `reply_to`
 * before it goes on the wire. The camelCase name is the SDK's, not the API's.
 * This adapter builds the wire body directly, so it uses the wire names.
 */
export type ResendFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const RESEND_BASE_URL = 'https://api.resend.com';

export const RESEND_ENDPOINTS = {
  send: '/emails',
} as const;

/**
 * The error codes from `RESEND_ERROR_CODE_KEY` that a retry can actually clear.
 *
 * Everything not named here is treated as a refusal, because retrying it just
 * sends the same rejection back — an invalid `from` address is not going to
 * become valid, and spinning on it hides the real problem behind a queue that
 * never drains.
 *
 * `concurrent_idempotent_requests` is in the list and is the interesting one:
 * it means another request carrying THIS key is in flight, which is precisely
 * the duplicate-send guard doing its job. Waiting and asking again is right.
 */
const RETRYABLE_CODES = new Set([
  'rate_limit_exceeded',
  'internal_server_error',
  'application_error',
  'concurrent_idempotent_requests',
]);

export interface ResendAdapterOptions {
  readonly apiKey: string;
  /** `Xetral <no-reply@xetral.com>` — display name included, per the SDK's
   *  documented `from` format. */
  readonly from: string;
  /** Where a customer's reply goes. Security mail that replies into a black
   *  hole trains customers to ignore it. */
  readonly replyTo?: string;
  readonly baseUrl?: string;
  readonly fetch?: ResendFetchLike;
  readonly timeoutMs?: number;
}

export class ResendNotificationAdapter implements NotificationPort {
  readonly provider = PROVIDER;

  readonly #apiKey: string;
  readonly #from: string;
  readonly #replyTo: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: ResendFetchLike;
  readonly #timeoutMs: number;

  constructor(options: ResendAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#replyTo = options.replyTo;
    this.#baseUrl = (options.baseUrl ?? RESEND_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${RESEND_ENDPOINTS.send}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          // The other half of the retry rule in the port's header comment. We
          // retry because a missing security email is worse than a duplicate
          // one; this is what stops the retry from actually producing the
          // duplicate.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.#from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          // Wire name. `replyTo` is the SDK's own alias and is not what the
          // API reads — see the header comment.
          ...(this.#replyTo === undefined ? {} : { reply_to: this.#replyTo }),
        }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        // Retryable, unlike everywhere else in this codebase. A timed-out send
        // may or may not have gone out, and under the idempotency key the
        // question does not matter: asking again either sends it or is
        // recognised as the same message.
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

    if (!response.ok) {
      const error = payload as { message?: unknown; name?: unknown };
      const code = typeof error.name === 'string' ? error.name : undefined;
      const detail =
        typeof error.message === 'string' ? error.message : `send returned ${response.status}`;

      if (code !== undefined && RETRYABLE_CODES.has(code)) {
        throw new ProviderUnavailableError(PROVIDER, `${detail} (${code})`, body);
      }
      throw new ProviderRejectedError(PROVIDER, detail, code, body);
    }

    const success = payload as { id?: unknown };
    if (typeof success.id !== 'string' || success.id === '') {
      // A 200 with no id means we cannot answer "did this customer get their
      // reset link?" later, which is the whole reason the id is stored.
      throw new ProviderContractError(PROVIDER, 'send returned 200 with no message id', body);
    }

    return { providerMessageId: success.id };
  }
}
