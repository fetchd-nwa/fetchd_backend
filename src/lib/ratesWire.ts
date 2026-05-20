import { locationKey, rateUnit, serviceCategory } from '../db/schema/schema.js';
import type { ServiceRateRow } from '../db/repositories/serviceRatesRepository.js';

type ServiceCategory = (typeof serviceCategory.enumValues)[number];
type LocationKey = (typeof locationKey.enumValues)[number];
type RateUnit = (typeof rateUnit.enumValues)[number];

/**
 * Wire shape for `GET /rates` (DATA-CONTRACT §B Rate Δ 2026-05-20). Lives
 * in `lib/` because the `note?` optional-omit + the `location: null` not-
 * omitted exception are real wire decisions, not a rename — extracting
 * them keeps the route file in pure dispatch shape (parse → repo →
 * respond) and centralizes the §B conventions a future reader/Day-18 FE
 * adapter can grep.
 *
 * Two §B conventions to remember:
 *   • `location` emits as `null` (not omitted) when the matched row has
 *     `service_rates.location IS NULL` — the documented Day-4a exception
 *     because `null` here is meaningful data ("applies to all
 *     locations"), not absence.
 *   • `note?` omits when null or empty string (Day-4a optional-omit
 *     default).
 */
export interface RateWire {
  category: ServiceCategory;
  location: LocationKey | null;
  amount_cents: number;
  unit: RateUnit;
  effective_from: string;
  note?: string;
}

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
