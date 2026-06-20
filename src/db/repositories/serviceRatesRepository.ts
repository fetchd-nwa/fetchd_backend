import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { rateUnit, serviceCategory, serviceRates, type LocationKey } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for stand-alone reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

type ServiceCategory = (typeof serviceCategory.enumValues)[number];
type RateUnit = (typeof rateUnit.enumValues)[number];

/**
 * Effective-dated price catalog (schema.sql `service_rates` + DATA-CONTRACT §B
 * Rate Δ 2026-05-20, append-only Δ 2026-06-20). Each (category, location) is a
 * sequence of non-overlapping `[effective_from, effective_to)` windows
 * (`effective_to NULL` = open-ended current). The table is **append-only**:
 * a price change closes the open row's `effective_to` and inserts a new row; a
 * mistake/cancellation sets `voided_at` (a soft-void excluded from "active").
 * `amount_cents`/`unit`/`note` are NEVER UPDATEd after insert — history holds, a
 * past booking's as-charged rate (and a locked PAYG invoice) survive any change.
 *
 * Precedence (active lookup): a `location`-specific row beats a `location IS
 * NULL` (applies-to-all) row — `ORDER BY location NULLS LAST, effective_from
 * DESC LIMIT 1`.
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
 * The staff-config view — carries `id` + `effective_to` + `created_by_staff_id`
 * (which the owner-facing `ServiceRateRow` omits) so the portal can show a
 * track's current window, any scheduled change, who set it, and edit by id.
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
  created_by_staff_id: string | null;
}

/**
 * The full change-history view of a row — adds the creation timestamp + the
 * void columns so the portal's per-track log can render who/when/status for
 * every entry (current / scheduled / expired / voided).
 */
export interface StaffRateHistoryRow extends StaffServiceRateRow {
  created_at: string;
  voided_at: string | null;
  voided_by_staff_id: string | null;
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
  created_by_staff_id: serviceRates.createdByStaffId,
} as const;

const HISTORY_PROJECTION = {
  ...STAFF_RATE_PROJECTION,
  created_at: serviceRates.createdAt,
  voided_at: serviceRates.voidedAt,
  voided_by_staff_id: serviceRates.voidedByStaffId,
} as const;

/** Window-analysis projection for the supersede (just the dates + id). */
const WINDOW_PROJECTION = {
  id: serviceRates.id,
  effective_from: serviceRates.effectiveFrom,
  effective_to: serviceRates.effectiveTo,
} as const;

export interface SupersedeRateResult {
  /**
   * `inserted`   — first (or only) rate for this track at `effective_from`.
   * `superseded` — closed the spanning predecessor at `effective_from`.
   * `replaced`   — same-day re-edit: voided the row starting that day (no
   *                in-place overwrite), inserted the replacement.
   */
  outcome: 'inserted' | 'superseded' | 'replaced';
  row: StaffServiceRateRow;
}

