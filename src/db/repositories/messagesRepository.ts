import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { messages } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type { MessageRowForWire } from '../../lib/threadWire.js';

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
};
