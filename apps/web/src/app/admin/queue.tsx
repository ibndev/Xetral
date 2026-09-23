import type { ReactNode } from 'react';
import { compactMinor } from '@xetral/client';

/**
 * The pieces every queue screen in the comp is built from: a row of three
 * figures, and a table whose chosen row opens a decision underneath it.
 *
 * SHARED because the comp draws one shape ten times. Written per screen, the
 * tenth copy is the one with the 16px gap and the unguarded tone, and the
 * consistency the comp is FOR goes the way the three contract suites went.
 */

export interface Kpi {
  readonly label: string;
  /**
   * A count, which is also what decides the tone. Undefined while loading or
   * refused: a dash, never a zero nobody counted.
   */
  readonly count?: number | undefined;
  /** Anything that is not a plain count — money, a percentage. */
  readonly value?: ReactNode | undefined;
  /**
   * The comp colours an open queue amber and a breach red. Applied only to a
   * figure above zero: a red "0" under "High value" reads as an alarm about
   * nothing, which is how an alarm stops being read.
   */
  readonly tone?: 'warn' | 'danger' | 'ok' | undefined;
}

export function Kpis({ items }: { readonly items: readonly Kpi[] }) {
  return (
    <div className={items.length === 4 ? 'stats four' : 'stats three'}>
      {items.map((item) => {
        const shown = item.value ?? item.count;
        const toned = item.tone !== undefined && item.count !== undefined && item.count > 0;
        return (
          <div className="stat" key={item.label}>
            <div className="label">{item.label}</div>
            <div className={toned ? `value ${item.tone}` : 'value'}>{shown ?? '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Money for a tile, per currency.
 *
 * Totals are NEVER added across currencies — kobo and cedis are both integers
 * and the sum of them is nothing. So the first currency is the figure and the
 * rest sit underneath it, each in its own unit.
 */
export function MoneyFigure({
  totals,
}: {
  readonly totals: readonly { readonly currency: string; readonly amount_minor: string }[];
}) {
  if (totals.length === 0) return <>0</>;
  const [first, ...rest] = totals;
  if (first === undefined) return <>0</>;
  const head = compactMinor(first.amount_minor, first.currency);
  return (
    <>
      {head.figure}
      {head.unit !== '' && <span className="unit">{head.unit}</span>}
      {rest.length > 0 && (
        <span className="more">
          {rest
            .map((t) => {
              const c = compactMinor(t.amount_minor, t.currency);
              return `${c.figure}${c.unit}`;
            })
            .join(' · ')}
        </span>
      )}
    </>
  );
}

/**
 * A reference a person can read aloud: the comp's "DP-881".
 *
 * Derived from the uuid rather than stored, so it cannot drift from the row it
 * names; six hex characters is sixteen million values, which is plenty for
 * telling two rows on one screen apart and is not offered as a search key.
 */
export function shortRef(prefix: string, uuid: string): string {
  return `${prefix}-${uuid.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}
