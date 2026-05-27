/**
 * Board & Train flat-program-fee table (DATA-CONTRACT §C.1 Model 3).
 * Currently a single SKU at 2 weeks for $2,000 — per the locked DS.
 *
 * Server-side authority for the amount so the FE can't underpay by
 * passing a lower `amount_cents`. The confirm-payment route reads from
 * here, not the request body.
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
