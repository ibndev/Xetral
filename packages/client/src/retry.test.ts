import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { retryOnNetwork } from './retry.js';

const noSleep = async (): Promise<void> => undefined;

describe('a read that met a dropped connection', () => {
  it('is asked again, and the second answer is the one shown', async () => {
    let calls = 0;
    const value = await retryOnNetwork(async () => {
      calls += 1;
      if (calls === 1) throw new ApiError('network', 0);
      return 'loaded';
    }, [1, 1], noSleep);
    expect(value).toBe('loaded');
    expect(calls).toBe(2);
  });

  it('gives up after the stated attempts and surfaces the network error', async () => {
    let calls = 0;
    await expect(
      retryOnNetwork(async () => {
        calls += 1;
        throw new ApiError('network', 0);
      }, [1, 1], noSleep),
    ).rejects.toMatchObject({ code: 'network' });
    expect(calls).toBe(3);
  });

  it('never repeats a refusal the server gave', async () => {
    let calls = 0;
    await expect(
      retryOnNetwork(async () => {
        calls += 1;
        throw new ApiError('forbidden', 403);
      }, [1, 1], noSleep),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toBe(1);
  });
});
