import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readThrough } from '../../lib/cache.js';
import { db } from '../client.js';
import { bookingMode, creditPackages, type LocationKey } from '../schema/schema.js';
import { CREDIT_TIERS, type CreditTier } from '../../contracts/wire.js';
import type { Tx } from '../tx.js';

type BookingMode = (typeof bookingMode.enumValues)[number];
type Runner = Tx | typeof db;

/**
 * Catalog reads for purchasable credit packs (schema.sql credit_packages +
 * DATA-CONTRACT §B CreditPackage). One row is one campus, program and tier, and a
 * key names one campus (M4.05). Effective-dated since the Δ 2026-06-08, mirroring
 * service_rates: each key tracks a sequence of rows with non-overlapping
 * `[effective_from, effective_to)` windows (`effective_to NULL` = open-ended
 * current). Repricing is "close the current row's effective_to + insert a new
 * one" — never edit, so a past purchase's `package_id` keeps pointing at the
 * exact price it bought. `expiry_months` is versioned the same way
 * ({@link creditPackagesRepository.setExpiryMonths}). Retiring a pack is just
 * closing effective_to with no replacement; the window filter is the retirement
 * switch (no separate `active` flag).
 *
 * Ordering: `mode ASC, credits ASC`, then `key` so a tie has one answer. Postgres
 * orders enum columns by `pg_enum.enumsortorder` (declaration order), not
 * alphabetically — the `booking_mode` enum is declared `('school', 'daycare')`,
 * so school packs emit before daycare packs. The snapshot pins the order.
 */
export interface CreditPackageRow {
  key: string;
  location: LocationKey;
  mode: BookingMode;
  credits: number;
  price_cents: number;
  label: string;
  is_popular: boolean;
  tier: CreditTier;
  single_day: boolean;
  expiry_months: number;
}

/** `findByKey` additionally returns the surrogate `id` so the purchase path can
 * stamp the exact priced version onto the `credit_ledger` row. */
export interface CreditPackageWithId extends CreditPackageRow {
  id: string;
}

const PACKAGE_PROJECTION = {
  id: creditPackages.id,
  key: creditPackages.key,
  location: creditPackages.location,
  mode: creditPackages.mode,
  credits: creditPackages.credits,
  price_cents: creditPackages.priceCents,
  label: creditPackages.label,
  is_popular: creditPackages.isPopular,
  tier: creditPackages.tier,
  single_day: creditPackages.singleDay,
  expiry_months: creditPackages.expiryMonths,
} as const;

/**
 * Read-through cache for the purchasable catalog. Reference data (rates +
 * packages), shared across every owner at a location, re-read on every
 * booking/credits screen — the classic cache-worthy shape. The key is
 * effective-dated by `today`, so it rolls over on its own at the Chicago
 * midnight boundary; a mid-day repricing (close-the-window + insert, rare)
 * is stale only until the TTL. `PATCH /staff/credit-packages/:key` is the one
 * mutation, and it wipes `creditPackagesInvalidationPattern(location)` in its own
 * request, so a shop opened one second later reads the new months.
 */
const CREDIT_PACKAGES_TTL_SEC = 300;

const CREDIT_PACKAGE_ROW_SCHEMA: z.ZodType<CreditPackageRow> = z.object({
  key: z.string(),
  location: z.enum(['fayetteville', 'bentonville']),
  mode: z.enum(['school', 'daycare']),
  credits: z.number(),
  price_cents: z.number(),
  label: z.string(),
  is_popular: z.boolean(),
  tier: z.enum(CREDIT_TIERS),
  single_day: z.boolean(),
  expiry_months: z.number(),
});
const CREDIT_PACKAGE_ROWS_SCHEMA = CREDIT_PACKAGE_ROW_SCHEMA.array();

/** Cache key for the active catalog at one (location, day). */
export function creditPackagesCacheKey(location: LocationKey, today: string): string {
  return `creditpackages:${location}:${today}`;
}

/** Every cached catalog day of one campus. */
export function creditPackagesInvalidationPattern(location: LocationKey): string {
  return `creditpackages:${location}:*`;
}

/** A row whose `[effective_from, effective_to)` window contains `today`. */
function effectiveAt(today: string) {
  return and(
    lte(creditPackages.effectiveFrom, today),
    or(isNull(creditPackages.effectiveTo), gt(creditPackages.effectiveTo, today)),
  );
}

