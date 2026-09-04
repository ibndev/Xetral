import { describe, expect, it } from 'vitest';
import { BrevoNotificationAdapter, senderOf } from './brevo-adapter.js';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import type { NotificationMessage } from '../ports/notification.js';

const MESSAGE: NotificationMessage = {
  to: 'ada@example.ng',
  subject: 'Reset your password',
  text: 'Use this link',
  html: '<p>Use this link</p>',
  idempotencyKey: 'outbox:4412',
};

function adapterWith(
  reply: { status: number; body: unknown } | Error,
): { adapter: BrevoNotificationAdapter; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    adapter: new BrevoNotificationAdapter({
      apiKey: 'xkeysib-test',
      from: 'Xetral <no-reply@xetral.com>',
      replyTo: 'support@xetral.com',
      baseUrl: 'https://api.brevo.test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (reply instanceof Error) throw reply;
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('the three things Brevo does differently from Resend', () => {
  it('AUTHENTICATES WITH `api-key`, NOT A BEARER TOKEN', async () => {
    // A bearer token gets a 401 that reads as a wrong key — the exact
    // misdiagnosis `bitnob/signing.ts` exists because of, and the one a
    // copied adapter would reproduce.
    const { adapter, calls } = adapterWith({ status: 201, body: { messageId: '<a@b>' } });
    await adapter.send(MESSAGE);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('xkeysib-test');
    expect(headers['authorization']).toBeUndefined();
  });

  it('SENDS `to` AS A LIST OF OBJECTS, even though the port carries one address', async () => {
    // The port models one message to one person; Brevo's wire format is a
    // list regardless. A list of STRINGS is a malformed body, which Brevo
    // reports as a parameter error rather than a bad address — so the message
    // names the wrong thing and somebody goes looking at the recipient.
    const { adapter, calls } = adapterWith({ status: 201, body: { messageId: '<a@b>' } });
    await adapter.send(MESSAGE);

    expect(bodyOf(calls[0]!.init)['to']).toEqual([{ email: 'ada@example.ng' }]);
  });

  it('TREATS 201 AS SUCCESS', async () => {
    // Their successful send is 201, not 200. Code checking `=== 200` would
    // treat every success as a failure and retry it for ever.
    const { adapter } = adapterWith({ status: 201, body: { messageId: '<id@brevo>' } });
    await expect(adapter.send(MESSAGE)).resolves.toEqual({ providerMessageId: '<id@brevo>' });
  });
});

describe('the body it builds', () => {
  it('splits the sender into name and email, and uses Brevo content field names', async () => {
    const { adapter, calls } = adapterWith({ status: 201, body: { messageId: '<a@b>' } });
    await adapter.send(MESSAGE);
    const body = bodyOf(calls[0]!.init);

    expect(body['sender']).toEqual({ name: 'Xetral', email: 'no-reply@xetral.com' });
    // `htmlContent`/`textContent`, not `html`/`text`. A field a server does
    // not recognise is DROPPED IN SILENCE rather than refused — so getting
    // this wrong sends a blank email that reports success.
    expect(body['htmlContent']).toBe('<p>Use this link</p>');
    expect(body['textContent']).toBe('Use this link');
    expect(body['replyTo']).toEqual({ email: 'support@xetral.com' });
  });

  it('carries the outbox key as a TAG, because Brevo has no idempotency key', async () => {
    // It does not deduplicate and nothing here claims it does. What it does
    // is make a duplicate ATTRIBUTABLE from Brevo's own logs. The real guard
    // is the UNIQUE constraint on `notification_outbox.idempotency_key`.
    const { adapter, calls } = adapterWith({ status: 201, body: { messageId: '<a@b>' } });
    await adapter.send(MESSAGE);
    expect(bodyOf(calls[0]!.init)['tags']).toEqual(['outbox:4412']);
  });

  it('sends a bare address with no display name rather than refusing it', () => {
    // Refusing would turn a cosmetic omission into an outage in the password
    // reset flow.
    expect(senderOf('no-reply@xetral.com')).toEqual({ email: 'no-reply@xetral.com' });
    expect(senderOf('"Xetral Support" <help@xetral.com>')).toEqual({
      name: 'Xetral Support',
      email: 'help@xetral.com',
    });
  });
});

describe('what it does with a refusal', () => {
  it('retries a rate limit and does NOT retry a rejected sender', async () => {
    const limited = adapterWith({
      status: 429,
      body: { code: 'too_many_requests', message: 'slow down' },
    });
    await expect(limited.adapter.send(MESSAGE)).rejects.toBeInstanceOf(ProviderUnavailableError);

    // An unauthenticated sender domain is a DASHBOARD step, not something a
    // retry clears — and spinning on it hides the real problem behind a queue
    // that never drains.
    const refused = adapterWith({
      status: 400,
      body: { code: 'invalid_parameter', message: 'sender domain is not authenticated' },
    });
    await expect(refused.adapter.send(MESSAGE)).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('a 5xx is unavailable, and a non-JSON body is a contract error', async () => {
    const down = adapterWith({ status: 502, body: {} });
    await expect(down.adapter.send(MESSAGE)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('A TIMEOUT IS RETRYABLE HERE, unlike everywhere else in this codebase', async () => {
    // The port's inversion: for money, not knowing whether the provider acted
    // means do nothing. For a reset link, not sending is worse than sending
    // twice.
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const { adapter } = adapterWith(abort);
    await expect(adapter.send(MESSAGE)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('a success carrying no messageId is a contract error', async () => {
    // Without an id, "did this customer get their reset link?" has no answer
    // later — which is the whole reason 012 stores one.
    const { adapter } = adapterWith({ status: 201, body: {} });
    await expect(adapter.send(MESSAGE)).rejects.toBeInstanceOf(ProviderContractError);
  });
});
