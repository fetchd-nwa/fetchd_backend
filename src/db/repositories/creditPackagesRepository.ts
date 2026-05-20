import { asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { bookingMode, creditPackages } from '../schema/schema.js';

type BookingMode = (typeof bookingMode.enumValues)[number];

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
  mode: BookingMode;
  credits: number;
  price_cents: number;
  label: string;
  is_popular: boolean;
}

export const creditPackagesRepository = {
  async findActive(): Promise<CreditPackageRow[]> {
    return db
      .select({
        key: creditPackages.key,
        mode: creditPackages.mode,
        credits: creditPackages.credits,
        price_cents: creditPackages.priceCents,
        label: creditPackages.label,
        is_popular: creditPackages.isPopular,
      })
      .from(creditPackages)
      .where(eq(creditPackages.active, true))
      .orderBy(asc(creditPackages.mode), asc(creditPackages.credits));
  },
};
