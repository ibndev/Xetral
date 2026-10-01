import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optionKey, rankOptions } from '@xetral/client';

/**
 * NO LINE INSIDE A TEXT FIELD, ON ANY SCREEN.
 *
 * Focus used to draw a 4px tinted halo outside the field's border. Every field
 * whose input sits inside a wrapper — the bank search, a dialling code, an
 * amount — had the halo land INSIDE the visible box, as a second rounded line
 * round the typed text. The product owner asked for that line gone everywhere,
 * so a focused field says so with its own border colour and nothing else.
 *
 * Checked over every rule whose selector names a field in a focus state, so a
 * new screen bringing its own ring fails here rather than in a screenshot.
 */
const CSS = readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', 'app', 'globals.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

function focusRules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of CSS.matchAll(re)) {
    const selector = (match[1] ?? '').trim();
    const body = match[2] ?? '';
    if (!/:focus/.test(selector)) continue;
    // A toggle is a checkbox, not a text field: its keyboard ring stays.
    if (/\.switch\b|checkbox|radio/.test(selector)) continue;
    // The product-wide ring for everything that is NOT a field names the
    // fields only to exclude them.
    if (/:not\(input, select, textarea\)/.test(selector)) continue;
    if (!/\b(input|textarea|select)\b|xselect-trigger|search-field|input-affix|sf-enter-figure/.test(selector)) {
      continue;
    }
    out.push({ selector, body });
  }
  return out;
}

describe('text field focus', () => {
  it('finds the rules it is checking', () => {
    expect(focusRules().length).toBeGreaterThan(10);
  });

  it('draws no halo and no outline round a focused field', () => {
    const offenders = focusRules().filter(
      ({ body }) =>
        /box-shadow\s*:\s*(?!none)[^;]*\b0 0 0 [1-9]/.test(body) ||
        /outline\s*:\s*(?!none)[1-9]/.test(body),
    );
    expect(offenders.map((o) => o.selector)).toEqual([]);
  });
});

describe('the picker search', () => {
  const banks = [
    { value: '090001', label: 'BANKIT MFB' },
    { value: '070009', label: 'Goodnews Microfinance Bank' },
    { value: '057', label: 'Zenith Bank' },
    { value: '057', label: 'Zenith Bank (Corporate)' },
    { value: '058', label: 'Guaranty Trust Bank' },
    { value: '50515', label: 'U and C MFB' },
  ];

  it('shows only what matches, best match first', () => {
    expect(rankOptions(banks, 'zenith').map((b) => b.label)).toEqual([
      'Zenith Bank',
      'Zenith Bank (Corporate)',
    ]);
    expect(rankOptions(banks, 'trust').map((b) => b.label)).toEqual(['Guaranty Trust Bank']);
    expect(rankOptions(banks, 'u and c').map((b) => b.label)).toEqual(['U and C MFB']);
    expect(rankOptions(banks, '  ')).toBe(banks);
  });

  it('keys every row uniquely even when two banks share a code', () => {
    const keys = banks.map((b, i) => optionKey(b, i));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
