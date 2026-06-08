/**
 * Convert a Drizzle `pgEnum`'s `enumValues` (a readonly string array) to the
 * mutable, non-empty tuple `[T, ...T[]]` shape that `z.enum(...)` requires.
 *
 * The cast is provably safe at compile time — a Postgres enum is declared
 * with at least one label, and a zero-value pgEnum would fail at schema
 * load before any code that imports this could run. The runtime guard
 * exists not because the case can happen but because the next reader
 * shouldn't have to derive the proof — a thrown error with a precise
 * message beats `as` magic and a comment. Costs one `.length` read per
 * pgEnum at module load.
 *
 * Promoted Day 5b at the third use — `auth/provisioning.ts` (LOCATIONS,
 * STAFF_ROLES) and `routes/me.ts` (LOCATIONS) had this same cast inlined.
 * Day 5b's `/availability` (mode + location) and `/rates` (category +
 * location) added three more — overdue.
 *
 *   const LOCATIONS = LOCATION_SLUGS;
 *   z.enum(LOCATIONS); // typed [LocationKey, ...LocationKey[]]
 */
export function pgEnumTuple<T extends string>(pgEnum: { enumValues: readonly T[] }): [T, ...T[]] {
  const values = pgEnum.enumValues;
  const first = values[0];
  if (first === undefined) {
    throw new Error(
      'pgEnumTuple: pgEnum has zero values (impossible from Postgres; check init order)',
    );
  }
  return [first, ...values.slice(1)];
}
