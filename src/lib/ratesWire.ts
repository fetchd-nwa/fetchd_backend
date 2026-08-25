import type { RateWire } from '../contracts/wire.js';
import type { ServiceRateRow } from '../db/repositories/serviceRatesRepository.js';

/**
 * Wire 1.13.0 (§6): `RateWire` is contract-owned now — declared in
 * `contracts/wire.ts` and re-exported here so no consumer moves
 * (the `ChargeStatus`/`chargesRepository` and `BookingMode` precedent).
 * The two §B conventions that used to be documented here — `location`
 * emitting as `null` rather than omitted, and `note?` omitting on NULL or
 * empty string — travelled with the declaration into its wire doc comment.
 *
 * What stays in `lib/` is the mapper: `toRateWire` is where the `note?`
 * omit is actually ENFORCED, which is why the route file can stay in pure
 * dispatch shape (parse → repo → respond).
 */
export type { RateWire };

export function toRateWire(row: ServiceRateRow): RateWire {
  const wire: RateWire = {
    category: row.category,
    location: row.location,
    amount_cents: row.amount_cents,
    unit: row.unit,
    effective_from: row.effective_from,
  };
  if (row.note !== null && row.note !== '') {
    wire.note = row.note;
  }
  return wire;
}
