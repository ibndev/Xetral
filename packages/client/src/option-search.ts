/**
 * FILTERING A PICKER'S OPTIONS BY WHAT SOMEBODY TYPED — one definition for
 * both apps, so "Zenith" finds the same banks on a phone and in a browser.
 *
 * MATCHED ANYWHERE IN THE LABEL, RANKED BY WHERE. A customer looking for
 * "GTBank" in a list that calls it "Guaranty Trust Bank" is the case a prefix
 * match fails, so a match in the middle still counts. But a label that STARTS
 * with what was typed is almost always the one meant, so it comes first, then
 * a label with a WORD starting there, then the rest — each group keeping the
 * provider's own order. Ranked rather than merely filtered because a phone
 * keyboard covers half the sheet, and the row meant has to be in the half
 * that is left.
 *
 * Letters and digits only: "u and c" finds "U and C MFB" and "first bank"
 * finds "First Bank of Nigeria" whatever the punctuation either side.
 */
export interface SearchableOption {
  readonly label: string;
}

function fold(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function rankOptions<O extends SearchableOption>(
  options: readonly O[],
  query: string,
): readonly O[] {
  const needle = fold(query);
  if (needle === '') return options;

  const starts: O[] = [];
  const wordStarts: O[] = [];
  const contains: O[] = [];
  for (const option of options) {
    const label = fold(option.label);
    if (label.startsWith(needle)) starts.push(option);
    else if (label.includes(` ${needle}`)) wordStarts.push(option);
    else if (label.includes(needle) || label.replace(/ /g, '').includes(needle.replace(/ /g, '')))
      contains.push(option);
  }
  return [...starts, ...wordStarts, ...contains];
}

/**
 * A key for one rendered row that is unique even when two options share a
 * VALUE.
 *
 * Paystack's Nigerian bank list carries more than one entry under some codes,
 * and keyed on the code alone React reconciles two rows into one DOM node —
 * so typing in the filter left rows from the unfiltered list on screen beside
 * the right one ("Zenith" showing six microfinance banks above Zenith Bank).
 * The position settles a collision; the value keeps the key stable while the
 * list is not changing.
 */
export function optionKey(option: { readonly value: string }, index: number): string {
  return `${option.value}#${index}`;
}
