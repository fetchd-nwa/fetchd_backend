import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { MirrorPrincipal } from '../auth/mirror.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { messagesRepository } from '../db/repositories/messagesRepository.js';
import { messages, threads } from '../db/schema/schema.js';
import { withActor } from '../db/tx.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import type { Audience, ThreadPublisher } from './bus.js';
import type { AckSink } from './server.js';

/**
 * *Delivered* (9.2.0; design "Receipts" `:238-245`; `MessageReceiptState`; the `ack` doc on
 * `RealtimeClientFrameWire`; pass 3 item 3). An `ack` says "an open screen here has the other
 * side's messages up to this `seq`". The socket has already re-resolved the principal and run
 * the thread check (`server.ts`), coalesced the acks, and hands the highest here.
 */

/** What one stamp moved: the other side's messages up to `upToSeq`, at `at` (ISO-8601). */
export interface DeliveredStep {
  threadId: string;
  ownerId: string;
  /** Whose messages were stamped: the receipt goes to this side only. */
  side: Audience;
  /** The highest `seq` stamped (MB27 Q2). */
  upToSeq: number;
  at: string;
}

/** The `app.actor` the routes stamp (`actorOf`), for a socket's mirror principal. */
function actorOfMirror(p: MirrorPrincipal): string {
  const principal: Principal =
    p.kind === 'owner'
      ? { kind: 'owner', ownerId: p.id, supabaseUid: '' }
      : { kind: 'staff', staffId: p.id, role: p.role, supabaseUid: '' };
  return actorOf(principal);
}

/**
 * Stamp the OTHER side's live messages in `threadId` with `seq ≤ upToSeq` and no
 * `delivered_at` yet, with the database clock (an earlier stamp keeps its instant). Under
 * `withActor` (the acker's actor: `audit_capture` watches `messages`), and the thread row is
 * locked FIRST (`SELECT … FOR UPDATE`), so an ack and a read on one thread never deadlock (L4).
 * A family's ack is honoured only on her own thread (B2; the socket checked it too). `null`
 * when the thread is gone or not hers, or nothing moved a receipt (MB27 Q2; MB46 ruling 3;
 * round 1 L1).
 */
export async function stampDelivered(
  principal: MirrorPrincipal,
  threadId: string,
  upToSeq: number,
): Promise<DeliveredStep | null> {
  return withActor(actorOfMirror(principal), async (tx) => {
    const [thread] = await tx
      .select({ id: threads.id, ownerId: threads.ownerId })
      .from(threads)
      .where(and(eq(threads.id, threadId), isNull(threads.expiredAt)))
      .for('update');
    if (thread === undefined) return null;
    if (principal.kind === 'owner' && thread.ownerId !== principal.id) return null;
    const side: Audience = principal.kind === 'owner' ? 'staff' : 'owner';
    const moved = await tx
      .update(messages)
      .set({ deliveredAt: sql`now()` })
      .where(
        and(
          eq(messages.threadId, thread.id),
          eq(messages.senderKind, side),
          lte(messages.threadSeq, upToSeq),
          isNull(messages.expiredAt),
          isNull(messages.deliveredAt),
        ),
      )
      .returning({
        seq: messages.threadSeq,
        deliveredAt: messages.deliveredAt,
        readAt: messages.readAt,
        staffRead: sql<boolean>`exists (select 1 from message_staff_reads r where r.message_id = ${messages.id})`,
      });
    // MB46 ruling 3: a message already read was delivered too, so it is stamped, but it moves no
    // receipt: the school's by `read_at`, the family's by a `message_staff_reads` row.
    const unread = moved.filter((m) => (side === 'staff' ? m.readAt === null : !m.staffRead));
    const first = unread[0];
    if (first === undefined || first.deliveredAt === null) return null;
    const highest = unread.reduce((top, m) => (m.seq > top ? m.seq : top), first.seq);
    // Round 1 L1 (MB62, MB64): a receipt never moves backwards. Her `read` receipt already covers
    // her messages up to the highest any staffer read, and a staffer may read a newer one before
    // an older one, so a *Delivered* at or below it moves nothing. The school's side needs no
    // check: her reads and every ack stamp from the bottom up, and a pre-9.2.0 `read_at` was
    // never a receipt (MB53 (b)).
    if (
      side === 'owner' &&
      highest <= (await messagesRepository.highestStaffReadSeq(tx, thread.id))
    ) {
      return null;
    }
    return {
      threadId: thread.id,
      ownerId: thread.ownerId,
      side,
      upToSeq: highest,
      at: pgTimestampToIso(first.deliveredAt),
    };
  });
}

/**
 * The serving app's ack sink (`buildApp()` → `decorateRealtime(app, {onAck})`): the stamp, then,
 * only when a row moved (MB27 Q2) and only after its transaction committed, one `receipt`
 * `delivered` to the side whose messages they are. The publish is total: never awaited.
 */
export async function deliveredAckSink(
  principal: MirrorPrincipal,
  threadId: string,
  upToSeq: number,
  publisher: ThreadPublisher,
): Promise<void> {
  const step = await stampDelivered(principal, threadId, upToSeq);
  if (step === null) return;
  publisher.publishForThread(
    { id: step.threadId, owner_id: step.ownerId },
    {
      kind: 'receipt',
      side: step.side,
      state: 'delivered',
      up_to_seq: step.upToSeq,
      at: step.at,
    },
  );
}

/** Checked here, where it is defined: the sink is an `AckSink`. */
deliveredAckSink satisfies AckSink;
