import { and, asc, eq } from 'drizzle-orm';
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

export const groupClassesRepository = {
  /** All live group classes, enum-natural order. */
  async findAll(): Promise<GroupClassRow[]> {
    return db
      .select(GROUP_CLASS_PROJECTION)
      .from(groupClasses)
      .where(live(groupClasses))
      .orderBy(asc(groupClasses.key));
  },

  /** Single live group class by key, or undefined. */
  async findByKey(key: GroupClassKey): Promise<GroupClassRow | undefined> {
    const rows = await db
      .select(GROUP_CLASS_PROJECTION)
      .from(groupClasses)
      .where(and(eq(groupClasses.key, key), live(groupClasses)))
      .limit(1);
    return rows[0];
  },

  /**
   * Live prereq options for one class — OR-alternatives per Day-6a's
   * schema amendment. Returns the list of `prereq_class_key` values in
   * enum-natural order (matches the wire emit order for snapshot
   * stability). Zero rows = the class has no prereqs.
   */
  async findPrereqOptionsForClass(classKey: GroupClassKey): Promise<GroupClassKey[]> {
    const rows = await db
      .select({ prereqClassKey: classPrereqOptions.prereqClassKey })
      .from(classPrereqOptions)
      .where(and(eq(classPrereqOptions.classKey, classKey), live(classPrereqOptions)))
      .orderBy(asc(classPrereqOptions.prereqClassKey));
    return rows.map((r) => r.prereqClassKey);
  },
};
