import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every class name a component asks for must exist in the stylesheet.
 *
 * This test exists because six of them did not, and nothing said so. An
 * undefined CSS class is not an error in any layer: TypeScript has no opinion
 * about a string, the bundler emits it happily, and the browser applies the
 * empty set of rules and paints the page. The operations dashboard rendered
 * every day with `.panel` sections that were not cards and `.row` label/value
 * lines that ran together, and the header's brand, wallet link and sign-out
 * button touched each other — visibly wrong, and still invisible to the whole
 * toolchain and to a diff of the markup, which said exactly the right thing.
 *
 * It scans in one direction only. The reverse — a rule no component uses — is
 * dead CSS, which costs bytes and is worth a tidy-up, but it cannot make a
 * page render wrong, and failing the build over it would push somebody to
 * delete a rule that a page reaches for through a computed name.
 */

const HERE = new URL('.', import.meta.url).pathname;
const SRC = join(HERE, '..');
const CSS = join(SRC, 'app', 'globals.css');

/**
 * Names that are legitimately absent from globals.css. Each needs a reason:
 * an entry here is a hole in the check, so it must be cheaper to justify one
 * than to add one.
 */
const EXTERNAL = new Set<string>([
  // Next.js paints its own route-announcer and portal roots; these come from
  // the framework's stylesheet, not ours.
  'sr-only',
]);

function walk(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Class names with a rule in the stylesheet. */
function definedClasses(): ReadonlySet<string> {
  const css = readFileSync(CSS, 'utf8')
    // Comments carry prose about class names ("`.panel` sections had no card")
    // and would otherwise define every name they mention.
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  return new Set(Array.from(css.matchAll(/\.([a-zA-Z][\w-]*)/g), (m) => m[1] as string));
}

/** Class names a component asks for, with the file that asks. */
function usedClasses(): ReadonlyMap<string, readonly string[]> {
  const used = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g,
    )) {
      // A template hole makes the token TOUCHING it a prefix, not a name:
      // `d${delay}` builds d1..d4, and checking for a rule called `d` reports
      // a hole that is not there. Marking the hole rather than blanking it
      // keeps the whole names beside it checkable and drops only the built
      // one. Blanking it instead is how a check earns a false positive, and a
      // check that cries wolf gets an entry added to EXTERNAL to shut it up.
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, '\u0000');
      for (const name of raw.split(/\s+/)) {
        if (name.includes('\u0000')) continue;
        if (!/^[\w-]+$/.test(name)) continue;
        const at = used.get(name) ?? [];
        at.push(file.slice(SRC.length + 1));
        used.set(name, at);
      }
    }
  }
  return used;
}

describe('css class coverage', () => {
  it('every className used by a component has a rule in globals.css', () => {
    const defined = definedClasses();
    const orphans = Array.from(usedClasses())
      .filter(([name]) => !defined.has(name) && !EXTERNAL.has(name))
      .map(([name, files]) => `${name}  (${[...new Set(files)].sort().join(', ')})`)
      .sort();

    expect(orphans, `class names with no rule in globals.css:\n${orphans.join('\n')}`).toEqual([]);
  });

  it('finds the classes it is meant to be checking', () => {
    // A scanner that matched nothing would pass the test above for ever. This
    // asserts the parse actually works before the assertion above is trusted.
    const used = usedClasses();
    expect(used.size).toBeGreaterThan(50);
    expect(used.has('panel')).toBe(true);
    expect(definedClasses().has('appbar')).toBe(true);
  });
});
