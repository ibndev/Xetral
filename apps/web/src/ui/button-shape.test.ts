import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A BUTTON IS A ROUNDED RECTANGLE, AND THE COMPS ARE WHAT SAY SO.
 *
 * Every button in this product was a pill — `--r-pill`, 999px — and it had
 * been since the palette change, on the strength of nobody measuring. Neither
 * design comp has a single one. `docs/mockups/app.html` carries three
 * full-width actions at 16px, two keypad keys at 14px and two quiet buttons
 * with no radius at all; `docs/mockups/admin.html` gives `.btnp` and `.btng`
 * 10px each. Every `border-radius:999px` in either file is on a chip, a
 * segment, a status pill, a flag or an avatar.
 *
 * The distinction is what the shape SAYS. A pill is a label — a status, a
 * filter, a tag, something read rather than pressed. A rounded rectangle is a
 * surface. Spending the product's one "this is a tag" shape on the element
 * that is never a tag left a filled action and a status chip as the same
 * object in two colours.
 *
 * This reads the comps rather than asserting a number, so the guard cannot
 * outlive the decision: republish a comp with pill buttons and it goes green
 * on its own.
 */

const HERE = new URL('.', import.meta.url).pathname;
const CSS = readFileSync(join(HERE, '..', 'app', 'globals.css'), 'utf8');
const MOCKUPS = join(HERE, '..', '..', '..', '..', 'docs', 'mockups');

/** Every `<button …>` open tag in a comp, with its inline style attribute. */
function buttonStyles(file: string): readonly string[] {
  const html = readFileSync(join(MOCKUPS, file), 'utf8');
  return [...html.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1] ?? '');
}

/** The declaration block of a selector list, by its exact spelling. */
function block(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} is not in globals.css`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('buttons are not pills', () => {
  it('no button in either comp is a pill', () => {
    for (const file of ['app.html', 'admin.html']) {
      const pills = buttonStyles(file).filter((s) => s.includes('border-radius:999px'));
      expect(pills, `${file} has a pill button`).toEqual([]);
    }
  });

  it('the customer app rounds its buttons the way the app comp does', () => {
    // The comp's own number, read out of it rather than typed here.
    const radii = new Set(
      buttonStyles('app.html')
        .map((s) => /border-radius:([0-9]+)px/.exec(s)?.[1])
        .filter((r): r is string => r !== undefined),
    );
    expect(radii.has('16')).toBe(true);

    const base = block('.btn, button');
    expect(base).toContain('border-radius: 16px');
    expect(base, 'the base button reached for the pill token again').not.toContain('--r-pill');
  });

  it('the operations surface rounds tighter, as the admin comp does', () => {
    const admin = readFileSync(join(MOCKUPS, 'admin.html'), 'utf8');
    // `.btnp` is the filled action and `.btng` the outlined one; both 10px.
    for (const cls of ['.btnp', '.btng']) {
      const at = admin.indexOf(`${cls}{`);
      expect(at, `${cls} is not in the admin comp`).toBeGreaterThan(-1);
      expect(admin.slice(at, admin.indexOf('}', at))).toContain('border-radius:10px');
    }
    expect(block('.admin-frame .btn, .admin-frame button')).toContain('border-radius: 10px');
  });

  it('the keypad keeps the comp’s smaller key', () => {
    // 14px, and it is the one place the two disagree on purpose: a key is
    // pressed among eleven others and a 16px corner on a 48px square starts
    // to read as a circle.
    expect(block('.sf-key')).toContain('border-radius: 14px');
  });
});
