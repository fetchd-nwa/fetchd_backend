import { and, asc, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db } from '../client.js';
import { bookingMode, creditPackages, type LocationKey } from '../schema/schema.js';
import type { Tx } from '../tx.js';

type BookingMode = (typeof bookingMode.enumValues)[number];
type Runner = Tx | typeof db;

/**
 * Catalog reads for purchasable credit packs (schema.sql credit_packages +
 * DATA-CONTRACT §B CreditPackage). Effective-dated since the Δ 2026-06-08,
 * mirroring service_rates: each (key, location) tracks a sequence of rows
 * with non-overlapping `[effective_from, effective_to)` windows (`effective_to
 * NULL` = open-ended current). Repricing is "close the current row's
 * effective_to + insert a new one" — never edit, so a past purchase's
 * `package_id` keeps pointing at the exact price it bought. Retiring a pack is
 * just closing effective_to with no replacement; the window filter is the
 * retirement switch (no separate `active` flag).
 *
 * Ordering: `mode ASC, credits ASC`. Postgres orders enum columns by
 * `pg_enum.enumsortorder` (declaration order), not alphabetically — the
 * `booking_mode` enum is declared `('school', 'daycare')`, so school
 * packs emit before daycare packs. The snapshot pins the order.
 */
export interface CreditPackageRow {
  key: string;
  location: LocationKey;
  mode: BookingMode;
  credits: number;
  price_cents: number;
  label: string;
  is_popular: boolean;
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
} as const;

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
      })
      .from(current)
      .orderBy(asc(current.mode), asc(current.credits));
    return rows;
  },

  /**
   * Day 14 — POST /credit-packages/:key/purchase lookup. Returns the package
   * effective at `today` for this (key, location), or undefined when no key
   * matches OR the only windows are closed/future (retired). The route maps
   * undefined to 404 — retired packages and unknown keys collapse to one shape
   * (no enumeration of retired catalog entries).
   *
   * Tx-scoped so the same-tx INSERT into `charges` + `credit_ledger` sees a
   * consistent snapshot of the package row.
   */
  async findByKey(
    runner: Runner,
    key: string,
    location: LocationKey,
    today: string,
  ): Promise<CreditPackageWithId | undefined> {
    const [row] = await runner
      .select(PACKAGE_PROJECTION)
      .from(creditPackages)
      .where(
        and(eq(creditPackages.key, key), eq(creditPackages.location, location), effectiveAt(today)),
      )
      .orderBy(desc(creditPackages.effectiveFrom))
      .limit(1);
    return row;
  },
};
