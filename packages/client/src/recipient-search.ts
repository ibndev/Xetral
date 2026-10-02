/**
 * Whether a saved recipient matches what was typed in the search box.
 *
 * ONE COPY, FOR BOTH APPS — and the copy both had was wrong the same way. It
 * stripped the query to its digits and asked whether the destination
 * contained them, so a query with NO digits ("ola") became the empty string,
 * which every string contains: typing any name matched every recipient on
 * the list, and the search box filtered nothing.
 *
 * A number is matched on digits only when the query HAS digits; a name or a
 * network is matched on text.
 */
export function recipientMatches(
  recipient: { readonly display_name: string; readonly destination: string; readonly rail_name: string | null },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const digits = needle.replace(/[^0-9]/g, '');
  return (
    recipient.display_name.toLowerCase().includes(needle) ||
    (recipient.rail_name ?? '').toLowerCase().includes(needle) ||
    (digits !== '' && recipient.destination.includes(digits))
  );
}
