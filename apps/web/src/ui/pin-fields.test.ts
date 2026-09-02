import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A CONTROL GATED ON THE PIN MUST BE IN A COMPONENT THAT ASKS FOR ONE.
 *
 * THE BUG THIS EXISTS FOR, which looked entirely correct in review. On the
 * cards screen the PIN box was rendered only when the top-up form was open or
 * the card was frozen — and THREE actions read that one value. So on an ACTIVE
 * card, "Show details" was `disabled={busy || pin === ''}` with no box anywhere
 * on screen to fill it: the only way to read your own card number was to open
 * *Add money*, type a PIN into a form that says it is for adding money, and
 * then press a different button.
 *
 * That is not a visual defect. It is a feature that does not exist — and it is
 * Phase 13's "every card issued since Phase 5 was unusable" finding coming
 * back one layer up, where the reveal endpoint, its rate limits and its e2e
 * tests are all present and correct and the customer cannot reach any of them.
 *
 * NOTHING HERE SAYS A PIN IS OPTIONAL. Every field this counts is on a route
 * declaring `pin: true`, and `route-coverage.test.ts` is what keeps that true
 * from the other side. This only asks that where the UI demands one, the UI
 * also offers somewhere to type it.
 *
 * A PIN INPUT IS RECOGNISED STRUCTURALLY — `type="password"` with
 * `inputMode="numeric"` — rather than by its label. The admin surface labels
 * its boxes `placeholder="Your PIN"` and the customer screens use a
 * `Transaction PIN` label, and a rule matching only one of those reported
 * eight correct components as violations on its first run. A rule that fires
 * on correct code is worse than no rule, because the fix is an exemption and
 * the next real finding gets the same treatment.
 */

const APP = join(new URL('.', import.meta.url).pathname, '..', 'app');

function walk(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * Source split at every top-level `function Name(`, so the question is asked
 * per COMPONENT. Crude on purpose: a real parser would be more machinery than
 * the thing being checked, and a component boundary in this codebase is always
 * a `function` at column zero.
 */
function components(source: string): readonly { name: string; body: string }[] {
  return source
    .split(/\n(?=(?:export )?(?:default )?function )/)
    .map((body) => ({
      name: /function\s+([A-Za-z0-9_]+)/.exec(body)?.[1] ?? '(module)',
      body,
    }));
}

/** Every PIN box in this app, and nothing else: a numeric password field. The
 *  signup passwords and the provider-key form match neither half. */
const PIN_INPUT = /type="password"[^>]*?inputMode="numeric"/s;

/**
 * A component that RECEIVES the PIN rather than collecting it.
 *
 * `/admin/prices` renders one PIN box at the top and hands the value to three
 * forms below it — one screen, one action, one place to type the secret, which
 * is the shape this rule wants rather than one it should refuse. The
 * distinction is exact rather than a carve-out: the cards bug had `pin` in
 * LOCAL STATE with no box, which is a component that asks for something it
 * never offers. A prop means the field is the parent's and the parent is
 * checked on its own.
 */
const TAKES_PIN_AS_A_PROP = /\bpin:\s*string\b/;

describe('asking for the transaction PIN', () => {
  it('never gates a control on a PIN the component gives no way to enter', () => {
    const offenders: string[] = [];

    for (const file of walk(APP)) {
      for (const { name, body } of components(readFileSync(file, 'utf8'))) {
        if (TAKES_PIN_AS_A_PROP.test(body)) continue;
        if (/pin === ''/.test(body) && !PIN_INPUT.test(body)) {
          offenders.push(`${file.slice(APP.length + 1)} → ${name}`);
        }
      }
    }

    expect(
      offenders,
      'these disable a control until a PIN is typed and render nowhere to type ' +
        `one, so the control can never be pressed:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('recognises a PIN box wherever the app draws one', () => {
    /*
     * The check above is vacuous if the detector matches nothing — the exact
     * way a coverage test stops covering. `no-secret-in-a-log-line` was written
     * as a folded YAML scalar and matched nothing at all while reading
     * perfectly correctly in review; this is that lesson, applied here.
     */
    const seen = walk(APP).filter((f) => PIN_INPUT.test(readFileSync(f, 'utf8')));
    expect(seen.length, 'the PIN detector matched no file at all').toBeGreaterThan(10);
  });
});
