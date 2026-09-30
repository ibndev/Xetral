import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The `@/` alias, so a test can import a component rather than parse its
 * source.
 *
 * `nav-coverage.test.ts` imports the sidebar's own destination list and checks
 * it against the pages on disk. Reading that list out of the file as text
 * would work until somebody reformats it — and a coverage test that silently
 * stops matching is worse than none, which is the lesson the API's route
 * coverage already records.
 *
 * It mirrors `tsconfig.json`'s `paths`. Two places, and they cannot disagree
 * about anything more than this one entry.
 */
export default defineConfig({
  /*
   * JSX is COMPILED here, whatever `tsconfig.json` says. Next wants
   * `"jsx": "preserve"` because Next transforms JSX itself; Vite 8's
   * transformer (oxc) honours that setting, leaves the JSX in place, and the
   * import analysis that follows cannot parse it — so every test importing a
   * `.tsx` module failed to load at all. Vite 5's esbuild ignored the setting,
   * which is why this only surfaced with the vitest 4 upgrade.
   */
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
