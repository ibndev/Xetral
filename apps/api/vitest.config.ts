import { defineConfig } from 'vitest/config';

/**
 * The default suite runs anywhere, with no database.
 *
 * The e2e suite is excluded rather than skipped-when-unavailable, because a
 * suite that silently skips when DATABASE_URL is unset is a suite that reports
 * green on a machine where it never ran — the same failure mode as a constraint
 * nobody has watched fail. `npm run test:e2e` runs it, and it fails loudly if
 * the database is not there.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.e2e.test.ts'],
  },
});
