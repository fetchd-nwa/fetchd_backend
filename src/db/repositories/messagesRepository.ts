import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { mediaAssets, messageAttachments, messages } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type { MessageRowForWire } from '../../lib/threadWire.js';
import type { MediaKind } from './mediaAssetsRepository.js';

/**
 * One attachment row joined to its media asset, for the message wire. Lives in
 * the data layer (not threadWire) because it's a DB projection; the wire helper
 * shapes + signs it. Only attachments whose media_asset is live are returned.
 */
export interface MessageAttachmentRow {
  messageId: string;
  mediaAssetId: string;
  kind: MediaKind;
  objectKey: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  durationMs: number | null;
  position: number;
}

/**
 * Data-access seam for `messages`. Day-7a addition. The polymorphic sender
 * pair (`sender_kind` + `sender_owner_id|sender_staff_id` XOR per schema
 * CHECK) is kept normalized in the repo projection — `lib/threadWire.
 * flattenMessageSenderId` does the flatten downstream so consumers can
 * still query by kind if they need to.
 *
 * Owner-scoping is delegated to `threadsRepository.ownsThread` — this repo
 * trusts the route to have established ownership before calling, so the
 * message query itself is a plain `WHERE thread_id = $1` without a JOIN.
 * Same pattern as `bookingsRepository.findDogsByBookingIds` trusting that
 * the booking-ids list is already owner-scoped.
 */

export type MessageRow = MessageRowForWire;

const MESSAGE_PROJECTION = {
  id: messages.id,
  threadId: messages.threadId,
  senderKind: messages.senderKind,
  senderOwnerId: messages.senderOwnerId,
  senderStaffId: messages.senderStaffId,
  text: messages.text,
  sentAt: messages.sentAt,
  readAt: messages.readAt,
} as const;

export const messagesRepository = {
  /**
   * All live messages in a thread, oldest first. Caller MUST have already
   * verified the owner owns the thread (`threadsRepository.ownsThread`) —
   * this repo trusts that gate. Sent-time ASC matches the chat UI's
   * "oldest at top, newest at bottom" rendering.
   */
  async findLiveByThread(threadId: string): Promise<MessageRow[]> {
    return db
      .select(MESSAGE_PROJECTION)
      .from(messages)
      .where(and(eq(messages.threadId, threadId), live(messages)))
      .orderBy(asc(messages.sentAt));
  },

  /**
   * INSERT a staff-authored message (Day-19 portal verb 3). Sets
   * `sender_kind='staff'` + `sender_staff_id`; `sender_owner_id` stays
   * NULL (the schema `messages_check` CHECK enforces the XOR). Returns the
   * inserted row in the read projection so the route can wire it back. The
   * route validates `text` + thread existence before calling.
   */
  async createStaffMessage(
    tx: Tx,
    args: { threadId: string; staffId: string; text: string },
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(messages)
      .values({
        threadId: args.threadId,
        senderKind: 'staff',
        senderStaffId: args.staffId,
        text: args.text,
      })
      .returning(MESSAGE_PROJECTION);
    if (!row) {
      throw new Error('messagesRepository.createStaffMessage: INSERT returned no row');
    }
    return row;
  },

  /**
   * INSERT an owner-authored message (Day-19e owner send). Sets
   * `sender_kind='owner'` + `sender_owner_id`; `sender_staff_id` stays NULL
   * (the schema `messages_check` CHECK enforces the XOR). Mirrors
   * `createStaffMessage`. The route validates `text` + ownership before calling.
   */
  async createOwnerMessage(
    tx: Tx,
    args: { threadId: string; ownerId: string; text: string; attachmentMediaIds?: string[] },
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(messages)
      .values({
        threadId: args.threadId,
        senderKind: 'owner',
        senderOwnerId: args.ownerId,
        text: args.text,
      })
      .returning(MESSAGE_PROJECTION);
    if (!row) {
      throw new Error('messagesRepository.createOwnerMessage: INSERT returned no row');
    }
    const attachmentMediaIds = args.attachmentMediaIds ?? [];
    if (attachmentMediaIds.length > 0) {
      // Link rows carry `position` = the client's order so the bubble renders
      // them as sent. The route has already validated each id is the owner's
      // live message-attachment media (see threads.ts).
      await tx.insert(messageAttachments).values(
        attachmentMediaIds.map((mediaAssetId, position) => ({
          messageId: row.id,
          mediaAssetId,
          position,
        })),
      );
    }
    return row;
  },

  /**
   * Batch-load attachments for a set of messages, joined to their (live) media
   * asset, ordered by message then position. The wire helper signs each
   * `objectKey` into a short-lived GET URL. A soft-expired media asset drops
   * out of the join (inner join + `expired_at IS NULL`), so an "unsent" photo
   * silently disappears from the bubble.
   */
  async findAttachmentsByMessageIds(messageIds: string[]): Promise<MessageAttachmentRow[]> {
    if (messageIds.length === 0) return [];
    return db
      .select({
        messageId: messageAttachments.messageId,
        mediaAssetId: messageAttachments.mediaAssetId,
        kind: mediaAssets.kind,
        objectKey: mediaAssets.objectKey,
        width: mediaAssets.width,
        height: mediaAssets.height,
        blurhash: mediaAssets.blurhash,
        durationMs: mediaAssets.durationMs,
        position: messageAttachments.position,
      })
      .from(messageAttachments)
      .innerJoin(mediaAssets, eq(messageAttachments.mediaAssetId, mediaAssets.id))
      .where(and(inArray(messageAttachments.messageId, messageIds), isNull(mediaAssets.expiredAt)))
      .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position));
  },

  /**
   * Mark a thread's owner-facing messages read: set `read_at = now()` on every
   * live, unread, non-owner message in the thread (those are exactly the ones
   * the §B `unread_count` counts — `sender_kind != 'owner' AND read_at IS NULL`).
   * Idempotent: re-running touches nothing once they're read. Owner-scoping is
   * the route's job (`threadsRepository.ownsThread`), same as `findLiveByThread`.
   */
  async markThreadReadForOwner(tx: Tx, threadId: string): Promise<void> {
    await tx
      .update(messages)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(messages.threadId, threadId),
          ne(messages.senderKind, 'owner'),
          isNull(messages.readAt),
          live(messages),
        ),
      );
  },
};
