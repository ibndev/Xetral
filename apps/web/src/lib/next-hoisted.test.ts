import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NEXT MUST BE INSTALLED AT THE ROOT, NOT INSIDE apps/web.
 *
 * `deploy/Dockerfile.web` copies the repository's ROOT `node_modules` into the
 * runtime image and starts the app with `npx next start`. A lockfile that
 * nests `next` under `apps/web/node_modules` builds perfectly — the build
 * stage has the whole tree — and then ships an image with no Next in it.
 *
 * It is one command away: `npm install next@<patch> -w apps/web` (the obvious
 * way to take a security fix) nested it, together with its `@next/*`
 * binaries. Nothing else would notice until a deploy.
 */
const here = new URL('.', import.meta.url).pathname;
const LOCK = JSON.parse(readFileSync(join(here, '../../../../package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string }>;
};
const DOCKERFILE = readFileSync(join(here, '../../../../deploy/Dockerfile.web'), 'utf8');

describe('where next is installed', () => {
  it('the runtime image copies only the root node_modules', () => {
    expect(DOCKERFILE).toMatch(/COPY --from=build [^\n]*\/repo\/node_modules \.\/node_modules/);
    expect(DOCKERFILE).not.toMatch(/apps\/web\/node_modules/);
  });

  it('resolves next and its runtime packages at the root', () => {
    expect(LOCK.packages['node_modules/next']?.version).toBeDefined();
    const nested = Object.keys(LOCK.packages).filter((path) =>
      /^apps\/web\/node_modules\/(next|@next\/)/.test(path),
    );
    expect(nested).toEqual([]);
  });
});
