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

const VERIFIED_AS_CONFIGURED = { senders: [{ email: 'no-reply@xetral.com', name: 'Xetral', active: true }] };

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
        // The sender check before the first send: the configured sender IS
        // verified here, so it changes nothing these tests are about.
        if (url.endsWith('/v3/senders')) {
          return new Response(JSON.stringify(VERIFIED_AS_CONFIGURED), { status: 200 });
        }
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
    await expect(adapter.send(MESSAGE)).resolves.toEqual({ providerMessageId: '<id@brevo>', from: 'no-reply@xetral.com' });
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

/**
 * A KEY THAT ARRIVES AFTER BOOT.
 *
 * The adapter used to take a string, so it could only ever hold what the
 * environment had at construction — and a key pasted into
 * `/admin/credentials` was reported as set by the dashboard while every send
 * went on failing. Password reset was the flow that broke, which is the one a
 * customer reaches for when they cannot get into their account at all.
 */
describe('the API key is resolved per send', () => {
  it('asks for the key on every send, so a rotation takes effect', async () => {
    const keys = ['xkeysib-first', 'xkeysib-second'];
    const seen: string[] = [];
    const adapter = new BrevoNotificationAdapter({
      apiKey: () => Promise.resolve(keys.shift()),
      from: 'Xetral <no-reply@xetral.test>',
      fetch: (url, init) => {
        if (url.endsWith('/v3/senders')) {
          return Promise.resolve(new Response(JSON.stringify(VERIFIED_AS_CONFIGURED), { status: 200 }));
        }
        seen.push(String((init?.headers as Record<string, string>)['api-key']));
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: 'm1' }), { status: 201 }),
        );
      },
    });

    await adapter.send(MESSAGE);
    await adapter.send(MESSAGE);

    // The SECOND send used the SECOND key. A constructor-captured string
    // would have sent the first one twice, which is exactly what a rotation
    // during an incident must not do.
    expect(seen).toEqual(['xkeysib-first', 'xkeysib-second']);
  });

  it('refuses rather than retries when there is no key at all', async () => {
    const adapter = new BrevoNotificationAdapter({
      apiKey: () => Promise.resolve(undefined),
      from: 'Xetral <no-reply@xetral.test>',
      fetch: () => {
        throw new Error('should not have been called');
      },
    });

    // NOT retryable. A missing credential is a configuration fault, and
    // retrying for six hours would fill the outbox with attempts that cannot
    // succeed and bury the messages that can.
    await expect(adapter.send(MESSAGE)).rejects.toMatchObject({ retryable: false });
  });
});

describe('a sender Brevo has not verified', () => {
  /*
   * The reset code that never arrived: the default sender was refused on every
   * message. The adapter asks Brevo which senders ARE verified and sends once
   * more from one — same domain first — and keeps using it.
   */
  function scripted(replies: { status: number; body: unknown }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = new BrevoNotificationAdapter({
      apiKey: 'xkeysib-test',
      from: 'Xetral <no-reply@xetral.com>',
      baseUrl: 'https://api.brevo.test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        const reply = replies.shift();
        if (reply === undefined) throw new Error('unexpected call');
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      },
    });
    return { adapter, calls };
  }
  const refused = { status: 400, body: { code: 'invalid_parameter', message: 'Sender is not valid' } };
  const listed = (...senders: { email: string; name?: string; active?: boolean }[]) => ({
    status: 200,
    body: { senders },
  });

  it('SENDS AS CONFIGURED when Brevo lists that exact sender as verified', async () => {
    const { adapter, calls } = scripted([
      listed({ email: 'no-reply@xetral.com', active: true }),
      { status: 201, body: { messageId: '<ok@brevo>' } },
    ]);
    await adapter.send(MESSAGE);
    expect(calls[0]!.url).toBe('https://api.brevo.test/v3/senders');
    expect(bodyOf(calls[1]!.init)['sender']).toEqual({ name: 'Xetral', email: 'no-reply@xetral.com' });
  });

  it('USES A VERIFIED SENDER FROM THE FIRST MESSAGE when the configured one is not listed', async () => {
    /*
     * Brevo does not always REFUSE an unverified sender: it can accept the
     * message and not deliver it, and the outbox then says "sent" about a
     * reset code nobody received. So the list is read before the first send,
     * not only after a refusal.
     */
    const { adapter, calls } = scripted([
      listed({ email: 'olawale@gmail.com', name: 'Olawale', active: true }, { email: 'hello@xetral.com', name: 'Xetral', active: true }),
      { status: 201, body: { messageId: '<ok@brevo>' } },
      { status: 201, body: { messageId: '<ok2@brevo>' } },
    ]);
    await expect(adapter.send(MESSAGE)).resolves.toEqual({ providerMessageId: '<ok@brevo>', from: 'hello@xetral.com' });
    expect(bodyOf(calls[1]!.init)['sender']).toEqual({ name: 'Xetral', email: 'hello@xetral.com' });

    // Asked once per process, not per message.
    await adapter.send(MESSAGE);
    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]!.init)['sender']).toEqual({ name: 'Xetral', email: 'hello@xetral.com' });
  });

  it('still recovers from a refusal when the list could not be read up front, using any active sender', async () => {
    const { adapter, calls } = scripted([
      { status: 500, body: {} },
      refused,
      listed({ email: 'old@elsewhere.com', active: false }, { email: 'owner@gmail.com', active: true }),
      { status: 201, body: { messageId: '<ok@brevo>' } },
    ]);
    await adapter.send(MESSAGE);
    expect(bodyOf(calls[3]!.init)['sender']).toEqual({ name: 'Xetral', email: 'owner@gmail.com' });
  });

  it('raises the original refusal when the account has no verified sender', async () => {
    const { adapter } = scripted([listed(), refused, listed()]);
    await expect(adapter.send(MESSAGE)).rejects.toThrow(/Sender is not valid/);
  });

  it('does not ask about senders for a refusal about something else', async () => {
    const { adapter, calls } = scripted([
      listed({ email: 'no-reply@xetral.com', active: true }),
      { status: 400, body: { code: 'invalid_parameter', message: 'email is not valid in to' } },
    ]);
    await expect(adapter.send(MESSAGE)).rejects.toBeInstanceOf(ProviderRejectedError);
    expect(calls).toHaveLength(2);
  });
});

describe('what Brevo did after accepting a message', () => {
  it('READS ITS EVENT LOG by message id, so "sent" can be told from "delivered"', async () => {
    const calls: string[] = [];
    const adapter = new BrevoNotificationAdapter({
      apiKey: 'xkeysib-test',
      from: 'Xetral <no-reply@xetral.com>',
      baseUrl: 'https://api.brevo.test',
      fetch: async (url) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            events: [
              { email: 'ada@example.ng', date: '2026-09-27T10:00:02Z', messageId: '<m@b>', event: 'blocked', reason: 'blocked : due to a previous hard bounce' },
              { email: 'ada@example.ng', date: '2026-09-27T10:00:01Z', messageId: '<m@b>', event: 'requests', from: 'no-reply@xetral.com' },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const events = await adapter.deliveryEvents({ messageId: '<m@b>' });
    expect(calls[0]).toContain('/v3/smtp/statistics/events?');
    expect(calls[0]).toContain('messageId=%3Cm%40b%3E');
    expect(events[0]).toEqual({
      at: '2026-09-27T10:00:02Z',
      event: 'blocked',
      reason: 'blocked : due to a previous hard bounce',
    });
  });
});
