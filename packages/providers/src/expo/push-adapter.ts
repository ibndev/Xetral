import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import type { PushMessage, PushOutcome, PushPort } from '../ports/push.js';

const PROVIDER = 'expo';

/**
 * `PushPort` implemented against Expo's push service.
 *
 * WHY EXPO AND NOT A PUSH PRODUCT. The requirement was something free to
 * start that can be paid for as the platform grows. Expo's push service is
 * free at every size and has no account tier at all — it is a queue in front
 * of the two things that actually deliver a notification, Apple's APNs and
 * Google's FCM, and both of those are free too. What paid products sell on top
 * is segmentation, scheduling and analytics, none of which is what "tell
 * customers the app is down tonight" needs.
 *
 * IT IS ALSO THE ONLY ONE THIS APP CAN USE WITHOUT A NATIVE MODULE IT DOES NOT
 * HAVE. `apps/mobile` is Expo, and `expo-notifications` is what mints a token
 * there. A third-party SDK would mean a new native dependency in a banking app
 * whose Android build has already been broken twice by config-plugin
 * behaviour that appears in no diff.
 *
 * AND THE WAY OUT IS CHEAP, which is the part worth writing down. This is a
 * PORT: the tokens live in our own table, the audience is our own view, and
 * moving to FCM directly or to a paid product is one adapter. Nothing above
 * this file knows who delivered.
 *
 * THE WIRE CONTRACT, from Expo's published push API documentation:
 *
 *   - endpoint   `POST https://exp.host/--/api/v2/push/send`
 *   - auth       NONE by default. A token is an unguessable address, and
 *                Expo's own docs treat possession of one as the authorisation
 *                to send to it. An access token may be REQUIRED on the Expo
 *                account (Enhanced Security), and then it is a bearer header
 *                — which is why `accessToken` is optional here rather than
 *                absent.
 *   - body       an ARRAY of messages, at most 100 per request
 *   - response   `{ "data": [ { "status": "ok", "id": "..." },
 *                             { "status": "error", "message": "...",
 *                               "details": { "error": "DeviceNotRegistered" } } ] }`
 *                POSITIONALLY ALIGNED with the request array. There is no
 *                token in a ticket, so the only thing that says which handset
 *                a refusal is about is its INDEX — which is why this adapter
 *                sends one chunk at a time and zips the answer back to the
 *                chunk it sent, and never reorders either.
 *   - fatal      `{ "errors": [ { "code": "...", "message": "..." } ] }` with
 *                no `data` at all, when the whole request was refused.
 *
 * `DeviceNotRegistered` IS THE ONE REFUSAL THAT MEANS RETIRE, NOT RETRY. The
 * app is gone from that handset and the token will never work again; kept, it
 * is a permanent error on every future broadcast, and a report that always
 * says "417 failed" is a report nobody reads — the argument 015 makes about an
 * alert people learn to ignore.
 *
 * A SEND IS NOT A DELIVERY, and this adapter says so rather than pretending.
 * Expo answers with a TICKET, meaning it accepted the message for delivery;
 * whether APNs or FCM then delivered it is a RECEIPT, fetched later. That
 * distinction is not worth a second table here — nothing depends on a
 * notification arriving, unlike a payout — so `accepted` means accepted for
 * delivery and the field is named for what it is.
 */
export type ExpoFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Expo's documented ceiling. Sending more in one request is refused outright,
 * so this is a contract constant rather than a tuning knob.
 */
export const EXPO_PUSH_BATCH = 100;

export interface ExpoPushAdapterOptions {
  /**
   * Only needed when the Expo account has Enhanced Security switched on.
   *
   * A STRING OR A FUNCTION, the shape 026 requires: the database is
   * authoritative and the environment is the fallback, so a token pasted at
   * `/admin/credentials` reaches an adapter built at boot.
   */
  readonly accessToken?: string | (() => Promise<string | undefined>);
  readonly url?: string;
  readonly fetch?: ExpoFetchLike;
  readonly timeoutMs?: number;
}

interface ExpoTicket {
  status?: unknown;
  message?: unknown;
  details?: { error?: unknown } | null;
}

export class ExpoPushAdapter implements PushPort {
  readonly provider = PROVIDER;

  readonly #accessToken: string | (() => Promise<string | undefined>) | undefined;
  readonly #url: string;
  readonly #fetch: ExpoFetchLike;
  readonly #timeoutMs: number;

