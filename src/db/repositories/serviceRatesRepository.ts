import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { rateUnit, serviceCategory, serviceRates, type LocationKey } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for stand-alone reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

type ServiceCategory = (typeof serviceCategory.enumValues)[number];
type RateUnit = (typeof rateUnit.enumValues)[number];

/**
 * Effective-dated price catalog read (schema.sql:816-829 + DATA-CONTRACT §B
 * Rate Δ 2026-05-20). Each (category, location) tracks a sequence of rows
 * with non-overlapping `[effective_from, effective_to)` windows (`effective_to
 * NULL` = open-ended current); raising the price is "close the current row's
 * `effective_to` and insert a new one" — never edit, so historical bookings
 * keep their as-charged rate.
 *
 * Precedence: a row whose `location` matches the query beats a row with
 * `location IS NULL` (applies-to-all). Encoded via `ORDER BY location NULLS
 * LAST, effective_from DESC LIMIT 1` — the specific row wins; ties (both
 * specific or both null) break to the most-recent effective_from, which the
 * non-overlap invariant means is the only live window anyway.
 */
export interface ServiceRateRow {
  category: ServiceCategory;
  location: LocationKey | null;
  amount_cents: number;
  unit: RateUnit;
  effective_from: string;
  note: string | null;
}

export const serviceRatesRepository = {
  /**
   * The single active rate for (`category`, `location`) at `today`.
   * `today` is the Chicago-bucketed YYYY-MM-DD string the route computes
   * via `bucketToChicagoDate(nowFactory())` — never raw UTC, per the
   * cross-cutting timezone invariant.
   *
   * Returns `undefined` when no row matches (route maps to 404).
   *
   * Polymorphic runner: the `/rates` route reads against the pool (default),
   * the PAYG booking branch passes its mutation `tx` so the rate read shares
   * the booking transaction.
   */
  async findActiveRate(
    category: ServiceCategory,
    location: LocationKey,
    today: string,
    runner: Runner = db,
  ): Promise<ServiceRateRow | undefined> {
    const rows = await runner
      .select({
        category: serviceRates.category,
        location: serviceRates.location,
        amount_cents: serviceRates.amountCents,
        unit: serviceRates.unit,
        effective_from: serviceRates.effectiveFrom,
        note: serviceRates.note,
      })
      .from(serviceRates)
      .where(
        and(
          eq(serviceRates.category, category),
          or(eq(serviceRates.location, location), isNull(serviceRates.location)),
          lte(serviceRates.effectiveFrom, today),
          or(isNull(serviceRates.effectiveTo), gt(serviceRates.effectiveTo, today)),
        ),
      )
      .orderBy(sql`${serviceRates.location} NULLS LAST`, desc(serviceRates.effectiveFrom))
      .limit(1);
    return rows[0];
  },
};
