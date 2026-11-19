import { and, asc, eq, gt, inArray, isNull, lte, min, ne, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { mediaAssets, messageAttachments, messageStaffReads, messages } from '../schema/schema.js';
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
  threadSeq: messages.threadSeq,
  clientMessageId: messages.clientMessageId,
  deliveredAt: messages.deliveredAt,
} as const;

/** A sender's stored message for one `client_message_id` (W2): where it is, and the row. */
export type StoredClientMessage = MessageRow;

export const messagesRepository = {
  /**
   * All live messages in a thread, in `seq` order (9.2.0, contract-notes mechanic 16):
   * commit order, never `sent_at`, which is the transaction's start, so two sends never
   * swap places. Caller MUST have already verified the owner owns the thread
   * (`threadsRepository.ownsThread`) — this repo trusts that gate.
   */
  async findLiveByThread(
    threadId: string,
    opts: { afterSeq?: number } = {},
  ): Promise<MessageRow[]> {
    return db
      .select(MESSAGE_PROJECTION)
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          live(messages),
          // W4: `?after_seq=`, the catch-up after a gap (bounded by the route, CR4).
          opts.afterSeq !== undefined ? gt(messages.threadSeq, opts.afterSeq) : undefined,
        ),
      )
      .orderBy(asc(messages.threadSeq));
  },

  /** One message by id, expired or not (a replay re-reads what it answered, A8). */
  async findById(id: string): Promise<MessageRow | undefined> {
    const [row] = await db
      .select(MESSAGE_PROJECTION)
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1);
    return row;
  },

  /**
   * The school's FIRST read of each of a batch of family messages (mechanic 9: a family's
   * *Read* is the earliest staffer's read), keyed by message id; absent when no staffer read it.
   */
  async findFirstStaffReads(messageIds: readonly string[]): Promise<Map<string, string>> {
    if (messageIds.length === 0) return new Map();
    const rows = await db
      .select({ messageId: messageStaffReads.messageId, at: min(messageStaffReads.readAt) })
      .from(messageStaffReads)
      .where(inArray(messageStaffReads.messageId, [...messageIds]))
      .groupBy(messageStaffReads.messageId);
    return new Map(
      rows
        .filter((r): r is { messageId: string; at: string } => r.at !== null)
        .map((r) => [r.messageId, r.at] as const),
    );
  },

  /**
   * A family's stored message for her `client_message_id` (W2, A2 OL2: unique per sender),
   * expired or not, as the unique index holds it, in whatever thread it is. The send routes
   * read it BEFORE the Idempotency-Key's body hash (and again on the pool after a 23505,
   * LR11), so a repeat of a message the server holds is that message.
   */
  async findByOwnerClientMessageId(
    ownerId: string,
    clientMessageId: string,
  ): Promise<StoredClientMessage | undefined> {
    const [row] = await db
      .select(MESSAGE_PROJECTION)
      .from(messages)
      .where(
        and(eq(messages.senderOwnerId, ownerId), eq(messages.clientMessageId, clientMessageId)),
      )
      .limit(1);
    return row;
  },

  /** A staffer's stored message for her `client_message_id`, as above. */
  async findByStaffClientMessageId(
    staffId: string,
    clientMessageId: string,
  ): Promise<StoredClientMessage | undefined> {
    const [row] = await db
      .select(MESSAGE_PROJECTION)
      .from(messages)
      .where(
        and(eq(messages.senderStaffId, staffId), eq(messages.clientMessageId, clientMessageId)),
      )
      .limit(1);
    return row;
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
    args: {
      threadId: string;
      staffId: string;
      text: string;
      attachmentMediaIds?: string[];
      clientMessageId?: string | null;
    },
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(messages)
      .values({
        threadId: args.threadId,
        senderKind: 'staff',
        senderStaffId: args.staffId,
        text: args.text,
        clientMessageId: args.clientMessageId ?? null,
      })
      .returning(MESSAGE_PROJECTION);
    if (!row) {
      throw new Error('messagesRepository.createStaffMessage: INSERT returned no row');
    }
    // W6 (9.2.0): a staff reply's photos and videos, in the order sent. The route has checked
    // each is a live message attachment a staffer uploaded for this family.
    const attachmentMediaIds = args.attachmentMediaIds ?? [];
    if (attachmentMediaIds.length > 0) {
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
   * INSERT an owner-authored message (Day-19e owner send). Sets
   * `sender_kind='owner'` + `sender_owner_id`; `sender_staff_id` stays NULL
   * (the schema `messages_check` CHECK enforces the XOR). Mirrors
   * `createStaffMessage`. The route validates `text` + ownership before calling.
   */
  async createOwnerMessage(
    tx: Tx,
    args: {
      threadId: string;
      ownerId: string;
      text: string;
      attachmentMediaIds?: string[];
      clientMessageId?: string | null;
    },
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(messages)
      .values({
        threadId: args.threadId,
        senderKind: 'owner',
        senderOwnerId: args.ownerId,
        text: args.text,
        clientMessageId: args.clientMessageId ?? null,
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
   *
   * 9.2.0 (W5, B10): with `upToSeq`, only the school's messages at or below it (the newest she
   * RENDERED), so one committed after her GET stays unread. A read also stamps *Delivered* at the
   * same instant where nothing had (B10). The caller locks the thread row first (L4). Answers the
   * highest `seq` it read and the instant, for the school's `receipt` (pass 3 publishes it), or
   * `null` when it read nothing.
   */
  async markThreadReadForOwner(
    tx: Tx,
    threadId: string,
    upToSeq?: number,
  ): Promise<{ upToSeq: number; at: string } | null> {
    const read = await tx
      .update(messages)
      .set({ readAt: sql`now()`, deliveredAt: sql`coalesce(${messages.deliveredAt}, now())` })
      .where(
        and(
          eq(messages.threadId, threadId),
          ne(messages.senderKind, 'owner'),
          isNull(messages.readAt),
          live(messages),
          upToSeq !== undefined ? lte(messages.threadSeq, upToSeq) : undefined,
        ),
      )
      .returning({ seq: messages.threadSeq, at: messages.readAt });
    const [first] = read;
    if (first === undefined || first.at === null) return null;
    return { upToSeq: Math.max(...read.map((r) => r.seq)), at: first.at };
  },

  /**
   * `POST /staff/threads/:id/read` (S46, MSG-U17; signed design §2.9:4555): mark read, FOR THE
   * CALLER ONLY, the listed messages that are this thread's live FAMILY messages (anything else
   * listed is ignored), one `message_staff_reads` row each, and stamp *Delivered* where nothing
   * had. The caller locks the thread row first (L4), so two staffers' reads of one thread
   * serialize and `firstRead` is exact: the messages no staffer had read before this call, with
   * the highest `seq` among them and the instant (CR14: only the school's FIRST read moves the
   * family's receipt; pass 3 publishes it). `null` when this call is no one's first read.
   */
  async markReadForStaff(
    tx: Tx,
    args: { threadId: string; staffId: string; messageIds: readonly string[] },
  ): Promise<{ readIds: string[]; firstRead: { upToSeq: number; at: string } | null }> {
    if (args.messageIds.length === 0) return { readIds: [], firstRead: null };
    const family = await tx
      .select({ id: messages.id, seq: messages.threadSeq })
      .from(messages)
      .where(
        and(
          inArray(messages.id, [...args.messageIds]),
          eq(messages.threadId, args.threadId),
          eq(messages.senderKind, 'owner'),
          live(messages),
        ),
      );
    if (family.length === 0) return { readIds: [], firstRead: null };
    const ids = family.map((m) => m.id);
    const before = await tx
      .selectDistinct({ id: messageStaffReads.messageId })
      .from(messageStaffReads)
      .where(inArray(messageStaffReads.messageId, ids));
    const inserted = await tx
      .insert(messageStaffReads)
      .values(ids.map((messageId) => ({ messageId, staffId: args.staffId })))
      .onConflictDoNothing()
      .returning({ messageId: messageStaffReads.messageId, at: messageStaffReads.readAt });
    await tx
      .update(messages)
      .set({ deliveredAt: sql`now()` })
      .where(and(inArray(messages.id, ids), isNull(messages.deliveredAt)));
    const readBefore = new Set(before.map((r) => r.id));
    const first = family.filter((m) => !readBefore.has(m.id));
    const at = inserted[0]?.at;
    return {
      readIds: inserted.map((r) => r.messageId),
      firstRead:
        first.length > 0 && at !== undefined
          ? { upToSeq: Math.max(...first.map((m) => m.seq)), at }
          : null,
    };
  },
};
