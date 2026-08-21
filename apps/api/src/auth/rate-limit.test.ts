import { describe } from 'vitest';
import { InMemoryRateLimitStore } from './rate-limit.js';
import { rateLimitContract } from './rate-limit.contract.js';

/**
 * The in-memory store against the shared contract. The Redis store is held to
 * the same one in `rate-limit.redis.e2e.test.ts`, which needs a live Redis and
 * therefore runs under `npm run test:e2e`.
 */
describe('InMemoryRateLimitStore', () => {
  rateLimitContract(() => new InMemoryRateLimitStore());
});
