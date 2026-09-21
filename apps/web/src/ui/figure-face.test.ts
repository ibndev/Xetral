import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TWO SURFACES, TWO FIGURE FACES, AND THE COMPS ARE WHAT SAY SO.
 *
 * `docs/mockups/app.html` contains the string "Space Grotesk" ZERO times:
 * every customer figure — the balance, a transaction amount, the keypad, the
 * account number — is Manrope with `tabular-nums`. `docs/mockups/admin.html`
 * sets `.kval` and `.mono` in Space Grotesk, which is right for a dashboard
 * whose subject is columns of numbers.
 *
 * This repo has had them the other way round once already, and the symptom is
 * invisible in review: the markup is correct, the class is applied, and the
 * only difference is which typeface draws a digit. It reads as "the figures
 * look slightly off" and nothing in the toolchain has an opinion.
 *
 * So the faces are checked AGAINST THE COMPS rather than against a number
 * typed here — republish a comp with a different face and this goes green on
 * its own.
 */

const HERE = new URL('.', import.meta.url).pathname;
const CSS = readFileSync(join(HERE, '..', 'app', 'globals.css'), 'utf8');
const MOCKUPS = join(HERE, '..', '..', '..', '..', 'docs', 'mockups');
const APP = readFileSync(join(MOCKUPS, 'app.html'), 'utf8');
const ADMIN = readFileSync(join(MOCKUPS, 'admin.html'), 'utf8');

/** The declaration block of a selector list, by its exact spelling. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} is not in globals.css`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the figure face follows the surface', () => {
  it('the customer comp has no Space Grotesk in it at all', () => {
    expect(APP).not.toContain('Space Grotesk');
    // And it does set its figures in the display face with tabular numerals.
    expect(APP).toContain('font-variant-numeric:tabular-nums');
    expect(APP).toContain('Manrope');
  });

  it('the admin comp sets its figures in Space Grotesk', () => {
    expect(ADMIN).toContain("'Space Grotesk'");
    const at = ADMIN.indexOf('.kval{');
    expect(at, '.kval is not in the admin comp').toBeGreaterThan(-1);
    expect(ADMIN.slice(at, ADMIN.indexOf('}', at))).toContain('Space Grotesk');
  });

  it('the tokens point at the right families', () => {
    /* The families arrive through `next/font`, so the token names a CSS
       variable the loader defines — `--font-manrope`, `--font-grotesk` — and
       not the family string. Checked on those, because that is the name a
       change would have to go through. */
    expect(CSS, '--font-num is the CUSTOMER figure face').toMatch(
      /--font-num:\s*var\(--font-manrope\)/,
    );
    expect(CSS, '--font-mono is the ADMIN figure face').toMatch(
      /--font-mono:\s*var\(--font-grotesk\)/,
    );
  });

  it('a customer amount is the display face and an operations one is not', () => {
    expect(rule('.amount, .figure, td.amount')).toContain('font-family: var(--font-num)');
    expect(
      rule('.admin-frame .amount,\n.admin-frame .figure,\n.admin-frame td.amount,\n.admin-frame td.right'),
    ).toContain('font-family: var(--font-mono)');
    expect(rule('.stat .value'), 'the KPI figure is the admin comp’s').toContain(
      'font-family: var(--font-mono)',
    );
  });
});
