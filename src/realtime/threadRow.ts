import { eq } from 'drizzle-orm';
import { threads } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';

/**
 * The thread row a route publishes for (MB53 (a)): its `id` and `owner_id` as the DATABASE renders
 * them (lower-case uuids), read inside the route's transaction, so a publish never carries the
 * request's spelling of an id (a dev-arm principal keeps its header's case; the token arm's comes
 * from the mirror row). `publishForThread` copies these two into the event and picks the channel
 * from `owner_id`.
 */
export async function committedThreadRow(
  tx: Tx,
  threadId: string,
): Promise<{ id: string; owner_id: string }> {
  const [row] = await tx
    .select({ id: threads.id, owner_id: threads.ownerId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (row === undefined) throw new Error(`thread ${threadId}: no row to publish for`);
  return row;
}
