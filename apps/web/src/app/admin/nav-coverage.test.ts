import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUPS } from './nav';

/**
 * Every operations page has a way in, and every way in leads to a page.
 *
 * The navigation was rebuilt from a flat strip of sixteen tabs into grouped
 * sections, and the risk in that edit is silent in both directions: a
 * destination dropped while regrouping is a screen that still works and that
 * nobody can reach, and an entry left pointing at a deleted page is a link
 * that 404s from the dashboard's own sidebar.
 *
 * Neither shows up in a typecheck, in a render, or in a diff of a list that
 * has just been reshuffled. This is the same check `route-coverage.test.ts`
 * runs on the API — and it exists there because a hand-written list of
 * controllers drifted from the module and three whole surfaces answered 404
 * while a coverage test reported full coverage.
 */

const HERE = new URL('.', import.meta.url).pathname;

/**
 * Routes under /admin, from the filesystem — Next's own source of truth.
 *
 * `withFileTypes` rather than `readdirSync` then `statSync`. The two-call form
 * is a check followed by a use of the thing checked, which CodeQL flags as a
 * filesystem race and is right to: between the two the entry can be replaced.
 * It is also two syscalls per entry where the directory read already carried
 * the answer.
 */
function pages(dir: string, prefix: string): readonly string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const here = entries.some((entry) => entry.name === 'page.tsx') ? [prefix] : [];
  const below = entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    // A dynamic segment is not a destination — /admin/users/[id] is reached
    // from the customer list, not from the sidebar.
    if (entry.name.startsWith('[')) return [];
    return pages(join(dir, entry.name), `${prefix}/${entry.name}`);
  });
  return [...here, ...below];
}

/** Every /admin address any operations page links to. */
function linksIn(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return linksIn(path);
    if (!entry.name.endsWith('.tsx')) return [];
    return Array.from(
      readFileSync(path, 'utf8').matchAll(/['"`](\/admin(?:\/[a-z-]+)*)['"`]/g),
      (m) => m[1] as string,
    );
  });
}

describe('operations navigation coverage', () => {
  const linked = GROUPS.flatMap((group) => group.items.map((item) => item.href));
  const onDisk = pages(HERE, '/admin');

  it('every page under /admin can be reached', () => {
    // From the sidebar, or from a page that is itself in the sidebar. A case
    // file is opened from the signal queue rather than from the nav, which is
    // right — what must never happen is a page NOTHING points at.
    const reachable = new Set([...linked, ...linksIn(HERE)]);
    const unreachable = onDisk.filter((route) => !reachable.has(route)).sort();
    expect(
      unreachable,
      `pages nothing links to — they work and nobody can find them:\n${unreachable.join('\n')}`,
    ).toEqual([]);
  });

  it('every sidebar entry points at a page that exists', () => {
    const dangling = linked.filter((route) => !onDisk.includes(route)).sort();
    expect(dangling, `sidebar entries with no page:\n${dangling.join('\n')}`).toEqual([]);
  });

  it('no destination is listed twice', () => {
    expect(linked).toEqual([...new Set(linked)]);
  });
});
