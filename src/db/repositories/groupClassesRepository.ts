import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readThrough } from '../../lib/cache.js';
import { pgEnumTuple } from '../../lib/pgEnumTuple.js';
import { db } from '../client.js';
import { classPrereqOptions, groupClasses } from '../schema/schema.js';
import { live } from '../softExpire.js';
import { groupClassKey } from '../schema/schema.js';

/**
 * Data-access seam for `group_classes` + `class_prereq_options`. The
 * catalog is small (today: 3 keys in the `group_class_key` enum) but
 * eligibility derivation depends on the OR-prereq join landed by Day-6a's
 * schema amendment, so the repo carves both concerns off cleanly.
 *
 * Ordering: `ORDER BY key` over a pg enum column sorts by declaration
 * order (`puppy`, `manners-1`, `manners-2`) — what the FE expects, and
 * stable for snapshot tests.
 */
export type GroupClassKey = (typeof groupClassKey.enumValues)[number];

export interface GroupClassRow {
  key: GroupClassKey;
  name: string;
  weeks: number;
  pricePerDogCents: number;
  capacity: number;
  ageRange: string | null;
  description: string;
  enrollmentType: string; // CHECK-constrained to 'open' | 'cohort'
}

const GROUP_CLASS_PROJECTION = {
  key: groupClasses.key,
  name: groupClasses.name,
  weeks: groupClasses.weeks,
  pricePerDogCents: groupClasses.pricePerDogCents,
  capacity: groupClasses.capacity,
  ageRange: groupClasses.ageRange,
  description: groupClasses.description,
  enrollmentType: groupClasses.enrollmentType,
} as const;

/**
 * Day-8 cache: the group-class catalog is the most stable catalog in
 * the system — entries are added, never deleted (soft-expire only),
 * and price/description edits are rare staff-portal ops. 10 minutes
 * is generous; the §3 invalidation column lists `bumpFilled` but
 * that touches `cohorts`, not `group_classes` — so this cache only
 * needs to be dropped on the rare catalog write itself.
 */
const GROUP_CLASSES_TTL_SEC = 600;
export const GROUP_CLASSES_CATALOG_KEY = 'groupclasses:catalog';

/**
 * Cache keys for the per-class reads. A catalog edit (Day 19 portal verb)
 * invalidates ALL three Day-8 group-class cache shapes — `findAll`'s
 * list, every `findByKey` entry, every `findPrereqOptionsForClass` entry
 * — via `invalidatePattern('groupclasses:*')`. The shared `groupclasses:`
 * prefix is the load-bearing part of that idiom.
 */
export function groupClassesByKeyCacheKey(key: GroupClassKey): string {
  return `groupclasses:byKey:${key}`;
}
export function groupClassesPrereqsCacheKey(classKey: GroupClassKey): string {
  return `groupclasses:prereqs:${classKey}`;
}

const GROUP_CLASS_ROW_SCHEMA: z.ZodType<GroupClassRow> = z.object({
  key: z.enum(pgEnumTuple(groupClassKey)),
  name: z.string(),
  weeks: z.number(),
  pricePerDogCents: z.number(),
  capacity: z.number(),
  ageRange: z.string().nullable(),
  description: z.string(),
  enrollmentType: z.string(),
});
const GROUP_CLASS_ROWS_SCHEMA = GROUP_CLASS_ROW_SCHEMA.array();
const GROUP_CLASS_ROW_OPTIONAL_SCHEMA = GROUP_CLASS_ROW_SCHEMA.optional();
const GROUP_CLASS_KEYS_SCHEMA = z.enum(pgEnumTuple(groupClassKey)).array();

export const groupClassesRepository = {
  /**
   * All live group classes, enum-natural order. Day-8 read-through
   * cached under `groupclasses:catalog` for 10 min. Invalidated by
   * group-class catalog writes (rare staff-portal verb, Day 19).
   */
  async findAll(): Promise<GroupClassRow[]> {
    return readThrough(
      GROUP_CLASSES_CATALOG_KEY,
      GROUP_CLASSES_TTL_SEC,
      GROUP_CLASS_ROWS_SCHEMA,
      () =>
        db
          .select(GROUP_CLASS_PROJECTION)
          .from(groupClasses)
          .where(live(groupClasses))
          .orderBy(asc(groupClasses.key)),
    );
  },

  /**
   * Single live group class by key, or undefined. Day-8 read-through
   * cached under `groupclasses:byKey:{key}` for 10 min. `readThrough`
   * does NOT cache when the query returns `undefined` (a deleted-then-
   * re-added class would otherwise be permanently invisible for the
   * TTL); a not-found re-queries every call until the row appears.
   */
  async findByKey(key: GroupClassKey): Promise<GroupClassRow | undefined> {
    return readThrough(
      groupClassesByKeyCacheKey(key),
      GROUP_CLASSES_TTL_SEC,
      GROUP_CLASS_ROW_OPTIONAL_SCHEMA,
      async () => {
        const rows = await db
          .select(GROUP_CLASS_PROJECTION)
          .from(groupClasses)
          .where(and(eq(groupClasses.key, key), live(groupClasses)))
          .limit(1);
        return rows[0];
      },
    );
  },

  /**
   * Live prereq options for one class — OR-alternatives per Day-6a's
   * schema amendment. Returns the list of `prereq_class_key` values in
   * enum-natural order (matches the wire emit order for snapshot
   * stability). Zero rows = the class has no prereqs.
   *
   * Day-8 read-through cached under `groupclasses:prereqs:{classKey}`
   * for 10 min. Empty array IS a real value and IS cached (distinct
   * from `findByKey`'s undefined case). Invalidated by prereq-options
   * edits (Day 19) via the `groupclasses:*` pattern wipe.
   */
  async findPrereqOptionsForClass(classKey: GroupClassKey): Promise<GroupClassKey[]> {
    return readThrough(
      groupClassesPrereqsCacheKey(classKey),
      GROUP_CLASSES_TTL_SEC,
      GROUP_CLASS_KEYS_SCHEMA,
      async () => {
        const rows = await db
          .select({ prereqClassKey: classPrereqOptions.prereqClassKey })
          .from(classPrereqOptions)
          .where(and(eq(classPrereqOptions.classKey, classKey), live(classPrereqOptions)))
          .orderBy(asc(classPrereqOptions.prereqClassKey));
        return rows.map((r) => r.prereqClassKey);
      },
    );
  },
};
