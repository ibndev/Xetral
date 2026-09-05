/**
 * WHAT A CURRENCY IS WORTH, ACCORDING TO SOMEBODY ELSE.
 *
 * NOT `FxPort`, and the difference is the whole reason this is a separate
 * port. `FxPort` quotes a price we can DEAL at and then executes the swap:
 * Bitnob answers "you may buy $100 for ₦165,000" and then does it. A
 * reference feed answers "the market says a dollar is 1,650 naira" and can do
 * nothing at all — there is no counterparty, no float and no settlement.
 *
 * That distinction is what makes this safe to use for the corridors it exists
 * for. Nobody quotes NGN→GHS, so 053 lets Xetral publish its own rate and
 * BE the counterparty, settling out of its own float in both currencies. What
 * was missing was any way to keep that number current, and a rate somebody has
 * to retype every day is a rate that is usually wrong.
 *
 * A RATE HERE IS A DECIMAL STRING, never a number, for the reason `fromMajor`
 * takes one: by the time a decimal is a JS number the precision question has
 * already been answered for you. The adapter is the one place a provider's
 * JSON number becomes text, and it says what it does about the digits it
 * cannot keep.
 *
 * IT IS NOT MONEY AND NEVER BECOMES MONEY HERE. The ratio of integers that
 * actually converts an amount is built from this string by
 * `PublishedRateService.ratioFor`, scaled by each currency's own exponent, and
 * that path has no float in it anywhere.
 */
export interface ReferenceRatePort {
  readonly provider: string;

  /**
   * Every rate this feed knows for one base currency.
   *
   * ONE CALL PER BASE, not one per pair, because that is how these feeds are
   * priced: the free tiers meter REQUESTS, and asking fifty-six times for
   * what eight calls answer is how a quota is exhausted by lunchtime.
   *
   * Keyed by ISO 4217 code, valued as a decimal string of quote units per one
   * base unit — `{ NGN: '1650.123456' }` for a base of USD. Currencies this
   * platform does not know are included: filtering is the caller's job,
   * because the caller is the one that knows which pairs it wants.
   */
  latest(base: string): Promise<ReferenceRates>;
}

export interface ReferenceRates {
  readonly base: string;
  /** Quote units per one base unit, as decimal strings. */
  readonly rates: ReadonlyMap<string, string>;
  /** When the feed says it last updated, if it says. Used to notice a feed
   *  that is answering and no longer moving. */
  readonly asOf?: Date;
}
