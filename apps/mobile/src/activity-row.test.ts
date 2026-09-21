import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE TWO APPS DRAW ONE TRANSACTION ROW, AND NOTHING ELSE COULD SAY SO.
 *
 * Each app keeps its own copy because they are two rendering systems — CSS
 * and a React Native stylesheet — not because the design differs. That is
 * exactly the shape the fulfilment port warns about: two hand-written copies
 * of one thing drift into two behaviours while both stay green, and the copy
 * that drifts is the one nobody is looking at.
 *
 * So the NUMBERS are compared as text, in both files. A row is the densest
 * thing either app draws and every figure in it is a decision from
 * `docs/mockups/app.html`: a 44px avatar, 13px between the columns, 12px of
 * vertical padding, and four type sizes that set the hierarchy — the name at
 * 15, the descriptor at 12.5, the amount at 14.5, the time at 11.5, with the
 * day heading at 11.
 *
 * This is deliberately NOT a check that the two files are identical. It is a
 * check that the numbers a reader would compare by eye agree, which is what
 * drifts — and it reads them out of the comp's own vocabulary rather than
 * asserting a snapshot nobody can review.
 */

const HERE = new URL('.', import.meta.url).pathname;
const PHONE = readFileSync(join(HERE, 'tx-list.tsx'), 'utf8');
const WEB_CSS = readFileSync(join(HERE, '..', '..', 'web', 'src', 'app', 'globals.css'), 'utf8');
const COMP = readFileSync(
  join(HERE, '..', '..', '..', 'docs', 'mockups', 'app.html'),
  'utf8',
);

/** The declaration block of a CSS selector, by its exact spelling. */
function rule(selector: string): string {
  const at = WEB_CSS.indexOf(`${selector} {`);
  expect(at, `${selector} is not in globals.css`).toBeGreaterThan(-1);
  return WEB_CSS.slice(at, WEB_CSS.indexOf('}', at));
}

describe('one transaction row across both apps', () => {
  it('the comp is where these numbers come from', () => {
    // The activity row in `app.html`: a 44px mark, 13px gap, 12px padding.
    expect(COMP).toContain('width:44px;height:44px');
    expect(COMP).toContain('gap:13px;padding:12px 0');
  });

  it('the row geometry agrees', () => {
    expect(rule('.tx-row')).toContain('gap: 13px');
    expect(rule('.tx-row')).toContain('padding: 12px 0');
    expect(rule('.tx-mark')).toContain('width: 44px');

    expect(PHONE).toContain('gap: 13');
    expect(PHONE).toContain('paddingVertical: 12');
    expect(PHONE).toContain('width: 44, height: 44');
  });

  it('the four type sizes agree', () => {
    for (const [selector, size] of [
      ['.tx-main .tx-name', '15px'],
      ['.tx-main .tx-sub', '12.5px'],
      ['.tx-side .tx-amt', '14.5px'],
      ['.tx-side .tx-time', '11.5px'],
      ['.day-head', '11px'],
    ] as const) {
      expect(rule(selector), `${selector} should be ${size}`).toContain(`font-size: ${size}`);
    }
    for (const size of [15, 12.5, 14.5, 11.5, 11]) {
      expect(PHONE, `the phone's row has no ${size}px text`).toContain(`fontSize: ${size}`);
    }
  });

  it('both read the descriptor from the entry KIND, never the description', () => {
    // A free-text description is written by whichever flow posted the entry
    // and says whatever that flow happened to say; `kind` is a closed enum.
    expect(PHONE).toContain('entryKindLabel(entry.kind)');
    const web = readFileSync(join(HERE, '..', '..', 'web', 'src', 'ui', 'tx-list.tsx'), 'utf8');
    expect(web).toContain('entryKindLabel(entry.kind)');
  });

  it('money leaving is red and money arriving is green, in both', () => {
    // Matched on the declaration rather than through `rule()`: these two are
    // written on one line each and the helper looks for `selector {`.
    expect(WEB_CSS).toMatch(/\.tx-amt\.in\s*\{\s*color:\s*var\(--ok\)/);
    expect(WEB_CSS).toMatch(/\.tx-amt\.out\s*\{\s*color:\s*var\(--danger\)/);
    expect(PHONE).toContain('outgoing ? colors.danger : colors.ok');
  });
});
