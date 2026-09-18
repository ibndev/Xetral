import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE OPERATIONS NAV MUST NOT BE ABLE TO CLIP ITSELF AGAIN.
 *
 * WHAT IT COST. `.admin-side` was a single `overflow-y: auto` column pinned to
 * `height: 100vh`, holding the brand, every group AND the footer — 1375px of
 * content in a 900px laptop viewport. Measured in a browser: eight
 * destinations were simply not on screen, "Settings" was cut through the
 * middle of its glyphs, and the page's own scrollbar moved none of it. Staff,
 * Announcements, Audit, Readiness, Diagnostics and Your authenticator were
 * among the missing — and `nav.tsx`'s own comment says the sidebar exists
 * because a horizontal strip had exactly that fault, with "Provider keys,
 * Staff, Audit and Readiness" named as the four an operator reaches for
 * during an incident. The replacement reintroduced it vertically.
 *
 * NOTHING COULD HAVE CAUGHT IT. `nav-coverage.test.ts` proves every
 * destination is LISTED, which it was — the list was complete and most of it
 * was invisible. A typecheck sees no difference, a render sees no difference,
 * and a screenshot of the top of the page looks perfect.
 *
 * So this asserts the SHAPE the fix depends on, in the stylesheet, rather
 * than the pixels: the sidebar itself must not be the scroller, its nav
 * region must be, and that region needs `min-height: 0` — a flex child
 * defaults to `min-height: auto` and refuses to shrink below its content, so
 * without it `overflow-y` on a flex column silently does nothing and the
 * whole fault returns looking like it was fixed.
 */
const CSS = readFileSync(new URL('../globals.css', import.meta.url).pathname, 'utf8');

/** The body of one rule, by selector. Enough for a declaration check. */
function ruleFor(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('the operations sidebar cannot clip its own navigation', () => {
  it('the sidebar itself is not the scrolling element', () => {
    const body = ruleFor('.admin-side');
    expect(
      body,
      'the sidebar must not scroll as a whole — that is what clipped the ' +
        'nav and hid the footer with it. Scroll `.admin-side-scroll` instead.',
    ).toMatch(/overflow:\s*hidden/);
    expect(body).not.toMatch(/overflow-y:\s*auto/);
  });

  it('the nav region scrolls, and can actually shrink to do it', () => {
    const body = ruleFor('.admin-side-scroll');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(
      body,
      'without `min-height: 0` a flex child will not shrink below its ' +
        'content, so `overflow-y` does nothing and the list is clipped again ' +
        'while this rule still reads as correct.',
    ).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/flex:\s*1/);
  });

  it('says out loud that it scrolls', () => {
    /*
     * A bounded region whose last row is sliced through the glyphs, with an
     * overlay scrollbar that only appears while scrolling, reads as a broken
     * layout rather than as "there is more below" — so nobody scrolls and the
     * destinations under it stay unreachable. That was still true after the
     * first version of this fix, and only looking at it showed that.
     */
    expect(CSS, 'the nav needs a permanently visible scrollbar').toContain(
      '.admin-side-scroll::-webkit-scrollbar',
    );
    expect(CSS, 'and a faded edge rather than a hard cut').toContain(
      '.admin-side-foot::before',
    );
  });

  it('keeps the footer out of the scrolling region', () => {
    const body = ruleFor('.admin-side-foot');
    expect(
      body,
      'Sign out must not require scrolling a list of twenty-five destinations.',
    ).toMatch(/flex:\s*0 0 auto/);
  });
});
