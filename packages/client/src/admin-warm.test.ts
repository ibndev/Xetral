import { describe, expect, it, vi } from 'vitest';
import { AdminClient } from './admin.js';
import { MemoryTokenStore, Session } from './session.js';

const NOW = 1_800_000_000;

async function makeAdmin(fetchImpl: ReturnType<typeof vi.fn>) {
  const store = new MemoryTokenStore();
  await store.write({ accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 900 });
  const session = new Session({
    baseUrl: 'https://web.test/api/x',
    store,
    fetch: fetchImpl as unknown as typeof fetch,
    nowSeconds: () => NOW,
  });
  return new AdminClient({ baseUrl: 'https://web.test/api/x', session, fetch: fetchImpl as unknown as typeof fetch });
}

describe('a write after a quiet spell', () => {
  it('proves the line with a read first, retrying it, and sends the write ONCE', async () => {
    let dropped = 1;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        if (dropped-- > 0) throw new TypeError('Failed to fetch');
        return new Response('{}', { status: 200 });
      }
      expect(init?.method).toBe('DELETE');
      return new Response('{}', { status: 200 });
    });
    const admin = await makeAdmin(fetchImpl);

    await admin.deleteFxRate('0b5e1b38-2f4c-4e8e-9d1b-3a1c1f0b9c11', 'a retired rate nobody uses', '1234');

    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith('/health'))).toHaveLength(2);
    expect(urls.filter((u) => u.includes('/fx-rate/'))).toHaveLength(1);
    expect(urls.at(-1)).toContain('/fx-rate/');
  });

  it('does not send the write at all when the line cannot be proved', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const admin = await makeAdmin(fetchImpl);
    vi.useFakeTimers();
    // A minute on from the first test's answer: the line has gone quiet.
    vi.setSystemTime(Date.now() + 60_000);
    try {
      const pending = admin.retirePrice('0b5e1b38-2f4c-4e8e-9d1b-3a1c1f0b9c11', 'fx', 'a reason long enough', '1234');
      const outcome = expect(pending).rejects.toMatchObject({ code: 'network' });
      await vi.runAllTimersAsync();
      await outcome;
    } finally {
      vi.useRealTimers();
    }
    const urls = fetchImpl.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls.every((u) => u.endsWith('/health'))).toBe(true);
  });
});
