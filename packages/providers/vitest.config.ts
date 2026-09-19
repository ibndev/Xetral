import { defineConfig } from 'vitest/config';

/** The default suite runs anywhere. The e2e suite needs the ledger schema in a
 *  live PostgreSQL and is excluded rather than skipped-when-unavailable — a
 *  suite that quietly skips reports green on a machine where it never ran. */
export default defineConfig({
  test: {
    /*
     * `scripts/` IS IN HERE BECAUSE NOTHING ELSE RAN IT. The Flutterwave
     * verification script is the instrument that decides whether this
     * package's constants match the real API, and it had no test of its own —
     * so its first live run reported four failures, of which three were
     * correct answers it did not recognise. A script that reports a false
     * failure is the one people learn to skip.
     *
     * Its decisions live in `scripts/flutterwave-verify.mjs`, beside this
     * package because that is what they are about.
     */
    include: ['src/**/*.test.ts', '../../scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', 'src/**/*.e2e.test.ts'],
  },
});
