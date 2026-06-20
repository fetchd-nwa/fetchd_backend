import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
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

/**
 * The staff-config view of a rate row — carries `id` + `effective_to` (which
 * the owner-facing `ServiceRateRow` omits) so the portal can show a track's
 * current window and any scheduled future change, and edit by identity.
 */
export interface StaffServiceRateRow {
  id: string;
  category: ServiceCategory;
  location: LocationKey | null;
  amount_cents: number;
  unit: RateUnit;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}

const STAFF_RATE_PROJECTION = {
  id: serviceRates.id,
  category: serviceRates.category,
  location: serviceRates.location,
  amount_cents: serviceRates.amountCents,
  unit: serviceRates.unit,
  effective_from: serviceRates.effectiveFrom,
  effective_to: serviceRates.effectiveTo,
  note: serviceRates.note,
} as const;

/**
 * Outcome of an effective-dated supersede:
 *   - `applied`  — the write landed; `outcome` tells how (see below).
 *   - `conflict` — a rate is already scheduled to start AFTER the requested
 *     `effective_from`; back-filling before it would overlap, so the route
 *     surfaces a 409 and the staffer picks a later date (or edits that row).
 */
export type SupersedeRateResult =
  | {
      kind: 'applied';
      /**
       * `inserted`   — first rate for this (category, location) track.
       * `superseded` — closed the prior open row at `effective_from`, inserted new.
       * `updated`    — corrected the open row in place (same `effective_from`).
       */
      outcome: 'inserted' | 'superseded' | 'updated';
      row: StaffServiceRateRow;
    }
  | { kind: 'conflict'; scheduledFrom: string };

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

  /**
   * Staff-config list: every rate row that is currently active OR scheduled for
   * the future at `today` (i.e. not yet expired — `effective_to IS NULL OR
   * effective_to > today`). Expired history is excluded; the portal shows the
   * live catalog + any pending change per track. Ordered category → location
   * (nulls last) → effective_from so a track's current row precedes its
   * scheduled successor.
   */
  async findActiveAndScheduledForStaff(
    today: string,
    runner: Runner = db,
  ): Promise<StaffServiceRateRow[]> {
    return runner
      .select(STAFF_RATE_PROJECTION)
      .from(serviceRates)
      .where(or(isNull(serviceRates.effectiveTo), gt(serviceRates.effectiveTo, today)))
      .orderBy(
        asc(serviceRates.category),
        sql`${serviceRates.location} NULLS LAST`,
        asc(serviceRates.effectiveFrom),
      );
  },

  /**
   * Effective-dated supersede for one (category, location) track — the staff
   * rate editor's write. Must run inside the `withServiceRateLock` advisory lock
   * so two concurrent edits to the same track serialize (otherwise both could
   * see "no open row" and leave two open rows, breaking non-overlap).
   *
   * Semantics, given the current open row (the one with `effective_to IS NULL`;
   * the lock + non-overlap invariant guarantee there's at most one):
   *   - none                         → INSERT the new row [effective_from, ∞).
   *   - open.from === effective_from → UPDATE it in place (same-day correction;
   *                                    already-stamped invoices keep their
   *                                    as-charged amount, so this is safe).
   *   - open.from <  effective_from  → close it (`effective_to = effective_from`)
   *                                    + INSERT the new row [effective_from, ∞).
   *   - open.from >  effective_from  → `conflict` (a later rate is already
   *                                    scheduled; can't back-fill before it).
   *
   * `effective_from` (and `today`) are Chicago-bucketed YYYY-MM-DD; the route
   * enforces `effective_from >= today` (no back-dating past as-charged history).
   */
  async supersedeRate(
    tx: Tx,
    args: {
      category: ServiceCategory;
      location: LocationKey;
      amountCents: number;
      unit: RateUnit;
      effectiveFrom: string;
      note: string | null;
    },
  ): Promise<SupersedeRateResult> {
    const [open] = await tx
      .select(STAFF_RATE_PROJECTION)
      .from(serviceRates)
      .where(
        and(
          eq(serviceRates.category, args.category),
          eq(serviceRates.location, args.location),
          isNull(serviceRates.effectiveTo),
        ),
      )
      .orderBy(desc(serviceRates.effectiveFrom))
      .limit(1);

    if (open !== undefined && open.effective_from > args.effectiveFrom) {
      return { kind: 'conflict', scheduledFrom: open.effective_from };
    }

    // Same-day correction: rewrite the open row in place rather than stacking a
    // zero-width [from, from) window (which the `effective_to > effective_from`
    // CHECK would reject anyway).
    if (open !== undefined && open.effective_from === args.effectiveFrom) {
      const [row] = await tx
        .update(serviceRates)
        .set({ amountCents: args.amountCents, unit: args.unit, note: args.note })
        .where(eq(serviceRates.id, open.id))
        .returning(STAFF_RATE_PROJECTION);
      if (!row) throw new Error('supersedeRate: in-place UPDATE returned no row');
      return { kind: 'applied', outcome: 'updated', row };
    }

    // Supersede: close the prior open window at the new start date.
    if (open !== undefined) {
      await tx
        .update(serviceRates)
        .set({ effectiveTo: args.effectiveFrom })
        .where(eq(serviceRates.id, open.id));
    }

    const [row] = await tx
      .insert(serviceRates)
      .values({
        category: args.category,
        location: args.location,
        amountCents: args.amountCents,
        unit: args.unit,
        effectiveFrom: args.effectiveFrom,
        effectiveTo: null,
        note: args.note,
      })
      .returning(STAFF_RATE_PROJECTION);
    if (!row) throw new Error('supersedeRate: INSERT returned no row');
    return { kind: 'applied', outcome: open === undefined ? 'inserted' : 'superseded', row };
  },
};
