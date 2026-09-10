/**
 * READING WHATEVER A CUSTOMER PASTED INTO A PAY-SOMEBODY FIELD.
 *
 * Lifted out of `wallet.service.ts` unchanged so `RecipientService` can share
 * it: the resolver moved, and a helper reachable from only one of two callers
 * is how the two came to answer differently in the first place.
 */
/**
 * The handle inside whatever was pasted, or undefined if this is not one.
 *
 * Deliberately permissive about the WRAPPER and strict about the handle. A
 * customer copying a payment link gets whatever their app decided to include —
 * a scheme or not, a trailing slash, a query string a share sheet appended —
 * and none of that is their mistake to fix. What is not permissive is the
 * handle itself: it must match the same shape the database enforces, so a
 * malformed one is a clean "no such recipient" rather than a query.
 */
export function handleIn(raw: string): string | undefined {
  let value = raw.trim();
  if (value === '' || value.includes('@') === false && value.startsWith('http') === false
      && !/^[a-z0-9_]+$/i.test(value)) {
    return undefined;
  }

  // A URL, in any of the forms a share sheet produces.
  const asUrl = value.match(/^(?:https?:\/\/)?[^\s/]+\/pay\/([^/?#\s]+)/i);
  if (asUrl !== null) {
    value = asUrl[1] ?? '';
  } else if (value.startsWith('@')) {
    value = value.slice(1);
  } else if (value.includes('@') || value.startsWith('http')) {
    // An email address, or a URL that is not a payment link. Neither is a
    // handle, and guessing at one would turn a mistyped address into a
    // transfer to somebody else entirely.
    return undefined;
  }

  const handle = value.toLowerCase();
  // ALL DIGITS IS A PHONE NUMBER, NOT A HANDLE, and the handle pattern accepts
  // one — `2348031234567` matches it exactly. Without this, every link this
  // product now generates would be looked up in `payable_handles`, miss, and
  // answer "no such recipient" for a customer whose number is right there in
  // the link.
  if (/^[0-9]+$/.test(handle)) return undefined;
  return /^[a-z0-9](?:[a-z0-9_]{1,18})[a-z0-9]$/.test(handle) ? handle : undefined;
}

/**
 * Whatever was pasted, with a payment link unwrapped to the thing it names.
 *
 * THREE GENERATIONS OF LINK RESOLVE THROUGH HERE, and that is the whole
 * reason it exists rather than being one regex at the call site. A link is
 * forwarded and cannot be recalled, so every shape this product has ever
 * printed on a screen goes on working:
 *
 *   /pay/<slug>              the checkout, and what is generated today
 *   /pay/<digits>            the phone number, generated for one release
 *   /pay/<handle>            the `@handle`, retired with 039's identifier
 *
 * The digits get their `+` back, because the link deliberately dropped it — a
 * plus in a URL is a space to half the software that will touch it — and that
 * is what makes the unwrapped value an E.164 number again.
 *
 * Anything that is not a payment link is returned UNCHANGED — an email, a bare
 * number, an `@handle` typed by hand — because this function's only job is the
 * wrapper.
 */
export function payLinkTarget(raw: string): string {
  const value = raw.trim();
  const asUrl = value.match(/^(?:https?:\/\/)?[^\s/]+\/pay\/([^/?#\s]+)/i);
  const segment = asUrl?.[1];
  if (segment === undefined) return value;
  return /^[0-9]{7,15}$/.test(segment) ? `+${segment}` : segment;
}
