import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { messages, threadDogs, threads } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type { ThreadRowForWire } from '../../lib/threadWire.js';

/**
 * Data-access seam for `threads` (+ `thread_dogs` + a `messages`-derived
 * unread-count). Day-7a addition; mirrors `bookingsRepository` /
 * `requestsRepository` shape. Routes import these methods, never query
 * Drizzle directly. The unread-count batch derivation lives here rather
 * than `messagesRepository` because it's a *property of the thread* per
 * DATA-CONTRACT §B Thread, not a property of the message list.
 */

export type ThreadRow = ThreadRowForWire;

const THREAD_PROJECTION = {
  id: threads.id,
  category: threads.category,
  title: threads.title,
  subText: threads.subText,
  participantStaffId: threads.participantStaffId,
  lastMessage: threads.lastMessage,
  lastMessageAt: threads.lastMessageAt,
} as const;

export const threadsRepository = {
  /**
   * Every live thread for one owner, newest `last_message_at` first.
   * Drives `GET /threads`.
   */
  async findLiveByOwner(ownerId: string): Promise<ThreadRow[]> {
    return db
      .select(THREAD_PROJECTION)
      .from(threads)
      .where(and(eq(threads.ownerId, ownerId), live(threads)))
      .orderBy(desc(threads.lastMessageAt));
  },

  /**
   * Every live thread across ALL owners, newest `last_message_at` first —
   * the Day-19 staff-portal queue (`GET /staff/threads`). Cross-owner by
   * design (`requireStaff` gates the route); the owner-scoped sibling is
   * `findLiveByOwner`.
   */
  async findLive(): Promise<ThreadRow[]> {
    return db
      .select(THREAD_PROJECTION)
      .from(threads)
      .where(live(threads))
      .orderBy(desc(threads.lastMessageAt));
  },

  /**
   * Whether a live thread exists by id, cross-owner. Drives the 404 on the
   * Day-19b staff message read (`GET /staff/threads/:id/messages`):
   * `messagesRepository.findLiveByThread` can't distinguish "no such thread"
   * from "live thread with no messages yet", so existence is checked here.
   */
  async existsLive(id: string): Promise<boolean> {
    const [row] = await db
      .select({ exists: sql<boolean>`true` })
      .from(threads)
      .where(and(eq(threads.id, id), live(threads)))
      .limit(1);
    return row !== undefined;
  },

  /**
   * Resolve a live thread's `owner_id` inside a tx (or `undefined` if the
   * id doesn't exist / is expired). The Day-19 staff reply verb needs the
   * owner to address the `message-received` notification; the route 404s
   * on `undefined`.
   */
  async findOwnerById(tx: Tx, id: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ ownerId: threads.ownerId })
      .from(threads)
      .where(and(eq(threads.id, id), live(threads)))
      .limit(1);
    return row?.ownerId;
  },

  /**
   * Bump the thread's `last_message` preview + `last_message_at` so the
   * thread list re-sorts to the top after a new message. Called by the
   * Day-19 staff reply verb inside the same tx as the message INSERT.
   */
  async bumpLastMessage(tx: Tx, id: string, preview: string): Promise<void> {
    await tx
      .update(threads)
      .set({ lastMessage: preview, lastMessageAt: sql`now()` })
      .where(eq(threads.id, id));
  },

  /**
   * Single thread by id, owner-scoped. Same response (`undefined`) for
   * not-found vs not-yours so attackers can't enumerate thread ids — the
   * route maps `undefined` → 404.
   */
  async findByIdForOwner(id: string, ownerId: string): Promise<ThreadRow | undefined> {
    const rows = await db
      .select(THREAD_PROJECTION)
      .from(threads)
      .where(and(eq(threads.id, id), eq(threads.ownerId, ownerId), live(threads)))
      .limit(1);
    return rows[0];
  },

  /**
   * Resolve `thread_dogs` membership for a batch of thread ids. Live
   * rows only; the route groups + sorts the dog ids for snapshot
   * stability. `thread_dogs` is the M:N denorm DATA-CONTRACT §B Thread
   * calls `related_dog_ids`.
   */
  async findDogsByThreadIds(threadIds: string[]): Promise<{ threadId: string; dogId: string }[]> {
    if (threadIds.length === 0) return [];
    return db
      .select({
        threadId: threadDogs.threadId,
        dogId: threadDogs.dogId,
      })
      .from(threadDogs)
      .where(and(inArray(threadDogs.threadId, threadIds), live(threadDogs)))
      .orderBy(asc(threadDogs.dogId));
  },

  /**
   * Unread-count per thread, batched (single GROUP BY query for N threads).
   * Per DATA-CONTRACT §B Thread + schema comment near `messages_thread_idx`:
   * count live messages where `sender_kind != 'owner'` AND `read_at IS
   * NULL`. The "not sent by owner" rule is the load-bearing bit — a
   * just-sent owner message is not unread to itself.
   *
   * Returns only thread ids with a non-zero count; the route fills zero
   * for any thread id absent from the result.
   */
  async findUnreadCountsByThreadIds(
    threadIds: string[],
  ): Promise<{ threadId: string; unreadCount: number }[]> {
    if (threadIds.length === 0) return [];
    const rows = await db
      .select({
        threadId: messages.threadId,
        unreadCount: count(messages.id),
      })
      .from(messages)
      .where(
        and(
          inArray(messages.threadId, threadIds),
          ne(messages.senderKind, 'owner'),
          isNull(messages.readAt),
          live(messages),
        ),
      )
      .groupBy(messages.threadId);
    // Drizzle's `count()` returns string in some runtimes; coerce defensively.
    return rows.map((r) => ({
      threadId: r.threadId,
      unreadCount: typeof r.unreadCount === 'string' ? Number(r.unreadCount) : r.unreadCount,
    }));
  },

  /**
   * Existence check used by `GET /threads/:id/messages` for the owner
   * scoping. Returns true iff the thread exists, is live, and belongs to
   * the owner. Cheaper than a full row fetch when the route only needs
   * the yes/no gate; matches the resolver-only style of Day-5a's
   * ownership joins.
   */
  async ownsThread(threadId: string, ownerId: string): Promise<boolean> {
    const rows = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.ownerId, ownerId), live(threads)))
      .limit(1);
    return rows.length > 0;
  },
};
