import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