  constructor(options: ExpoPushAdapterOptions = {}) {
    this.#accessToken = options.accessToken;
    this.#url = options.url ?? EXPO_PUSH_URL;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async send(message: PushMessage, tokens: readonly string[]): Promise<readonly PushOutcome[]> {
    if (tokens.length === 0) return [];

    const header = await this.#authHeader();
    const outcomes: PushOutcome[] = [];

    for (let at = 0; at < tokens.length; at += EXPO_PUSH_BATCH) {
      const chunk = tokens.slice(at, at + EXPO_PUSH_BATCH);
      outcomes.push(...(await this.#sendChunk(message, chunk, header)));
    }
    return outcomes;
  }

  async #authHeader(): Promise<Record<string, string>> {
    const token =
      typeof this.#accessToken === 'string' ? this.#accessToken : await this.#accessToken?.();
    // Absent is the ORDINARY case and is not an error. Expo requires a token
    // only when the account has Enhanced Security on, and refusing to send
    // without one would break every deployment that does not.
    return token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` };
  }

  async #sendChunk(
    message: PushMessage,
    tokens: readonly string[],
    header: Record<string, string>,
  ): Promise<readonly PushOutcome[]> {
    const body = JSON.stringify(
      tokens.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        // Their default is 'default', which on iOS means a sound. A banking
        // app that pings at 3am about an announcement is one people mute at
        // the OS level, and a muted app cannot tell them anything later.
        sound: null,
        ...(message.path === undefined ? {} : { data: { path: message.path } }),
      })),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...header },
        body,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      /*
       * A TIMEOUT HERE IS RETRYABLE, and this is the second place in the
       * codebase where that is true. 012 records the first and the same
       * argument holds: for money, not knowing whether the provider acted
       * means do nothing and reconcile. Here the worst case of asking again is
       * that somebody sees an announcement twice, and the worst case of not
       * asking is that nobody hears anything.
       *
       * The retry is the caller's decision, not this adapter's — it throws,
       * and the broadcast stays undrained where `push_broadcasts_stuck` can
       * see it.
       */
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderTimeoutError(PROVIDER, `no answer in ${this.#timeoutMs}ms`);
      }
      throw new ProviderUnavailableError(PROVIDER, describe(error));
    } finally {
      clearTimeout(timer);
    }

    const parsed: unknown = await response.json().catch(() => undefined);

    // A whole-request refusal carries `errors` and no `data`. 401 and 403 mean
    // the access token is wrong, which is a configuration fault a person fixes
    // rather than something to spin on.
    const fatal = firstError(parsed);
    if (fatal !== undefined || !response.ok) {
      const reason = fatal ?? `http ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        throw new ProviderRejectedError(
          PROVIDER,
          `${reason}. Expo refused the request: check the access token at ` +
            `/admin/credentials, or clear it if the Expo account does not ` +
            `require one.`,
          'push_unauthorised',
        );
      }
      if (response.status === 429) {
        throw new ProviderUnavailableError(PROVIDER, 'Expo is rate limiting this account');
      }
      throw new ProviderUnavailableError(PROVIDER, reason);
    }

    const tickets = (parsed as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(tickets)) {
      throw new ProviderContractError(PROVIDER, 'a successful send carried no ticket array');
    }
    if (tickets.length !== tokens.length) {
      /*
       * POSITION IS THE ONLY THING THAT SAYS WHICH TOKEN A TICKET IS ABOUT —
       * there is no token in the ticket. A short or long array means the
       * alignment is broken, and the failure mode of guessing is retiring one
       * customer's handset because a different customer's app was uninstalled.
       */
      throw new ProviderContractError(
        PROVIDER,
        `sent ${tokens.length} messages and got ${tickets.length} tickets, so ` +
          `no ticket can be attributed to a handset`,
      );
    }

    return tokens.map((token, index) => {
      const ticket = (tickets[index] ?? {}) as ExpoTicket;
      if (ticket.status === 'ok') return { token, accepted: true, deviceGone: false };

      const detail = typeof ticket.details?.error === 'string' ? ticket.details.error : undefined;
      const reason = typeof ticket.message === 'string' ? ticket.message : (detail ?? 'refused');
      return {
        token,
        accepted: false,
        deviceGone: detail === 'DeviceNotRegistered',
        reason,
      };
    });
  }
}

function firstError(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0] as { message?: unknown; code?: unknown };
  if (typeof first.message === 'string') return first.message;
  if (typeof first.code === 'string') return first.code;
  return 'refused';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
