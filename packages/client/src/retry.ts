import { ApiError } from './errors.js';

/**
 * A READ that met a dropped connection, asked again before anybody is told.
 *
 * A phone coming back to the foreground, a tab restored after the handset
 * slept, a hop between Wi-Fi and mobile data: each makes the first request
 * after it fail before it leaves, and every screen then drew "No connection.
 * Check your network and try again." beside data that had loaded perfectly a
 * moment earlier — on the admin prices screen, over a table it was showing.
 *
 * ONLY `network`, and ONLY for reads. `network` is our own code for a request
 * that never got an answer; a refusal the server gave is an answer, and asking
 * again would only repeat it. Screens pass loads, which are GETs, so asking
 * again moves nothing — a submission never comes through here, because a
 * write whose answer was lost is exactly the case that must NOT be repeated
 * without its idempotency key.
 */
export async function retryOnNetwork<T>(
  load: () => Promise<T>,
  delaysMs: readonly number[] = [700, 2000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (cause) {
      const delay = delaysMs[attempt];
      if (!(cause instanceof ApiError) || cause.code !== 'network' || delay === undefined) throw cause;
      await sleep(delay);
    }
  }
}
