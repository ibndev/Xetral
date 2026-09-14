import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO LOWERCASE SVG TAG IN THIS APP, EVER.
 *
 * WHAT IT COST. `apps/mobile/src/currency-mark.tsx` drew the United States'
 * canton with `<rect>` where every sibling in the same block used `<Rect>`.
 * React Native looks a lowercase JSX tag up in its NATIVE VIEW REGISTRY,
 * finds nothing, and throws:
 *
 *     View config getting a callback for component 'rect' must be a function
 *     (received 'undefined')
 *
 * That unmounts the tree, and in a RELEASE build there is nothing above it —
 * so Android was left with a blank Activity and closed the app. The report
 * was "I click Send money and it exits and stops working", because the Send
 * flow's currency picker is where a USD mark renders.
 *
 * WHY NOTHING CAUGHT IT.
 *
 *   - The COMPILER allows any lowercase JSX name as an intrinsic element, so
 *     `<rect>` typechecks exactly as `<div>` would.
 *   - Every OTHER tag in that block is correctly capitalised, so the diff
 *     reads as consistent and a reviewer's eye slides over the one that is
 *     not.
 *   - The canton belongs to exactly ONE flag. Every screen worked until a USD
 *     mark rendered, which no unit test draws.
 *
 * That is three independent reasons a person cannot be the control here, which
 * is what makes it a test rather than a rule in a comment — the same argument
 * `select-coverage` makes about a native `<select>` and `light-edges` makes
 * about a border that only shows in one theme.
 *
 * IT SCANS FOR THE OPENING TAG, not for the import. An app that imports `Rect`
 * correctly and then writes `<rect>` once is exactly the failure, and the
 * import list says nothing about it.
 */

/** Every SVG element `react-native-svg` exports a capitalised component for. */
const SVG_TAGS = [
  'svg', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'tspan', 'textPath', 'g', 'use', 'symbol', 'defs', 'image',
  'clipPath', 'linearGradient', 'radialGradient', 'stop', 'mask', 'pattern',
  'marker', 'foreignObject',
] as const;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('SVG primitives are the components, never the DOM names', () => {
  const root = join(new URL('.', import.meta.url).pathname, '..');
  const files = [...sources(join(root, 'src')), ...sources(join(root, 'app'))];

  it('finds the app to scan', () => {
    // A scan that silently walks nothing passes forever — the failure this
    // whole file exists to prevent, one level up.
    expect(files.length).toBeGreaterThan(10);
  });

  it('has no lowercase SVG tag anywhere', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
        // Comments explain the fault by name, so they must not BE the fault.
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ');
      for (const tag of SVG_TAGS) {
        // `<rect` followed by whitespace, `/` or `>` — never `<Rect` and never
        // a longer name that merely starts with it.
        if (new RegExp(`<${tag}[\\s/>]`).test(source)) {
          offenders.push(`${file.slice(root.length + 1)}: <${tag}>`);
        }
      }
    }

    expect(
      offenders,
      'react-native-svg exports COMPONENTS; a lowercase tag is looked up in ' +
        'the native view registry, is not found, and closes the app in a ' +
        `release build. Capitalise these:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
