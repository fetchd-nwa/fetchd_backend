/**
 * Board & Train flat-program-fee table (DATA-CONTRACT §C.1 Model 3).
 * Currently a single SKU at 2 weeks for $2,000 — per the locked DS.
 *
 * Server-side authority for the amount: no body carries a price. From 9.0.0 (plan unit
 * P49) the staff approve reads it, at 2 weeks, and stores it on the request
 * (`pending_requests.approved_price_cents`); the family's yes books the stay at that
 * stored price, and nothing is charged until the bill after the cue transfer session
 * (plan unit P51). A request whose `length_weeks` is not 2 is refused in words at the
 * approve, before this throws.
 *
 * A future tier (3-week, 4-week) lands as a new entry here + a §A
 * amendment. `service_rates` could absorb this eventually (unified
 * pricing surface), but the per-length-weeks shape is awkward to encode
 * there today — `service_rates.unit` is `per-day`/`per-night`/`per-session`,
 * not `per-program-weeks`. Defer the unification to whenever a third B&T
 * tier appears.
 */

/** Amount in USD cents, keyed on `pending_requests.length_weeks`. */
const BOARD_TRAIN_PRICE_CENTS: Readonly<Record<number, number>> = {
  2: 200_000, // $2,000 for the 2-week standard program
};

/** Throws on an unknown length — the route maps to a typed 422. */
export function boardTrainPriceCentsForLengthWeeks(lengthWeeks: number): number {
  const price = BOARD_TRAIN_PRICE_CENTS[lengthWeeks];
  if (price === undefined) {
    throw new Error(
      `boardTrainPriceCentsForLengthWeeks: no price configured for length_weeks=${lengthWeeks}`,
    );
  }
  return price;
}
