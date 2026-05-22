import { dogFeeding } from '../schema/schema.js';
import { RELINK } from '../softExpire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `dog_feeding`. Schema is 1:1 with dogs (PK is
 * `dog_id`, no separate id space). Day-9d's `PUT /dogs/:id/feeding`
 * is the only writer.
 *
 * **The canonical second use of `RELINK`** (after Day-2's provisioning
 * webhook owner/staff upsert). PUT semantics = "replace the resource
 * at this URL": if no row exists, insert; if a live row exists,
 * overwrite via `onConflictDoUpdate`; if a soft-expired row exists,
 * the `...RELINK` spread (which sets `expired_at = null`) resurrects
 * it in the same statement. This preserves the row's `created_at`
 * + audit history, which a "soft-expire then INSERT" approach would
 * lose.
 *
 * Soft-expire (DELETE) is intentionally NOT in the §C surface today.
 * Owners replace feeding via PUT; "no feeding on file" is expressed
 * by the absence of the row, but today's API never creates that
 * absence. If a "clear feeding" verb lands later, add `softExpire`
 * here and the corresponding DELETE handler; until then, YAGNI.
 */

type DogFeeding = typeof dogFeeding.$inferSelect;

export interface FeedingValues {
  brand: string;
  amount: string;
  frequency: string;
  notes: string | null;
}

async function upsert(tx: Tx, dogId: string, values: FeedingValues): Promise<DogFeeding> {
  const [row] = await tx
    .insert(dogFeeding)
    .values({
      dogId,
      brand: values.brand,
      amount: values.amount,
      frequency: values.frequency,
      notes: values.notes,
    })
    .onConflictDoUpdate({
      target: dogFeeding.dogId,
      set: {
        ...RELINK,
        brand: values.brand,
        amount: values.amount,
        frequency: values.frequency,
        notes: values.notes,
      },
    })
    .returning();
  if (!row) {
    throw new Error('dogFeeding.upsert: returning yielded no row');
  }
  return row;
}

export const dogFeedingRepository = {
  upsert,
};
