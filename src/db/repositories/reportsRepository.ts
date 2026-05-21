import { and, desc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { dogs, reports } from '../schema/schema.js';
import { live } from '../softExpire.js';
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
};
