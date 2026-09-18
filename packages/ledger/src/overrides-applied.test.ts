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

describe('every dependency override is actually applied', () => {
  const overrides: Record<string, string> =
    (JSON.parse(readFileSync(ROOT, 'utf8')) as { overrides?: Record<string, string> }).overrides ??
    {};
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };

  it('declares at least one, so a silent zero cannot pass this', () => {
    /*
     * An empty object agrees with every possible lockfile. The day the last
     * override is legitimately removed, delete this file with it — the same
     * call `e2e-env.test.ts` makes about finding no suites.
     */
    expect(Object.keys(overrides).length, 'no overrides declared').toBeGreaterThan(0);
  });

  it('understands every range it is asked to check', () => {
    const unreadable = Object.entries(overrides)
      .filter(([, range]) => !CARET.test(range))
      .map(([name, range]) => `${name}: ${range}`);
    expect(
      unreadable,
      'this test only reads `^x.y.z`. Widen it deliberately rather than ' +
        `leaving an override unchecked:\n${unreadable.join('\n')}`,
    ).toEqual([]);
  });

  it('resolved a version that satisfies each one', () => {
    const wrong: string[] = [];
    for (const [name, range] of Object.entries(overrides)) {
      const m = CARET.exec(range);
      if (m === null) continue;
      const floor = [Number(m[1]), Number(m[2]), Number(m[3])];
      const entries = Object.entries(lock.packages).filter(([path]) =>
        path.endsWith(`node_modules/${name}`),
      );
      if (entries.length === 0) {
        wrong.push(`${name}: declared ${range} and resolved to NOTHING in the lockfile`);
        continue;
      }
      for (const [path, entry] of entries) {
        const version = entry.version ?? '';
        /* A major above the caret's is outside it, not merely "at least". */
        const inRange = version.startsWith(`${floor[0]}.`) && atLeast(version, floor);
        if (!inRange) {
          wrong.push(`${path}: declared ${range} and resolved ${version || '(no version)'}`);
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
