import { isNull, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * Soft-expire is the load-bearing lifecycle invariant (`schema.sql` LIFECYCLE
 * CONVENTION, locked 2026-05-19): the API never `DELETE`s — "remove" is
 * `UPDATE ... SET expired_at = now()` and every read filters `expired_at IS
 * NULL`. The 33 audited tables (`schema.sql` audit-trigger attach loop,
 * ~lines 1115-1123) carry the column; this helper makes filtering them the
 * default call shape so a future read can't silently include tombstones.
 *
 *   await db.select().from(owners).where(live(owners))
 *
 * The generic bound means calling this on a table that doesn't carry
 * `expiredAt` is a compile error, not a silent no-op typo.
 */
export function live<T extends { expiredAt: AnyColumn }>(table: T): SQL<unknown> {
  return isNull(table.expiredAt);
}

/**
 * Re-link sentinel. Spread into the `set` clause of an `onConflictDoUpdate`
 * to resurrect a previously soft-expired row by clearing `expired_at` —
 * never a second INSERT (`schema.sql` Transaction contract notes, GLOBAL).
 *
 * Canonical uses:
 *   1. Day-2 provisioning webhook — owner/staff upsert by `supabase_uid`.
 *   2. Day-9d `PUT /dogs/:id/feeding` — 1:1 upsert by `dog_feeding.dog_id`
 *      (the PK). A previously soft-expired feeding row resurrects in the
 *      same statement, preserving the row's `created_at` + audit chain.
 *
 *   .onConflictDoUpdate({ target: owners.supabaseUid, set: { ...RELINK, name, phone } })
 *
 * Pairs with the partial UNIQUE indexes (`WHERE expired_at IS NULL`) so a
 * fresh INSERT path is also collision-safe — either approach works, this is
 * the one the contract specifies because it preserves the row's id + history.
 */
export const RELINK = { expiredAt: null } as const;
