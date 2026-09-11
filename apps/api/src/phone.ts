/**
 * ONE DEFINITION OF "THIS NUMBER, IN INTERNATIONAL FORM".
 *
 * A phone number is written three ways by the same person in one afternoon —
 * `0501234567`, `+233501234567`, `233 50 123 4567` — and every one of them is
 * the same wallet. Three places in this API needed to agree about that and
 * only two of them did: registration and `MomoService` both stripped the trunk
 * zero and prefixed the country's dialling code, while a MOBILE MONEY PAYOUT
 * sent whatever the customer typed straight to Flutterwave, who have no idea
 * what a Ghanaian trunk zero is. `0501234567` is not a number their transfers
 * API can reach, so every cedi payout was refused at the rail.
 *
 * That is the two-definitions-of-one-question shape this codebase keeps
 * recording — the two recipient resolvers, the two beneficiary lookups — so
 * this is the one definition, and both callers are built on it.
 *
 * TWO SPELLINGS, DELIBERATELY, and the difference is one character:
 *
 *   `e164`               `+233501234567`   how a number is STORED and shown
 *   `internationalDigits`  `233501234567`  what a payout rail takes on the wire
 *
 * `bank_payouts.account_number` is CHECKed `^[0-9]{6,20}$` and Flutterwave's
 * `account_number` on a mobile money transfer is digits, so a leading `+`
 * there is refused by our own schema before it can be refused by theirs.
 * Neither form is a preference; each is what its destination accepts.
 */

/**
 * The country's dialling code and the national digits, with the trunk zero
 * stripped — digits only, no `+`.
 *
 * Returns undefined rather than guessing when it cannot build one. A number
 * this cannot normalise must be REFUSED, never sent as typed: a payout is the
 * direction that cannot be recalled, and "we sent it to whatever you wrote" is
 * not a recovery story.
 */
export function internationalDigits(dialCode: string, national: string): string | undefined {
  /*
   * ALREADY INTERNATIONAL IS LEFT ALONE, and that is why the code is compared
   * rather than blindly prefixed. A customer who types `+233501234567`, or
   * pastes one out of a message, would otherwise get `233233501234567` — a
   * number that belongs to nobody, in the direction money leaves.
   */
  const code = dialCode.replace(/[^0-9]/g, '');
  if (code === '') return undefined;

  const raw = national.trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits === '') return undefined;

  /*
   * A LEADING `+` MAKES IT UNAMBIGUOUS; without one it is a judgement.
   *
   * `233501234567` is plainly international. `0501234567` is plainly national.
   * The awkward case is a national number that HAPPENS to start with the
   * dialling code's digits, and the trunk zero is what tells them apart: a
   * number written nationally starts with it, and one written internationally
   * does not.
   */
  const international =
    raw.startsWith('+') || (digits.startsWith(code) && !digits.startsWith('0'))
      ? digits
      : `${code}${digits.replace(/^0+/, '')}`;

  /*
   * E.164 CAPS A SUBSCRIBER NUMBER AT FIFTEEN DIGITS. The floor is eight
   * because a dialling code plus fewer digits than that is not a mobile number
   * anywhere this platform operates, and a short string here is somebody
   * halfway through typing.
   */
  if (international.length < 8 || international.length > 15) return undefined;
  return international;
}

/** The same number with the `+` that makes it E.164 — how one is STORED. */
export function e164(dialCode: string, national: string): string | undefined {
  const digits = internationalDigits(dialCode, national);
  return digits === undefined ? undefined : `+${digits}`;
}
