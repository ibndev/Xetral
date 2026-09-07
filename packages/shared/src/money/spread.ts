/**
 * THE SPREAD THAT WIDENS WHEN THE PAYOUT CURRENCY STRENGTHENS.
 *
 * WHAT THIS IS FOR. `fx_spread_policies` holds a base margin an operator
 * published, and `fx_published_rates` holds the rate we quote at. Both are
 * append-only and neither moves on its own — so between the moment a rate is
 * published and the moment somebody republishes it, the market can move and
 * every quote in that gap is struck at yesterday's number. In one direction
 * that costs us nothing; in the other it is paid out of margin on every
 * transaction until a person notices.
 *
 * WHICH DIRECTION IS ADVERSE, AND WHY IT IS ONE RULE RATHER THAN TWO. The
 * exposure is always on the currency being PAID OUT — the "to" side. On
 * USD→NGN we hand over naira, so naira getting more expensive costs us; on
 * NGN→USD we hand over dollars, so dollars getting more expensive costs us.
 * Those are opposite statements about the naira, which is why this cannot be
 * a rule about any one currency.
 *
 * Stated in terms of the PUBLISHED RATE they collapse into a single test.
 * `quote_per_base` is how many units of the "to" currency one unit of "from"
 * buys, so the "to" currency strengthening means FEWER of them per unit —
 * the rate FALLS. Both examples above are that same fall. So: a rate below
 * the one we published is adverse, a rate above it is not, and no part of
 * this function needs to know which currencies it is looking at.
 *
 * THE OTHER DIRECTION DELIBERATELY DOES NOTHING. When the payout currency
 * weakens, the base spread already covers us and the quote is simply better
 * than it needed to be; narrowing automatically would be this code deciding
 * to charge a customer less than the price an operator published, which is a
 * pricing decision and belongs to a person.
 */

/** A rate as it is stored: a decimal string at a fixed six places. */
const RATE_PLACES = 6;

/**
 * A decimal rate string as an integer scaled by 10^6.
 *
 * NO FLOAT ANYWHERE, the rule the whole codebase follows for money. Rates are
 * written at a FIXED six places precisely so two of them are comparable as
 * text, and this turns that text into an integer without going through
 * `Number` — a rate near 0.000606 (dollars per naira) loses the digits that
 * matter the moment it becomes a double.
 */
export function scaledRate(rate: string): bigint {
  const trimmed = rate.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    throw new RangeError(`not a rate: ${rate}`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > RATE_PLACES) {
    // Truncating here would silently change a price. A rate arrives at six
    // places because that is how it is stored; more than that is a caller
    // that has not been through `fx_published_rates`.
    throw new RangeError(`a rate carries at most ${RATE_PLACES} decimal places: ${rate}`);
  }
  return BigInt(whole + fraction.padEnd(RATE_PLACES, '0'));
}

export interface SpreadPressure {
  /** What the customer is actually charged, in basis points. */
  readonly effectiveBasisPoints: number;
  /** What the operator published. Unchanged by anything here. */
  readonly baseBasisPoints: number;
  /** How far the payout currency has strengthened since the last publish,
   *  in basis points. Zero when it has weakened or not moved. */
  readonly adverseBasisPoints: number;
  /** True when the ceiling, rather than the move, decided the figure. */
  readonly capped: boolean;
}

/**
 * The spread to quote at, given what has happened since the last publish.
 *
 * ROUGHLY ONE FOR ONE with the adverse move — a payout currency 1% stronger
 * than when the rate was published adds 100 basis points on top of the base.
 * That is the point: the margin lost to the stale rate is the margin the
 * spread puts back, so a quote struck during the gap earns what the operator
 * priced it to earn rather than less.
 *
 * TWO CEILINGS, AND THE LOWER WINS. Double the base, so a corridor priced
 * thin stays comparatively thin and this can never quietly become the
 * dominant term; and a hard ceiling in basis points, so a genuine currency
 * crisis cannot produce a quote nobody would accept. During a spike the right
 * answer is an operator looking at it, not an ever-widening automatic price.
 *
 * ROUNDING IS DOWN, and it favours the CUSTOMER — the opposite direction from
 * tax, which rounds up so we can never under-remit, and stated here for the
 * same reason: every rounding choice moves money to somebody and the caller
 * should be able to see which way.
 */
export function widenedSpread(input: {
  /** The operator's published spread for this pair. */
  readonly baseBasisPoints: number;
  /** `quote_per_base` on the live published rate — the rate we quote at. */
  readonly publishedRate: string;
  /** The market now, from the reference feed. Absent means no observation,
   *  and then the base spread stands: a missing figure must never be read as
   *  a move in either direction. */
  readonly currentRate?: string | undefined;
  /** The hard ceiling, in basis points. */
  readonly ceilingBasisPoints: number;
}): SpreadPressure {
  const base = input.baseBasisPoints;
  const unmoved: SpreadPressure = {
    effectiveBasisPoints: base,
    baseBasisPoints: base,
    adverseBasisPoints: 0,
    capped: false,
  };

  if (input.currentRate === undefined) return unmoved;

  const published = scaledRate(input.publishedRate);
  const current = scaledRate(input.currentRate);
  // A published rate of zero is not a rate. Guarded rather than trusted,
  // because it is the divisor below.
  if (published <= 0n || current <= 0n) return unmoved;

  // ADVERSE IS THE RATE FALLING — see the header. A rise is the payout
  // currency weakening, and this deliberately does nothing there.
  if (current >= published) return unmoved;

  const adverse = Number(((published - current) * 10_000n) / published);
  if (adverse <= 0) return unmoved;

  /*
   * THE LOWER OF THE TWO CEILINGS, and `Math.min` over both rather than a
   * chain of ifs so neither can be forgotten. A base of zero is a real
   * published price — some corridors are quoted at cost — and doubling it is
   * still zero, which correctly means this mechanism cannot invent a margin
   * on a pair an operator priced at none.
   */
  const ceiling = Math.min(base * 2, input.ceilingBasisPoints);
  const wanted = base + adverse;
  const effective = Math.min(wanted, ceiling);

  return {
    effectiveBasisPoints: effective,
    baseBasisPoints: base,
    adverseBasisPoints: adverse,
    capped: effective < wanted,
  };
}
