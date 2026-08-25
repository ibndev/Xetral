import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KILL_SWITCHES } from './settings.service.js';
import type { KillSwitch } from './settings.service.js';

/**
 * Every kill switch is asserted somewhere.
 *
 * THE FAILURE THIS EXISTS FOR. `crypto_enabled` and `fx_enabled` were rows in
 * `platform_settings`, appeared in the admin dashboard with their descriptions,
 * and had accessors on `SettingsService` — and **not one line of code read
 * them**. An operator could switch crypto off during a provider incident, watch
 * the dashboard confirm the change, and withdrawals would keep going out.
 *
 * That is worse than having no switch at all, because it is trusted at exactly
 * the moment it matters and the failure is invisible: the setting saves, the
 * history records the change, and nothing else happens.
 *
 * Nothing in the type system can catch it — an unused accessor is just an
 * unused accessor. This scans for the call site instead.
 */

const SRC = join(new URL('.', import.meta.url).pathname, '..');

function walk(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** Every `assertServiceEnabled('x')` in the application, and the file it is in. */
function assertionsBySwitch(): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, string[]>();

  for (const file of walk(SRC)) {
    // The settings service itself defines the mechanism; a call there would be
    // the registry, not an enforcement point.
    if (file.endsWith('settings.service.ts')) continue;

    for (const match of readFileSync(file, 'utf8').matchAll(
      /assertServiceEnabled\(\s*'([a-z_]+)'\s*\)/g,
    )) {
      const name = match[1] as string;
      const at = found.get(name) ?? [];
      at.push(file.slice(SRC.length + 1));
      found.set(name, at);
    }
  }

  return found;
}

describe('kill switches', () => {
  it('every declared switch is asserted by at least one service', () => {
    const asserted = assertionsBySwitch();
    const dead = (Object.keys(KILL_SWITCHES) as KillSwitch[])
      .filter((name) => !asserted.has(name))
      .sort();

    expect(
      dead,
      'these switches can be turned off in the dashboard and nothing will ' +
        `happen: ${dead.join(', ')}`,
    ).toEqual([]);
  });

  it('asserts only switches that exist', () => {
    // The other direction. A typo — `assertServiceEnabled('card')` for
    // `cards` — would be a check that never fires, which looks identical to a
    // check that passes. TypeScript catches this today because the parameter
    // is a union; this catches it if the parameter is ever widened to a string.
    const unknown = [...assertionsBySwitch().keys()]
      .filter((name) => !(name in KILL_SWITCHES))
      .sort();
    expect(unknown).toEqual([]);
  });

  it('finds the assertions it is meant to be checking', () => {
    // A scanner whose regex stopped matching would report every switch as
    // dead — loud, and therefore fine — but one that matched nothing while the
    // first test somehow passed would be silent. Pin the floor.
    const total = [...assertionsBySwitch().values()].reduce((n, at) => n + at.length, 0);
    expect(total).toBeGreaterThanOrEqual(Object.keys(KILL_SWITCHES).length);
  });

  it('does not gate the webhook path', () => {
    // A switched-off service must still RECORD money that already moved. A
    // Bitnob authorization webhook arrives after the network has approved the
    // charge; refusing to post it because cards are paused would drop a real
    // spend from the books and leave the customer's balance wrong for ever.
    //
    // Switching a service off stops new commitments. It never stops the ledger
    // hearing about what already happened.
    const webhookFiles = walk(SRC).filter((f) => /webhook/i.test(f));
    expect(webhookFiles.length).toBeGreaterThan(0);
    for (const file of webhookFiles) {
      expect(readFileSync(file, 'utf8'), `${file} must not gate on a kill switch`).not.toContain(
        'assertServiceEnabled',
      );
    }
  });
});
