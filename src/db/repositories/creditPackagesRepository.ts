import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { bookingMode, creditPackages, LOCATION_SLUGS } from '../schema/schema.js';
import type { Tx } from '../tx.js';

type BookingMode = (typeof bookingMode.enumValues)[number];
type LocationKey = (typeof LOCATION_SLUGS)[number];
type Runner = Tx | typeof db;

/**
 * Catalog reads for purchasable credit packs (schema.sql:612-620 +
 * DATA-CONTRACT §B CreditPackage Δ 2026-05-20). The `active` boolean is
 * the retirement switch: setting `active = false` (never DELETE — append-
 * only history) hides a pack from the wire. `is_popular` drives the FE's
 * "most popular" highlight.
 *
 * Ordering: `mode ASC, credits ASC`. Postgres orders enum columns by
 * `pg_enum.enumsortorder` (declaration order), not alphabetically — the
 * `booking_mode` enum is declared `('school', 'daycare')`, so school
 * packs emit before daycare packs. Snapshot pins the order.
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

const PACKAGE_PROJECTION = {
  key: creditPackages.key,
  location: creditPackages.location,
  mode: creditPackages.mode,
  credits: creditPackages.credits,
  price_cents: creditPackages.priceCents,
  label: creditPackages.label,
  is_popular: creditPackages.isPopular,
} as const;

export const creditPackagesRepository = {
  async findActive(location: LocationKey): Promise<CreditPackageRow[]> {
    return db
      .select(PACKAGE_PROJECTION)
      .from(creditPackages)
      .where(and(eq(creditPackages.active, true), eq(creditPackages.location, location)))
      .orderBy(asc(creditPackages.mode), asc(creditPackages.credits));
  },

  /**
   * Day 14 — POST /credit-packages/:key/purchase lookup. Returns the
   * active package matching this key, or undefined when no key matches OR
   * when the package has been retired (`active=false`). The route maps
   * undefined to 404 — retired packages and unknown keys collapse to one
   * shape (no enumeration of retired catalog entries).
   *
   * Tx-scoped so the same-tx INSERT into `charges` + `credit_ledger` sees
   * a consistent snapshot of the package row.
   */
  async findByKey(
    runner: Runner,
    key: string,
    location: LocationKey,
  ): Promise<CreditPackageRow | undefined> {
    const [row] = await runner
      .select(PACKAGE_PROJECTION)
      .from(creditPackages)
      .where(
        and(
          eq(creditPackages.key, key),
          eq(creditPackages.location, location),
          eq(creditPackages.active, true),
        ),
      )
      .limit(1);
    return row;
  },
};
