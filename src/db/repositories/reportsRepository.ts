import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { dogs, reports } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';
import type { ReportProgram } from '../../lib/reportWire.js';

/**
 * Data-access seam for `reports`. The route layer parses query/params,
 * calls into here, then passes the row(s) to the wire helper
 * (`lib/reportWire.ts`) for R2 rehydration. The dependency rule: routes →
 * repos → drizzle; the wire helper is pure (takes structural rows in,
 * emits wire shapes out — no DB).
 *
 * Owner scoping rides on an INNER JOIN through `dogs` (`reports.dog_id →
 * dogs.id`, `dogs.owner_id → owners.id`). The route layer doesn't see the
 * join — only "rows for this dog, only if this owner owns it."
 *
 * Two coexisting ownership-check patterns (Day-6a observation):
 *   1. creditsRepository — LEFT JOIN through dogs with null-sentinel
 *      coalesce (returns zero-balance for new dogs).
 *   2. dogCompletedClassesRepository — two-query existence disambiguation.
 *   3. (this) — INNER JOIN, ownership baked into the WHERE.
 * Three shapes for three needs; the rule-of-two for an extracted
 * `dogsRepository.findOwnedById` will fire on Day 9 when mutations land.
 */

/**
 * The shape every report read returns. Matches DATA-CONTRACT §B Report
 * columns the wire helper consumes. Drizzle's `mode: 'string'` is why
 * timestamptz comes back as `string` not `Date`. JSONB columns come back
 * as `unknown` — the wire helper coerces at the boundary.
 */
export interface ReportRow {
  id: string;
  dogId: string;
  date: string;
  trainerStaffId: string | null;
  category: ServiceCategory;
  program: ReportProgram;
  excerpt: string;
  fullText: string;
  visitCount: number | null;
  verdictHeadline: string | null;
  results: unknown;
  content: unknown;
}

const REPORT_PROJECTION = {
  id: reports.id,
  dogId: reports.dogId,
  date: reports.date,
  trainerStaffId: reports.trainerStaffId,
  category: reports.category,
  program: reports.program,
  excerpt: reports.excerpt,
  fullText: reports.fullText,
  visitCount: reports.visitCount,
  verdictHeadline: reports.verdictHeadline,
  results: reports.results,
  content: reports.content,
} as const;

