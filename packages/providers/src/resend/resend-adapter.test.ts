import { describe, expect, it } from 'vitest';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import { RESEND_BASE_URL, RESEND_ENDPOINTS, ResendNotificationAdapter } from './resend-adapter.js';
import type { ResendFetchLike } from './resend-adapter.js';

const MESSAGE = {
  to: 'customer@example.ng',
  subject: 'Reset your Xetral password',
  text: 'plain',
  html: '<p>rich</p>',
  idempotencyKey: 'outbox:4471',
};

interface Captured {
  url: string;
  init: RequestInit;
}

function adapter(
  respond: (captured: Captured) => Promise<Response> | Response,
  options: { replyTo?: string } = {},
): { port: ResendNotificationAdapter; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: ResendFetchLike = async (url, init) => {
    const captured = { url, init };
    calls.push(captured);
    return await respond(captured);
  };
  return {
    port: new ResendNotificationAdapter({
      apiKey: 'test-key',
      from: 'Xetral <no-reply@xetral.com>',
      ...options,
      fetch: fetchImpl,
    }),
    calls,
  };
}

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the request it actually sends', () => {
  it('posts to the endpoint read off the official SDK', async () => {
    const { port, calls } = adapter(() => ok({ id: 'msg_1' }));
    await port.send(MESSAGE);

    expect(calls[0]?.url).toBe(`${RESEND_BASE_URL}${RESEND_ENDPOINTS.send}`);
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('authenticates with a bearer key and carries the idempotency key', async () => {
    const { port, calls } = adapter(() => ok({ id: 'msg_1' }));
    await port.send(MESSAGE);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-key');
    expect(headers['idempotency-key']).toBe('outbox:4471');
  });

  it('names reply-to the way the WIRE does, not the way the SDK does', async () => {
    // The trap this exists for: the SDK's TypeScript surface calls it
    // `replyTo` and renames it to `reply_to` in `parseEmailToApiOptions`
    // before sending. An adapter built from the SDK's type definitions rather
    // than from what it puts on the wire would send a field the API ignores,
    // and every reply would go to the unmonitored `from` address instead —
    // silently, because the send still succeeds.
    const { port, calls } = adapter(() => ok({ id: 'msg_1' }), {
      replyTo: 'support@xetral.com',
    });
    await port.send(MESSAGE);

    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body['reply_to']).toBe('support@xetral.com');
    expect(body).not.toHaveProperty('replyTo');
  });

  it('sends both a text and an HTML part', async () => {
    // A security email that arrives blank in a text-only client is a customer
    // who cannot reset their password.
    const { port, calls } = adapter(() => ok({ id: 'msg_1' }));
    await port.send(MESSAGE);

    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body['text']).toBe('plain');
    expect(body['html']).toBe('<p>rich</p>');
  });
});

describe('what it does with the answer', () => {
  it('returns the provider message id', async () => {
    const { port } = adapter(() => ok({ id: 'msg_abc' }));
    await expect(port.send(MESSAGE)).resolves.toEqual({ providerMessageId: 'msg_abc' });
  });

  it('refuses a 200 that carries no message id', async () => {
    // Without an id there is no way to answer "did this customer get their
    // reset link?" when they say they did not.
    const { port } = adapter(() => ok({}));
    await expect(port.send(MESSAGE)).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('treats an HTML error page as a contract failure, not a rejection', async () => {
    const { port } = adapter(
      () => new Response('<html>502</html>', { status: 400, headers: { 'content-type': 'text/html' } }),
    );
    await expect(port.send(MESSAGE)).rejects.toBeInstanceOf(ProviderContractError);
  });
});

describe('classifying failure by whether a retry can clear it', () => {
  it('rate limiting is retryable', async () => {
    const { port } = adapter(() =>
      ok({ name: 'rate_limit_exceeded', message: 'too many requests', statusCode: 429 }, 429),
    );
    const error = await port.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
  });

  it('a concurrent request under the same key is retryable', async () => {
    // This one is the duplicate-send guard working: another attempt carrying
    // this exact key is in flight. Asking again is right; giving up would
    // abandon a message that was about to be deduplicated correctly.
    const { port } = adapter(() =>
      ok({ name: 'concurrent_idempotent_requests', message: 'in flight', statusCode: 409 }, 409),
    );
    const error = await port.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it('an invalid from address is NOT retryable', async () => {
    // It will never become valid, and spinning on it hides a misconfigured
    // sending domain behind a queue that quietly never drains.
    const { port } = adapter(() =>
      ok({ name: 'invalid_from_address', message: 'domain not verified', statusCode: 403 }, 403),
    );
    const error = await port.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).retryable).toBe(false);
    expect((error as ProviderRejectedError).providerCode).toBe('invalid_from_address');
  });

  it('a 5xx is retryable', async () => {
    const { port } = adapter(() => new Response('upstream down', { status: 503 }));
    await expect(port.send(MESSAGE)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('a timeout is retryable HERE, unlike everywhere else in the codebase', async () => {
    // The inversion the port's header comment describes, asserted rather than
    // just written down. For money, a timeout means do nothing and reconcile.
    // For a notification, not sending is the worse outcome and the provider's
    // idempotency key makes asking again safe.
    const { port } = adapter(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, 5);
        }),
    );
    const error = await port.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
  });
});
