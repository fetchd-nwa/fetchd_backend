import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { dogCompletedClasses, dogs } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { GroupClassKey } from './groupClassesRepository.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `dog_completed_classes`. Used by the eligibility
 * endpoint (Day-6a) to derive R7 server-side: does the dog have any
 * completed class that satisfies the target class's OR-prereq options?
 *
 * Ownership is enforced via a JOIN through `dogs` (same pattern as
 * `creditsRepository`'s LEFT JOIN — avoids a two-query race). The
 * undefined sentinel maps to 404 at the route (dog doesn't exist OR
 * not owned by this principal; same response so ids don't enumerate).
 */
export const dogCompletedClassesRepository = {
  /**
   * Completed class_keys for one owned dog. Returns:
   *   - `undefined` if the dog doesn't exist OR isn't owned by `ownerId`
   *     (404 sentinel)
   *   - `[]` if the dog exists and owned but has no completed classes
   *   - `GroupClassKey[]` (enum-natural-ordered) otherwise
   *
   * The dog-existence check is done via INNER JOIN: if zero rows come
   * back from the join, we can't distinguish "no dog" from "no
   * completions" — so we do a second cheap existence check only when
   * the join is empty, before deciding 404 vs `[]`.
   */
  async findCompletedKeysForOwnedDog(
    dogId: string,
    ownerId: string,
  ): Promise<GroupClassKey[] | undefined> {
    const completionRows = await db
      .select({ classKey: dogCompletedClasses.classKey })
      .from(dogCompletedClasses)
      .innerJoin(dogs, eq(dogs.id, dogCompletedClasses.dogId))
      .where(
        and(
          eq(dogCompletedClasses.dogId, dogId),
          eq(dogs.ownerId, ownerId),
          live(dogCompletedClasses),
          live(dogs),
        ),
      )
      .orderBy(asc(dogCompletedClasses.classKey));
    if (completionRows.length > 0) {
      return completionRows.map((r) => r.classKey as GroupClassKey);
    }
    // Empty join could mean "dog doesn't exist / not owned" OR "dog has
    // zero completions." Second query disambiguates.
    const dogExists = await db
      .select({ id: dogs.id })
      .from(dogs)
      .where(and(eq(dogs.id, dogId), eq(dogs.ownerId, ownerId), live(dogs)))
      .limit(1);
    if (dogExists.length === 0) return undefined;
    return [];
  },

  /**
   * Day-11 R7-in-txn read. Returns the dog's live completed class keys
   * directly off the join, no ownership re-check (the route runs
   * `dogsRepository.findOwnedExists` first as the parent-dog gate, so
   * by the time we reach this point the dog is known to be owned).
   * Empty array = dog has no completions yet (caller decides if that
   * fails the eligibility check based on the cohort's prereq options).
   */
  async findCompletedKeysForDogInTx(tx: Tx, dogId: string): Promise<GroupClassKey[]> {
    const rows = await tx
      .select({ classKey: dogCompletedClasses.classKey })
      .from(dogCompletedClasses)
      .where(and(eq(dogCompletedClasses.dogId, dogId), live(dogCompletedClasses)))
      .orderBy(asc(dogCompletedClasses.classKey));
    return rows.map((r) => r.classKey as GroupClassKey);
  },
};