export const reportsRepository = {
  /**
   * Every live report for a dog the owner owns, newest first. Empty
   * array if the dog isn't theirs (the JOIN drops it) or has no reports —
   * same response for both branches, no id leak.
   */
  async findLiveForOwnedDog(dogId: string, ownerId: string): Promise<ReportRow[]> {
    return db
      .select(REPORT_PROJECTION)
      .from(reports)
      .innerJoin(dogs, eq(reports.dogId, dogs.id))
      .where(and(eq(reports.dogId, dogId), eq(dogs.ownerId, ownerId), live(reports), live(dogs)))
      .orderBy(desc(reports.date));
  },

  /**
   * Single report by id, owner-scoped through the dog FK. Returns
   * undefined for both "doesn't exist" and "not yours" — the route
   * surfaces 404 either way so an attacker can't enumerate.
   */
  async findByIdForOwner(id: string, ownerId: string): Promise<ReportRow | undefined> {
    const rows = await db
      .select(REPORT_PROJECTION)
      .from(reports)
      .innerJoin(dogs, eq(reports.dogId, dogs.id))
      .where(and(eq(reports.id, id), eq(dogs.ownerId, ownerId), live(reports), live(dogs)))
      .limit(1);
    return rows[0];
  },

  /**
   * Most-recent report for a dog the owner owns. Used by both
   * `/dogs/:id/reports/latest` and the resolver's fallback branch.
   * Returns undefined if the dog has no live reports (or isn't theirs).
   */
  async findLatestForOwnedDog(dogId: string, ownerId: string): Promise<ReportRow | undefined> {
    const rows = await db
      .select(REPORT_PROJECTION)
      .from(reports)
      .innerJoin(dogs, eq(reports.dogId, dogs.id))
      .where(and(eq(reports.dogId, dogId), eq(dogs.ownerId, ownerId), live(reports), live(dogs)))
      .orderBy(desc(reports.date))
      .limit(1);
    return rows[0];
  },

  // -------------------------------------------------------------------
  // Wire 1.13.0 / 2.3b — the staff read surface. Cross-owner by design:
  // `requireStaff` gates the routes, so there is no owner scope to enforce
  // and no `dogs` INNER JOIN. That mirrors `findByIdInTx` below, the
  // pre-existing staff-context read, rather than the owner reads above.
  // -------------------------------------------------------------------

  /**
   * Every live report for ONE dog, cross-owner, newest first — the
   * `GET /staff/reports` list. `dogId` is required by the contract
   * (`GetStaffReportsQuery`, Allison ruling WC-A5): there is deliberately no
   * unscoped variant of this query, so no caller can dump every report in the
   * system. Served by `reports_dog_date_idx` (`schema.sql:598` — `(dog_id,
   * date DESC)`); the optional `program`/`category` predicates filter the few
   * rows that index returns.
   *
   * Unlike `findLiveForOwnedDog` this does NOT join `dogs`: a soft-expired dog
   * is still a dog staff may read the history of, and the owner-scoping the
   * join exists for has no meaning for a staff principal.
   */
  async findLiveForDog(
    dogId: string,
    filters: { program?: ReportProgram; category?: ServiceCategory } = {},
  ): Promise<ReportRow[]> {
    const conditions = [eq(reports.dogId, dogId), live(reports)];
    if (filters.program !== undefined) conditions.push(eq(reports.program, filters.program));
    if (filters.category !== undefined) conditions.push(eq(reports.category, filters.category));
    return db
      .select(REPORT_PROJECTION)
      .from(reports)
      .where(and(...conditions))
      .orderBy(desc(reports.date));
  },

  /**
   * Single LIVE report by id, cross-owner — the staff branch of
   * `GET /reports/:id`. `undefined` for both "doesn't exist" and
   * "soft-deleted", which the route surfaces as the same 404 the owner branch
   * emits. The non-tx sibling of `findByIdInTx`.
   */
  async findLiveById(id: string): Promise<ReportRow | undefined> {
    const rows = await db
      .select(REPORT_PROJECTION)
      .from(reports)
      .where(and(eq(reports.id, id), live(reports)))
      .limit(1);
    return rows[0];
  },

  // -------------------------------------------------------------------
  // Day 19 — staff portal verb 2 (report authoring). Tx-only writes
  // compose inside `withMutation`; the route validates the R2 shape
  // (content-by-program) above this layer.
  // -------------------------------------------------------------------

  /**
   * INSERT a report row. `results`/`content` are JSONB (objects or null);
   * the schema `reports_check` CHECK enforces content-presence-by-program
   * as a backstop to the route's Zod validator. Returns the new id.
   */
  async create(
    tx: Tx,
    values: {
      dogId: string;
      date: string;
      trainerStaffId: string | null;
      category: ServiceCategory;
      program: ReportProgram;
      excerpt: string;
      fullText: string;
      visitCount: number | null;
      verdictHeadline: string | null;
      results: unknown;
      content: unknown;
    },
  ): Promise<{ id: string }> {
    const [row] = await tx
      .insert(reports)
      .values({
        dogId: values.dogId,
        date: values.date,
        trainerStaffId: values.trainerStaffId,
        category: values.category,
        program: values.program,
        excerpt: values.excerpt,
        fullText: values.fullText,
        visitCount: values.visitCount,
        verdictHeadline: values.verdictHeadline,
        results: values.results,
        content: values.content,
      })
      .returning({ id: reports.id });
    if (!row) {
      throw new Error('reportsRepository.create: INSERT returned no row');
    }
    return row;
  },

  /**
   * Read a report by id inside a tx (no owner scope — staff context).
   * `undefined` if absent/expired. The Day-19 PATCH verb needs the live
   * `program` to re-validate content-by-program against the stored row.
   */
  async findByIdInTx(tx: Tx, id: string): Promise<ReportRow | undefined> {
    const [row] = await tx
      .select(REPORT_PROJECTION)
      .from(reports)
      .where(and(eq(reports.id, id), live(reports)))
      .limit(1);
    return row;
  },

  /**
   * Partial UPDATE of the editable content fields (identity columns
   * dog_id / category / program are locked — a re-author creates a new
   * report). `undefined`-valued keys are left unchanged by the caller's
   * set object; `results`/`content` may be set to null to clear.
   */
  async update(
    tx: Tx,
    id: string,
    set: {
      excerpt?: string;
      fullText?: string;
      visitCount?: number | null;
      verdictHeadline?: string | null;
      results?: unknown;
      content?: unknown;
    },
  ): Promise<void> {
    await tx
      .update(reports)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(reports.id, id));
  },

  /**
   * Soft-delete one report — `DELETE /staff/reports/:id` (wire 1.13.0).
   * Stamps `expired_at`; the row is RETAINED (`schema.sql` LIFECYCLE
   * CONVENTION — the API never hard-deletes) and drops out of every read
   * because all of them filter `live(reports)`.
   *
   * The `live(reports)` predicate in the WHERE is what makes a second delete
   * a 404 instead of a silent success: an already-expired row matches nothing,
   * so `undefined` comes back and the route raises `not_found`. Mirrors
   * `dogsRepository.softExpire`; `updated_at` moves via the `reports_touch`
   * trigger (`schema.sql:1836-1847`), not by hand.
   *
   * Returns the expired row's `dogId` rather than a bare boolean: presence IS
   * the existence signal, and the caller needs the dog to resolve the owner
   * whose `report-published` notification this delete has to take down with
   * it (2.6 adversary, fix round 1). One statement, no follow-up SELECT to
   * race against the stamp.
   */
  async softExpire(tx: Tx, id: string): Promise<{ dogId: string } | undefined> {
    const [row] = await tx
      .update(reports)
      .set({ expiredAt: sql`now()` })
      .where(and(eq(reports.id, id), live(reports)))
      .returning({ dogId: reports.dogId });
    return row;
  },
};