export const serviceRatesRepository = {
  /**
   * The single active rate for (`category`, `location`) at `today` (Chicago
   * YYYY-MM-DD). Excludes voided rows. Returns `undefined` when none matches
   * (route maps to 404). Polymorphic runner so the PAYG booking branch can read
   * inside its mutation tx.
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
          isNull(serviceRates.voidedAt),
          lte(serviceRates.effectiveFrom, today),
          or(isNull(serviceRates.effectiveTo), gt(serviceRates.effectiveTo, today)),
        ),
      )
      .orderBy(sql`${serviceRates.location} NULLS LAST`, desc(serviceRates.effectiveFrom))
      .limit(1);
    return rows[0];
  },

  /**
   * Staff-config catalog: every non-voided row active OR scheduled at `today`
   * (`effective_to IS NULL OR effective_to > today`; expired + voided excluded).
   * Ordered category → location (nulls last) → effective_from so a track's
   * current row precedes its scheduled successor.
   */
  async findActiveAndScheduledForStaff(
    today: string,
    runner: Runner = db,
  ): Promise<StaffServiceRateRow[]> {
    return runner
      .select(STAFF_RATE_PROJECTION)
      .from(serviceRates)
      .where(
        and(
          isNull(serviceRates.voidedAt),
          or(isNull(serviceRates.effectiveTo), gt(serviceRates.effectiveTo, today)),
        ),
      )
      .orderBy(
        asc(serviceRates.category),
        sql`${serviceRates.location} NULLS LAST`,
        asc(serviceRates.effectiveFrom),
      );
  },

  /**
   * The full change history for one (category, location) track — every row,
   * including expired + voided, newest first (by created_at). The append-only
   * rows ARE the change log; `audit_log` additionally captures the before-state
   * + actor on each `effective_to` close / void.
   */
  async findHistoryForTrack(
    category: ServiceCategory,
    location: LocationKey,
    runner: Runner = db,
  ): Promise<StaffRateHistoryRow[]> {
    return runner
      .select(HISTORY_PROJECTION)
      .from(serviceRates)
      .where(and(eq(serviceRates.category, category), eq(serviceRates.location, location)))
      .orderBy(desc(serviceRates.createdAt));
  },

  /**
   * Effective-dated supersede — the rate editor's write. MUST run inside the
   * `withServiceRateLock` advisory lock so concurrent edits to the same track
   * serialize. Append-only: never overwrites `amount_cents`/`unit`/`note`.
   *
   * Given `F = effectiveFrom` and the track's non-voided windows:
   *   - a row starting exactly at F (`sameDay`) → **void it** + insert the new
   *     row (same-day correction with no overwrite).
   *   - else the predecessor spanning F (`prev`: from < F, open or ending > F)
   *     → close it at F.
   *   - the new row ends at the soonest scheduled successor's start (`next`) or
   *     stays open — so a future scheduled rate is never blocked; the new window
   *     slots in before it. There is no conflict/reject path.
   *
   * The route enforces `F >= today` (no back-dating past as-charged history).
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
      createdByStaffId: string;
    },
  ): Promise<SupersedeRateResult> {
    const F = args.effectiveFrom;
    const windows = await tx
      .select(WINDOW_PROJECTION)
      .from(serviceRates)
      .where(
        and(
          eq(serviceRates.category, args.category),
          eq(serviceRates.location, args.location),
          isNull(serviceRates.voidedAt),
        ),
      );

    // YYYY-MM-DD strings compare lexicographically = chronologically.
    const sameDay = windows.find((w) => w.effective_from === F);
    const prev = windows.find(
      (w) => w.effective_from < F && (w.effective_to === null || w.effective_to > F),
    );
    const laterStarts = windows.filter((w) => w.effective_from > F).map((w) => w.effective_from);
    const newEffectiveTo = laterStarts.length > 0 ? laterStarts.sort()[0]! : null;

    let outcome: SupersedeRateResult['outcome'];
    if (sameDay !== undefined) {
      // Same-date replacement: void the prior entry (append-only, no overwrite).
      await tx
        .update(serviceRates)
        .set({ voidedAt: sql`now()`, voidedByStaffId: args.createdByStaffId })
        .where(eq(serviceRates.id, sameDay.id));
      outcome = 'replaced';
    } else if (prev !== undefined) {
      // Close the spanning predecessor at the new start.
      await tx.update(serviceRates).set({ effectiveTo: F }).where(eq(serviceRates.id, prev.id));
      outcome = 'superseded';
    } else {
      outcome = 'inserted';
    }

    const [row] = await tx
      .insert(serviceRates)
      .values({
        category: args.category,
        location: args.location,
        amountCents: args.amountCents,
        unit: args.unit,
        effectiveFrom: F,
        effectiveTo: newEffectiveTo,
        note: args.note,
        createdByStaffId: args.createdByStaffId,
      })
      .returning(STAFF_RATE_PROJECTION);
    if (!row) throw new Error('supersedeRate: INSERT returned no row');
    return { outcome, row };
  },

  /**
   * The (immutable) track of a rate row by id — `{ category, location }`, any
   * state. The void route reads this to pick the advisory-lock key before
   * locking; returns `undefined` if the id doesn't exist.
   */
  async findTrackById(
    id: string,
    runner: Runner = db,
  ): Promise<{ category: ServiceCategory; location: LocationKey | null } | undefined> {
    const [row] = await runner
      .select({ category: serviceRates.category, location: serviceRates.location })
      .from(serviceRates)
      .where(eq(serviceRates.id, id))
      .limit(1);
    return row;
  },

  /**
   * Soft-void one rate entry by id — the delete / cancel-scheduled verb. MUST
   * run inside `withServiceRateLock` for the row's track. No-trap guarantee:
   * voiding **reopens the predecessor** (the non-voided row that ended at this
   * row's `effective_from`) to its own `effective_to`, so cancelling a scheduled
   * change leaves no pricing gap. Voiding the only/first row leaves the track
   * unset (the legitimate "no rate" state). Returns `undefined` if the id
   * doesn't exist or is already voided (route → 404).
   */
  async voidRate(
    tx: Tx,
    args: { id: string; voidedByStaffId: string },
  ): Promise<StaffServiceRateRow | undefined> {
    const [target] = await tx
      .select(STAFF_RATE_PROJECTION)
      .from(serviceRates)
      .where(and(eq(serviceRates.id, args.id), isNull(serviceRates.voidedAt)))
      .limit(1);
    if (target === undefined) return undefined;

    if (target.location !== null) {
      const [pred] = await tx
        .select({ id: serviceRates.id })
        .from(serviceRates)
        .where(
          and(
            eq(serviceRates.category, target.category),
            eq(serviceRates.location, target.location),
            isNull(serviceRates.voidedAt),
            eq(serviceRates.effectiveTo, target.effective_from),
          ),
        )
        .limit(1);
      if (pred !== undefined) {
        // Reopen the predecessor to span the voided window (NULL = open-ended,
        // or the voided row's own successor). effective_to is window management,
        // not a value overwrite.
        await tx
          .update(serviceRates)
          .set({ effectiveTo: target.effective_to })
          .where(eq(serviceRates.id, pred.id));
      }
    }

    await tx
      .update(serviceRates)
      .set({ voidedAt: sql`now()`, voidedByStaffId: args.voidedByStaffId })
      .where(eq(serviceRates.id, target.id));
    return target;
  },
};
