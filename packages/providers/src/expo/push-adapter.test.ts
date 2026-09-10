import { describe, expect, it, vi } from 'vitest';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import { EXPO_PUSH_BATCH, ExpoPushAdapter } from './push-adapter.js';

const MESSAGE = { title: 'Scheduled maintenance', body: 'Back within the hour.' };

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ok = (n: number) => ({ data: Array.from({ length: n }, () => ({ status: 'ok', id: 'x' })) });

describe('the Expo push adapter', () => {
  it('sends nothing and asks nothing when there are no handsets', async () => {
    const fetch = vi.fn();
    const adapter = new ExpoPushAdapter({ fetch });

    expect(await adapter.send(MESSAGE, [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends one message per token, with the title and body it was given', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(ok(2)));
    const adapter = new ExpoPushAdapter({ fetch });

    await adapter.send(MESSAGE, ['ExponentPushToken[a]', 'ExponentPushToken[b]']);

    const sent = JSON.parse(fetch.mock.calls[0]![1].body as string) as unknown[];
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      to: 'ExponentPushToken[a]',
      title: 'Scheduled maintenance',
      body: 'Back within the hour.',
    });
  });

  it('CARRIES NO AMOUNT ANYWHERE, because a notification is read off a lock screen', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(ok(1)));
    const adapter = new ExpoPushAdapter({ fetch });

    await adapter.send(MESSAGE, ['ExponentPushToken[a]']);

    // The port has no amount field, so the only way one could reach the wire
    // is through the title or the body an operator typed. Asserted over the
    // whole serialised request rather than field by field, because what is
    // being guarded against is a field nobody thought to name.
    const body = fetch.mock.calls[0]![1].body as string;
    expect(body).not.toMatch(/amount|balance|minor/i);
  });

  it('chunks at Expo’s documented ceiling of 100', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(ok(EXPO_PUSH_BATCH)))
      .mockResolvedValueOnce(respond(ok(1)));
    const adapter = new ExpoPushAdapter({ fetch });

    const tokens = Array.from(
      { length: EXPO_PUSH_BATCH + 1 },
      (_, i) => `ExponentPushToken[t${i}]`,
    );
    const outcomes = await adapter.send(MESSAGE, tokens);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(EXPO_PUSH_BATCH + 1);
    // And the chunks are in order, so the zip back onto tokens is sound.
    expect(outcomes[0]!.token).toBe('ExponentPushToken[t0]');
    expect(outcomes[EXPO_PUSH_BATCH]!.token).toBe(`ExponentPushToken[t${EXPO_PUSH_BATCH}]`);
  });

  it('attributes a refusal to the handset it is POSITIONALLY about', async () => {
    // There is no token in a ticket. If this zip is ever done by anything but
    // index, one customer's handset is retired because another customer
    // uninstalled the app.
    const fetch = vi.fn().mockResolvedValue(
      respond({
        data: [
          { status: 'ok', id: '1' },
          {
            status: 'error',
            message: '"ExponentPushToken[b]" is not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'ok', id: '3' },
        ],
      }),
    );
    const adapter = new ExpoPushAdapter({ fetch });

    const outcomes = await adapter.send(MESSAGE, [
      'ExponentPushToken[a]',
      'ExponentPushToken[b]',
      'ExponentPushToken[c]',
    ]);

    expect(outcomes[0]).toMatchObject({ token: 'ExponentPushToken[a]', accepted: true });
    expect(outcomes[1]).toMatchObject({
      token: 'ExponentPushToken[b]',
      accepted: false,
      deviceGone: true,
    });
    expect(outcomes[2]).toMatchObject({ token: 'ExponentPushToken[c]', accepted: true });
  });

  it('marks only DeviceNotRegistered as gone, never any other refusal', async () => {
    const fetch = vi.fn().mockResolvedValue(
      respond({
        data: [
          { status: 'error', message: 'Message too big', details: { error: 'MessageTooBig' } },
          { status: 'error', message: 'Rate exceeded', details: { error: 'MessageRateExceeded' } },
        ],
      }),
    );
    const adapter = new ExpoPushAdapter({ fetch });

    const outcomes = await adapter.send(MESSAGE, [
      'ExponentPushToken[a]',
      'ExponentPushToken[b]',
    ]);

    // Retiring a handset over a rate limit would lose a customer's address
    // permanently for a condition that clears in seconds.
    expect(outcomes.every((o) => !o.accepted)).toBe(true);
    expect(outcomes.every((o) => !o.deviceGone)).toBe(true);
  });

  it('REFUSES A MISALIGNED TICKET ARRAY rather than guessing', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(ok(1)));
    const adapter = new ExpoPushAdapter({ fetch });

    await expect(
      adapter.send(MESSAGE, ['ExponentPushToken[a]', 'ExponentPushToken[b]']),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('sends no authorization header when no access token is configured', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(ok(1)));
    const adapter = new ExpoPushAdapter({ fetch });

    await adapter.send(MESSAGE, ['ExponentPushToken[a]']);

    // Expo requires one only under Enhanced Security. Refusing to send
    // without one would break every deployment that has not switched it on.
    const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('bears the access token when one is configured, resolved per call', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(ok(1)));
    const accessToken = vi.fn().mockResolvedValue('expo-secret');
    const adapter = new ExpoPushAdapter({ fetch, accessToken });

    await adapter.send(MESSAGE, ['ExponentPushToken[a]']);

    const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer expo-secret');
    // Read per call, so a token pasted at /admin/credentials reaches an
    // adapter that was built at boot.
    expect(accessToken).toHaveBeenCalled();
  });

  it('names the credential when Expo refuses the whole request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(respond({ errors: [{ code: 'UNAUTHORIZED', message: 'bad token' }] }, 401));
    const adapter = new ExpoPushAdapter({ fetch });

    const error = await adapter.send(MESSAGE, ['ExponentPushToken[a]']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRejectedError);
    // The sentence names our integration, so it belongs in a log and never in
    // front of a customer — 006's rule. What it must do is point an operator
    // at the box to fill in.
    expect((error as Error).message).toMatch(/access token/i);
  });

  it('reads a rate limit as an outage rather than a refusal', async () => {
    const fetch = vi.fn().mockResolvedValue(respond({ errors: [{ message: 'slow down' }] }, 429));
    const adapter = new ExpoPushAdapter({ fetch });

    await expect(adapter.send(MESSAGE, ['ExponentPushToken[a]'])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('reads an abort as a timeout', async () => {
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const adapter = new ExpoPushAdapter({ fetch });

    await expect(adapter.send(MESSAGE, ['ExponentPushToken[a]'])).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
  });

  it('passes a path as data, and never a URL', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(ok(1)));
    const adapter = new ExpoPushAdapter({ fetch });

    await adapter.send({ ...MESSAGE, path: '/activity' }, ['ExponentPushToken[a]']);

    const sent = JSON.parse(fetch.mock.calls[0]![1].body as string) as { data?: unknown }[];
    // A path the app resolves against its own router, so a notification can
    // never send a customer of a bank to a page somebody else chose.
    expect(sent[0]!.data).toEqual({ path: '/activity' });
  });
});