export const creditPackagesRepository = {
  /**
   * The catalog currently purchasable at `location` on `today` — the one
   * effective row per `key` whose window contains today. `today` is the
   * Chicago-bucketed YYYY-MM-DD the route computes via `bucketChicagoToday`
   * (the cross-cutting timezone invariant), never raw UTC.
   *
   * `DISTINCT ON (key)` + `ORDER BY key, effective_from DESC` collapses to the
   * single live window per key — belt-and-suspenders against a manual overlap
   * (the write path keeps windows non-overlapping). The result is then ordered
   * by enum mode + credits for the wire.
   */
  async findActive(location: LocationKey, today: string): Promise<CreditPackageRow[]> {
    return readThrough(
      creditPackagesCacheKey(location, today),
      CREDIT_PACKAGES_TTL_SEC,
      CREDIT_PACKAGE_ROWS_SCHEMA,
      async () => {
        const current = db
          .selectDistinctOn([creditPackages.key], PACKAGE_PROJECTION)
          .from(creditPackages)
          .where(and(eq(creditPackages.location, location), effectiveAt(today)))
          .orderBy(asc(creditPackages.key), desc(creditPackages.effectiveFrom))
          .as('current_packages');

        const rows = await db
          .select({
            key: current.key,
            location: current.location,
            mode: current.mode,
            credits: current.credits,
            price_cents: current.price_cents,
            label: current.label,
            is_popular: current.is_popular,
            tier: current.tier,
            single_day: current.single_day,
            expiry_months: current.expiry_months,
          })
          .from(current)
          .orderBy(asc(current.mode), asc(current.credits), asc(current.key));
        return rows;
      },
    );
  },

  /**
   * Day 14 — POST /credit-packages/:key/purchase lookup. Returns the row
   * effective at `today` for this key, or undefined when no key matches OR the
   * only windows are closed/future (retired). A key names its campus, so no
   * location is asked for. The route maps undefined to 404 — retired packages
   * and unknown keys collapse to one shape (no enumeration of retired catalog
   * entries).
   *
   * Tx-scoped so the same-tx INSERT into `charges` + `credit_ledger` sees a
   * consistent snapshot of the package row.
   */
  async findByKey(
    runner: Runner,
    key: string,
    today: string,
  ): Promise<CreditPackageWithId | undefined> {
    const [row] = await runner
      .select(PACKAGE_PROJECTION)
      .from(creditPackages)
      .where(and(eq(creditPackages.key, key), effectiveAt(today)))
      .orderBy(desc(creditPackages.effectiveFrom))
      .limit(1);
    return row;
  },

  /**
   * Every row of one campus and program live on `today`, read in the booking's own
   * transaction, never through the catalog's cache: the offer and a top-up's re-check are
   * money, so a price must be the row's and not a read five minutes old.
   */
  async findLiveForProgram(
    tx: Tx,
    args: { location: LocationKey; mode: BookingMode; today: string },
  ): Promise<CreditPackageWithId[]> {
    return tx
      .selectDistinctOn([creditPackages.key], PACKAGE_PROJECTION)
      .from(creditPackages)
      .where(
        and(
          eq(creditPackages.location, args.location),
          eq(creditPackages.mode, args.mode),
          effectiveAt(args.today),
        ),
      )
      .orderBy(asc(creditPackages.key), desc(creditPackages.effectiveFrom));
  },

  /**
   * `PATCH /staff/credit-packages/:key` (CRED-U08, design §2.4:3099-3106), one
   * statement. A row opened today is corrected in place, so a second correction the
   * same Chicago day answers 200 and not 23505. Any other live row is closed at today
   * and its successor opens today, carrying the row's `effective_to`, so a successor
   * cannot overlap a window scheduled after it. Lots already sold keep their stamped
   * date. `undefined` when no row of the key is live today.
   *
   * Under {@link withCreditPackageLock}: this statement's read and its writes are one
   * snapshot, so a second edit that did not wait first would open the same successor.
   */
  async setExpiryMonths(
    tx: Tx,
    key: string,
    expiryMonths: number,
    today: string,
  ): Promise<CreditPackageRow | undefined> {
    const result = await tx.execute(sql`
      WITH live AS (
        SELECT * FROM credit_packages
         WHERE key = ${key}
           AND effective_from <= ${today}::date
           AND (effective_to IS NULL OR effective_to > ${today}::date)
         ORDER BY effective_from DESC
         LIMIT 1
      ), corrected AS (
        UPDATE credit_packages p SET expiry_months = ${expiryMonths}
          FROM live
         WHERE p.id = live.id AND live.effective_from = ${today}::date
        RETURNING p.*
      ), closed AS (
        UPDATE credit_packages p SET effective_to = ${today}::date
          FROM live
         WHERE p.id = live.id AND live.effective_from < ${today}::date
      ), opened AS (
        INSERT INTO credit_packages
          (key, location, mode, credits, price_cents, label, is_popular, tier, single_day,
           expiry_months, effective_from, effective_to)
        SELECT key, location, mode, credits, price_cents, label, is_popular, tier, single_day,
               ${expiryMonths}, ${today}::date, effective_to
          FROM live
         WHERE effective_from < ${today}::date
        RETURNING *
      )
      SELECT key, location, mode, credits, price_cents, label, is_popular, tier, single_day,
             expiry_months
        FROM corrected
      UNION ALL
      SELECT key, location, mode, credits, price_cents, label, is_popular, tier, single_day,
             expiry_months
        FROM opened
    `);
    return result.rows[0] as CreditPackageRow | undefined;
  },

  /**
   * Lookup by surrogate id, NO effective-window filter.
   */
  async findById(runner: Runner, id: string): Promise<CreditPackageWithId | undefined> {
    const [row] = await runner
      .select(PACKAGE_PROJECTION)
      .from(creditPackages)
      .where(eq(creditPackages.id, id))
      .limit(1);
    return row;
  },
};
