import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE SCREEN, ONE TITLE, AND THE SHELL DRAWS IT.
 *
 * `Shell` renders the page head — the back arrow and the screen's name — for
 * every screen that declares `back` or `onBack`. A page that also writes its
 * own `<h1>` is making a second claim to be the top of the same screen, and
 * the CSS agrees with whichever is larger: the Crypto screen's "Receive" was
 * an `<h1>` and the Shell's "Crypto" a `.page-head h1` at 20px, so a section
 * heading halfway down the page rendered BIGGER than the page it was a
 * section of. Bills had the same shape.
 *
 * Nothing could have reported it. Both headings were correct markup, both
 * were styled by rules that are right on their own, and the only place the
 * inversion exists is on screen — the reason this repo renders and looks
 * rather than reasoning about pixels.
 *
 * A TOP-LEVEL SCREEN IS EXEMPT, because there is no page head for it to
 * compete with: the home, cards, activity and more tabs get the brand header
 * and write their own heading.
 */

const APP = join(new URL('.', import.meta.url).pathname, '..', 'app');

/** Every customer-facing `page.tsx`, excluding the operations surface. */
function pages(dir: string, out: string[] = [], all = false): string[] {
  for (const entry of readdirSync(dir)) {
    if (!all && (entry === 'admin' || entry === 'api')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) pages(path, out, all);
    else if (entry.endsWith('.tsx')) {
      // On the customer side only a `page.tsx` draws a screen; on the
      // operations side the heading could be in any component under it.
      if (all || entry === 'page.tsx') out.push(path);
    }
  }
  return out;
}

describe('one title per screen', () => {
  it('a screen with a back arrow does not write its own <h1>', () => {
    const offenders: string[] = [];
    for (const path of pages(APP)) {
      const source = readFileSync(path, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
      const hasBack = /<Shell[^>]*\b(back=|onBack=)/.test(source) || /\bback=["'{]/.test(source);
      if (hasBack && /<h1[\s>]/.test(source)) offenders.push(path.slice(APP.length + 1));
    }
    expect(
      offenders,
      'these screens have a page head from Shell AND an <h1> of their own — ' +
        'the section heading will render larger than the screen it is in:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('no operations screen writes its own <h1>', () => {
    /*
     * THE SAME RULE, ON THE OTHER SURFACE. `AdminShell` puts the screen's
     * name in the top bar, where the admin comp does — and every one of the
     * twenty-six pages was also writing an `<h1>` inside its first panel, so
     * after the bar arrived "Customers" appeared twice on the customers
     * screen, once as chrome and once as content.
     *
     * `AdminTitle` is how a screen says it is called something more specific
     * than its sidebar entry: `/admin/risk` is the compliance QUEUE and
     * `/admin/risk/cases` the compliance CASES, both under one entry.
     *
     * `nav.tsx` holds the bar's own heading and `gate.tsx` is the sign-in
     * screen, which has no shell around it.
     */
    const dir = join(APP, 'admin');
    const offenders: string[] = [];
    for (const path of pages(dir, [], true)) {
      if (/\/(nav|gate)\.tsx$/.test(path)) continue;
      const source = readFileSync(path, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
      if (/<h1[\s>]/.test(source)) offenders.push(path.slice(APP.length + 1));
    }
    expect(
      offenders,
      'the operations shell names the screen in its top bar; these also write ' +
        'their own <h1>, so the name appears twice:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the page head is the only place a screen title is styled', () => {
    // If this stops being true the exemption above stops being safe: a
    // top-level screen's own <h1> is fine precisely because it is the only
    // heading on it.
    const css = readFileSync(join(APP, 'globals.css'), 'utf8');
    expect(css).toContain('.page-head h1 {');
  });
});
