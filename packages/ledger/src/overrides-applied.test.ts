import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AN OVERRIDE NPM DID NOT APPLY LOOKS EXACTLY LIKE ONE IT DID.
 *
 * `@nestjs/platform-express` pins `multer` at EXACTLY `2.2.0`, which is the
 * top of the affected range for four denial-of-service advisories, so no
 * resolve can reach a fixed version on its own. A root `overrides` entry is
 * the only instrument that moves it — and npm 10.9.7 evaluates `overrides`
 * ONLY when it is building a lockfile from nothing. Run `npm install` with a
 * lockfile already present and the lockfile wins: the override is accepted,
 * NOTHING IS PRINTED, and the vulnerable version stays on disk. Dropping the
 * package's entries from the lockfile to force a re-resolve does not work
 * either — npm prunes them rather than resolving them again.
 *
 * So the declaration and the effect are two different facts, and only one of
 * them is visible in a diff. This asserts the second: what the lockfile
 * actually resolved must satisfy what the override asked for. Without it, a
 * future `npm install` against a hand-edited lockfile silently reintroduces
 * the advisory while `package.json` still reads as though it were fixed —
 * and the audit gate in ci.yml only fires once a scanner has a CVE for
 * whatever came back.
 *
 * It refuses a range it cannot check rather than passing one, for 017's
 * reason: forgetting must never be the permissive direction.
 */
const ROOT = new URL('../../../package.json', import.meta.url).pathname;
const LOCK = new URL('../../../package-lock.json', import.meta.url).pathname;

/** `^x.y.z` only. Anything else is refused below rather than waved through. */
const CARET = /^\^(\d+)\.(\d+)\.(\d+)$/;

function atLeast(version: string, floor: readonly number[]): boolean {
  const got = version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const a = got[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * One requirement: `name` must resolve to `range` — everywhere, or only as
 * seen from `parent` when the override is SCOPED (`{ "xcode": { "uuid": … } }`).
 * A scoped override moves one consumer's copy and leaves every other
 * consumer's alone, which is the point of scoping it.
 */
interface Requirement {
  readonly name: string;
  readonly range: string;
  readonly parent?: string;
}

type Overrides = Record<string, string | Record<string, string>>;

function requirements(overrides: Overrides): Requirement[] {
  return Object.entries(overrides).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [{ name: key, range: value }]
      : Object.entries(value).map(([name, range]) => ({ name, range, parent: key })),
  );
}

/**
 * The lockfile path Node would load `name` from when `from` requires it: its
 * own `node_modules` first, then each enclosing one, then the root — the
 * lookup `require` performs, so the answer is the copy that actually runs.
 */
function resolveFrom(
  packages: Record<string, unknown>,
  from: string,
  name: string,
): string | undefined {
  let base = from;
  for (;;) {
    const candidate = `${base}/node_modules/${name}`;
    if (candidate in packages) return candidate;
    const cut = base.lastIndexOf('/node_modules/');
    if (cut === -1) break;
    base = base.slice(0, cut);
  }
  const root = `node_modules/${name}`;
  return root in packages ? root : undefined;
}

describe('every dependency override is actually applied', () => {
  const overrides: Overrides =
    (JSON.parse(readFileSync(ROOT, 'utf8')) as { overrides?: Overrides }).overrides ?? {};
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const required = requirements(overrides);

  it('declares at least one, so a silent zero cannot pass this', () => {
    /*
     * An empty object agrees with every possible lockfile. The day the last
     * override is legitimately removed, delete this file with it — the same
     * call `e2e-env.test.ts` makes about finding no suites.
     */
    expect(required.length, 'no overrides declared').toBeGreaterThan(0);
  });

  it('understands every range it is asked to check', () => {
    const unreadable = required
      .filter(({ range }) => !CARET.test(range))
      .map(({ name, range, parent }) => `${parent === undefined ? '' : `${parent} > `}${name}: ${range}`);
    expect(
      unreadable,
      'this test only reads `^x.y.z`. Widen it deliberately rather than ' +
        `leaving an override unchecked:\n${unreadable.join('\n')}`,
    ).toEqual([]);
  });

  it('resolved a version that satisfies each one', () => {
    const wrong: string[] = [];
    const satisfies = (version: string, floor: readonly number[]): boolean =>
      /* A major above the caret's is outside it, not merely "at least". */
      version.startsWith(`${floor[0]}.`) && atLeast(version, floor);

    for (const { name, range, parent } of required) {
      const m = CARET.exec(range);
      if (m === null) continue;
      const floor = [Number(m[1]), Number(m[2]), Number(m[3])];
      const label = parent === undefined ? name : `${parent} > ${name}`;

      // Flat: every copy anywhere. Scoped: the copy each parent would load.
      const paths =
        parent === undefined
          ? Object.keys(lock.packages).filter((path) => path.endsWith(`node_modules/${name}`))
          : Object.keys(lock.packages)
              .filter((path) => path.endsWith(`node_modules/${parent}`))
              .map((from) => resolveFrom(lock.packages, from, name) ?? `${from} (resolves no ${name})`);

      if (paths.length === 0) {
        wrong.push(`${label}: declared ${range} and resolved to NOTHING in the lockfile`);
        continue;
      }
      for (const path of paths) {
        const version = lock.packages[path]?.version ?? '';
        if (!satisfies(version, floor)) {
          wrong.push(`${label} at ${path}: declared ${range} and resolved ${version || '(no version)'}`);
        }
      }
    }
    expect(
      wrong,
      'npm applies `overrides` only when it builds a lockfile from nothing, ' +
        'and says nothing when it does not. Delete package-lock.json and run ' +
        `npm install:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });
});
