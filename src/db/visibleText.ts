import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { VISIBLE_CHARACTER_PATTERN } from '../lib/signupFields.js';

/**
 * The SQL twin of `signupFields.isNonBlank` (P05 fix round 1, BF1): the
 * value (a column, or any text expression) when it holds a visible
 * character, else NULL. It matches the same
 * character class, sent as a bound parameter, so every reader of an owner's
 * name or phone — `MeWire` in JavaScript, `StaffOwnerWire` and
 * `StaffDogWire.owner_name` in SQL — gives a stored value one answer.
 * Postgres's own `\S` would not: it counts NBSP and the zero-width characters
 * as text.
 */
export function visibleOrNull(value: SQLWrapper): SQL<string | null> {
  return sql<string | null>`CASE WHEN ${value} ~ ${VISIBLE_CHARACTER_PATTERN} THEN ${value} END`;
}
