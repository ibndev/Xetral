import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    // The flows are stateful -- rotation consumes tokens, reuse revokes
    // families -- so they share one database and must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
