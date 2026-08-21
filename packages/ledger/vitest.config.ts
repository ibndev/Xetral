import { defineConfig } from 'vitest/config';

/** The e2e suite needs the ledger schema in a live PostgreSQL. Excluded rather
 *  than skipped-when-unavailable: a suite that quietly skips reports green on a
 *  machine where it never ran. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.e2e.test.ts'],
  },
});
