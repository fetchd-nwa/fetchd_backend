import { and, eq, isNull } from 'drizzle-orm';
import { messageAttachments, messages, threads } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';

/**
 * OL5 (design A2; pass 3 item 2): the live threads a media row is attached in, through a live
 * message, read inside `DELETE /media/:id`'s transaction so the route can publish
 * `thread.changed` for each after commit. Ids only (the publish choke point takes the row's
 * `id` and `owner_id`). Empty for a row that is no message's attachment.
 */
export async function liveThreadsAttaching(
  tx: Tx,
  mediaId: string,
): Promise<Array<{ id: string; owner_id: string }>> {
  return tx
    .selectDistinct({ id: threads.id, owner_id: threads.ownerId })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messageAttachments.mediaAssetId, mediaId),
        isNull(messages.expiredAt),
        isNull(threads.expiredAt),
      ),
    );
}
