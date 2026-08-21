import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

/**
 * Bundles the API into a single ESM file.
 *
 * Why bundle rather than `tsc` alone: the workspace packages ship raw
 * TypeScript (`"main": "./src/index.ts"`), which vitest and tsc both resolve
 * happily but Node does not. Emitting plain JS would leave
 * `import '@xetral/identity'` in the output, pointing at a .ts file the runtime
 * cannot load. Bundling folds those sources in and sidesteps the whole problem
 * without forcing a build step onto every package.
 *
 * Third-party dependencies stay EXTERNAL. Bundling NestJS would break its lazy
 * `require` of platform packages, and pulling `pg` into the bundle risks the
 * same with its optional native bindings. They are installed at deploy time
 * from package.json like any other Node service.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const external = Object.keys(pkg.dependencies ?? {}).filter(
  // Workspace packages are ours and are bundled; everything else is installed.
  (name) => !name.startsWith('@xetral/'),
);

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Nest resolves some providers by class name; mangling them turns a working
  // app into an unresolvable-dependency error at boot.
  keepNames: true,
  external,
  logLevel: 'info',
});
