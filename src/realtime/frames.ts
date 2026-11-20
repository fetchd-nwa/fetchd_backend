import { and, eq, isNull, lt, max, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client.js';
import { livePrincipal } from '../db/repositories/staffRepository.js';
import { messages, staff, threads } from '../db/schema/schema.js';
import type { MirrorPrincipal } from '../auth/mirror.js';
import type { MessageWire, RealtimeCloseCode, RealtimeServerFrameWire } from '../contracts/wire.js';
import { REALTIME_CLOSE_CODES } from '../contracts/wire.js';
import type { Audience, BusEvent, ChannelTarget } from './bus.js';

/**
 * Delivery, per audience (9.2.0; design §3 rule 7, A2 OM2, OM3, OL1, OL9; brief LR7, LR14,
 * LR16). Every frame is built here, by each instance, from ids on the bus and rows in the
 * database, so nothing a socket receives was carried through Redis.
 *
 * For each event the frame is BUILT first (3–5 below), THEN liveness is checked (1), THEN it is
 * sent (L1, MB53: the window between the check and the send is one query, never a build). The
 * whole delivery is bounded (L3, MB53: `deliverEvent`).
 *   1. **Liveness at delivery (OM2 + LR16), at the send.** One query over the principals of the
 *      sockets the event would reach: live owners, and live staff that are not the system row,
 *      with their role. A socket whose row is gone, or whose role differs from the one it
 *      authenticated with, closes 4403 and gets nothing. **If that query fails (LR7), nothing is
 *      delivered and nothing is closed**: an unknown answer is never "missing"; every local
 *      socket is told `resync` instead.
 *   2. **Audience (LR14's second half).** A staff channel's frame goes only to staff sockets,
 *      an owner channel's only to that owner's sockets. A socket found in the wrong set is a
 *      routing bug: nothing is sent to it and one error line is logged (it pages).
 *   3. **Owner check (OM3).** Before any owner-audience frame, the thread row's `owner_id` must
 *      equal the channel's owner (and so the socket's). Otherwise nothing is sent and one error
 *      line is logged. A thread that no longer reads (expired) gives no frame and one debug line
 *      (OL9).
 *   4. **The frame, per audience.** A family hears staff typing exactly as `{type: 'typing',
 *      thread_id, from: 'school'}` (OL1; her answer 2); staff hear `from: 'owner'`, or `from:
 *      'staff'` with the colleague's `staff_id` and first name, never their own.
 *   5. **Messages and receipts (pass 3 item 1).** `message.created`: the row is read bound to
 *      its thread (`m.id = $message_id AND m.thread_id = $thread_id`, LR14), live, in a live
 *      thread; else no frame (OL9: one debug line; a message of ANOTHER thread is a forged or
 *      misrouted event: one error line). `prev_seq` is the highest LIVE `seq` below it, `null`
 *      when none (B7). `message` is the element the reader's own GET returns, from the
 *      injected `messageElement` builder, per audience; there is NO default builder (MB27 Q6):
 *      without one nothing of the message is built, one error line is logged and the sockets
 *      are told to `resync`. `receipt` reaches only the side whose messages they are, and
 *      `staff.read` staff only: either on the wrong channel is a routing fault (one error
 *      line, nothing sent).
 */

/** What delivery needs from a local socket. */
export interface FrameSocket {
  /** The row it authenticated as, with that row's role (never the client's claim). */
  readonly principal: MirrorPrincipal;
  send(frame: RealtimeServerFrameWire): void;
  close(code: RealtimeCloseCode): void;
}

/** A message row as the frame builder reads it: the whole `messages` row, a superset of what
 *  the GETs' element builder takes. */
export type MessageElementRow = typeof messages.$inferSelect;

/**
 * The one seam of `message.created` (pass 3 item 1): the `message` element the reader's own
 * `GET …/messages` returns for this row, built for `audience` (a family's never carries
 * `reach`). Phase F wires it to the function both GETs call; tests inject one. There is no
 * default (MB27 Q6).
 */
export type MessageElementFor = (
  row: MessageElementRow,
  audience: Audience,
) => Promise<MessageWire>;

/** A live message bound to its thread, with B7's `prev_seq`. */
export interface MessageForFrame {
  row: MessageElementRow;
  prevSeq: number | null;
}

export interface DeliveryDeps {
  livePrincipals(principals: readonly MirrorPrincipal[]): Promise<MirrorPrincipal[]>;
  threadOwner(threadId: string): Promise<string | null>;
  staffFirstName(staffId: string): Promise<string | null>;
  /** LR14 + OL9 + B7: the message bound to its thread, live, in a live thread. */
  messageForFrame(messageId: string, threadId: string): Promise<MessageForFrame | null>;
  /** The thread a message is in, live or not (`null`: none). Read only to tell a forged or
   *  misrouted event (error) from one that no longer reads (debug); it never decides delivery. */
  threadOfMessage(messageId: string): Promise<string | null>;
  /** No default (MB27 Q6). */
  messageElement?: MessageElementFor;
  log: FastifyBaseLogger;
}

function principalKey(p: { kind: string; id: string }): string {
  return `${p.kind}:${p.id}`;
}

/**
 * OM2's one query (LR16: with the role). Staff are filtered by `livePrincipal()`
 * (`staffRepository.ts`: live AND NOT the school's system row, rs3 M5.26). Its columns render
 * qualified by the table's own name (`"staff"."expired_at"`), so the staff arm reads `staff`
 * unaliased.
 */
export async function livePrincipalsAmong(
  principals: readonly MirrorPrincipal[],
): Promise<MirrorPrincipal[]> {
  const ownerIds = principals.filter((p) => p.kind === 'owner').map((p) => p.id);
  const staffIds = principals.filter((p) => p.kind === 'staff').map((p) => p.id);
  if (ownerIds.length === 0 && staffIds.length === 0) return [];
  // Each id list is ONE bound array parameter: drizzle expands a bare interpolated array into a
  // parenthesised list.
  const result = await db.execute(sql`
    SELECT 'owner' AS kind, o.id::text AS id, NULL::text AS role
      FROM owners o
     WHERE o.id = ANY(${sql.param(ownerIds)}::uuid[]) AND o.expired_at IS NULL
    UNION ALL
    SELECT 'staff' AS kind, staff.id::text AS id, staff.role::text AS role
      FROM staff
     WHERE staff.id = ANY(${sql.param(staffIds)}::uuid[]) AND ${livePrincipal()}
  `);
  const rows = result.rows as Array<{ kind: string; id: string; role: string | null }>;
  return rows.map((row): MirrorPrincipal => {
    if (row.kind === 'owner') return { kind: 'owner', id: row.id };
    return {
      kind: 'staff',
      id: row.id,
      role: row.role as Extract<MirrorPrincipal, { kind: 'staff' }>['role'],
    };
  });
}

/** A live thread's `owner_id`, or `null` (missing or expired). */
export async function threadOwnerOf(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: threads.ownerId })
    .from(threads)
    .where(and(eq(threads.id, threadId), isNull(threads.expiredAt)))
    .limit(1);
  return row?.ownerId ?? null;
}

/** A staff row's first name: its name up to the first space (as `settingsRepository` reads one). */
export async function staffFirstNameOf(staffId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: staff.name })
    .from(staff)
    .where(eq(staff.id, staffId))
    .limit(1);
  if (row === undefined) return null;
  return row.name.trim().split(/\s+/)[0] ?? null;
}

/**
 * LR14's read: `WHERE m.id = $message_id AND m.thread_id = $thread_id`, the message live and
 * its thread live (OL9). B7: `prev_seq` is the highest live `seq` below it in that thread.
 */
export async function messageForFrameOf(
  messageId: string,
  threadId: string,
): Promise<MessageForFrame | null> {
  const [found] = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(threads, and(eq(threads.id, messages.threadId), isNull(threads.expiredAt)))
    .where(
      and(eq(messages.id, messageId), eq(messages.threadId, threadId), isNull(messages.expiredAt)),
    )
    .limit(1);
  if (found === undefined) return null;
  const row = found.message;
  const [previous] = await db
    .select({ seq: max(messages.threadSeq) })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, row.threadId),
        lt(messages.threadSeq, row.threadSeq),
        isNull(messages.expiredAt),
      ),
    );
  const prevSeq = previous?.seq;
  return { row, prevSeq: prevSeq === null || prevSeq === undefined ? null : Number(prevSeq) };
}

/** The thread a message is in, expired or not; `null` when there is no such message. */
export async function threadOfMessageOf(messageId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return row?.threadId ?? null;
}

export const defaultDeliveryDeps = {
  livePrincipals: livePrincipalsAmong,
  threadOwner: threadOwnerOf,
  staffFirstName: staffFirstNameOf,
  messageForFrame: messageForFrameOf,
  threadOfMessage: threadOfMessageOf,
} satisfies Omit<DeliveryDeps, 'log' | 'messageElement'>;

type FrameFor = (socket: FrameSocket) => RealtimeServerFrameWire | null;

type CreatedEvent = Extract<BusEvent, { kind: 'message.created' }>;
type ReceiptEvent = Extract<BusEvent, { kind: 'receipt' }>;

function receiptFrame(event: ReceiptEvent): FrameFor {
  const frame: RealtimeServerFrameWire = {
    type: 'receipt',
    thread_id: event.thread_id,
    state: event.state,
    up_to_seq: event.up_to_seq,
    at: event.at,
  };
  return () => frame;
}

/** `message.created` for one audience: the bound live row, `prev_seq`, the injected element. */
async function messageFrame(
  event: CreatedEvent,
  audience: Audience,
  deps: DeliveryDeps,
): Promise<FrameFor | null> {
  const build = deps.messageElement;
  if (build === undefined) {
    // MB27 Q6: never an element built some other way. The sockets refetch over HTTP.
    deps.log.error(
      { kind: event.kind, thread_id: event.thread_id, audience },
      'realtime: no message element builder is wired, so no message.created frame is built; its sockets told to resync',
    );
    const resync: RealtimeServerFrameWire = { type: 'resync' };
    return () => resync;
  }
  const found = await deps.messageForFrame(event.message_id, event.thread_id);
  if (found === null) {
    const home = await deps.threadOfMessage(event.message_id);
    if (home !== null && home !== event.thread_id) {
      deps.log.error(
        { kind: event.kind, thread_id: event.thread_id, audience },
        'realtime routing fault: a message.created names a message of another thread; nothing sent',
      );
    } else {
      deps.log.debug(
        { thread_id: event.thread_id, message_id: event.message_id },
        'realtime: message no longer reads; no frame (OL9)',
      );
    }
    return null;
  }
  const message = await build(found.row, audience);
  const frame: RealtimeServerFrameWire = {
    type: 'message.created',
    thread_id: event.thread_id,
    prev_seq: found.prevSeq,
    message,
  };
  return () => frame;
}

/** Build the frame for one audience, or `null` to send nothing. */
async function frameFor(
  target: ChannelTarget,
  event: BusEvent,
  deps: DeliveryDeps,
): Promise<FrameFor | null> {
  if (target.audience === 'owner') {
    // A staff-audience kind on an owner channel is a routing bug (LR14): `bell.changed`,
    // `staff.read`, the school's receipt and an owner's own typing.
    if (
      event.kind === 'bell.changed' ||
      event.kind === 'staff.read' ||
      (event.kind === 'receipt' && event.side === 'staff') ||
      (event.kind === 'typing' && event.from === 'owner')
    ) {
      deps.log.error(
        { kind: event.kind, thread_id: event.thread_id },
        'realtime routing fault: a staff-audience event arrived on an owner channel; nothing sent',
      );
      return null;
    }
    // OM3: the thread row decides whose it is, never the payload.
    const owner = await deps.threadOwner(event.thread_id);
    if (owner === null) {
      deps.log.debug(
        { thread_id: event.thread_id },
        'realtime: thread no longer reads; no frame (OL9)',
      );
      return null;
    }
    if (owner !== target.ownerId || event.owner_id !== target.ownerId) {
      deps.log.error(
        { kind: event.kind, thread_id: event.thread_id },
        "realtime routing fault: the thread's owner is not this channel's owner; nothing sent",
      );
      return null;
    }
    switch (event.kind) {
      case 'typing': {
        const frame: RealtimeServerFrameWire = {
          type: 'typing',
          thread_id: event.thread_id,
          from: 'school',
        };
        return () => frame;
      }
      case 'message.created':
        return messageFrame(event, 'owner', deps);
      case 'receipt':
        return receiptFrame(event);
      case 'thread.changed': {
        const frame: RealtimeServerFrameWire = {
          type: 'thread.changed',
          thread_id: event.thread_id,
        };
        return () => frame;
      }
      default:
        // Refused above; never reached.
        return null;
    }
  }

  switch (event.kind) {
    case 'typing': {
      if (event.from === 'owner') {
        const frame: RealtimeServerFrameWire = {
          type: 'typing',
          thread_id: event.thread_id,
          from: 'owner',
        };
        return () => frame;
      }
      const firstName = await deps.staffFirstName(event.staff_id);
      if (firstName === null) {
        deps.log.debug({ staff_id: event.staff_id }, 'realtime: typist no longer reads; no frame');
        return null;
      }
      const frame: RealtimeServerFrameWire = {
        type: 'typing',
        thread_id: event.thread_id,
        from: 'staff',
        staff_id: event.staff_id,
        first_name: firstName,
      };
      // Never echoed to the typist's own sockets.
      return (socket) => (socket.principal.id === event.staff_id ? null : frame);
    }
    case 'thread.changed': {
      const frame: RealtimeServerFrameWire = { type: 'thread.changed', thread_id: event.thread_id };
      return () => frame;
    }
    case 'bell.changed': {
      const frame: RealtimeServerFrameWire = { type: 'bell.changed' };
      return () => frame;
    }
    case 'message.created':
      return messageFrame(event, 'staff', deps);
    case 'receipt': {
      // The family's receipt is hers alone ("sent only to the side whose messages they are").
      if (event.side !== 'staff') {
        deps.log.error(
          { kind: event.kind, thread_id: event.thread_id },
          'realtime routing fault: an owner-audience event arrived on the staff channel; nothing sent',
        );
        return null;
      }
      return receiptFrame(event);
    }
    case 'staff.read': {
      const frame: RealtimeServerFrameWire = {
        type: 'staff.read',
        thread_id: event.thread_id,
        staff_id: event.staff_id,
        message_ids: event.message_ids,
      };
      return () => frame;
    }
  }
}

/** What bounds one event's delivery (L3, MB53): the hub's clock and its limit. */
export interface DeliveryBound {
  ms: number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function inAudience(target: ChannelTarget, s: FrameSocket): boolean {
  return target.audience === 'staff'
    ? s.principal.kind === 'staff'
    : s.principal.kind === 'owner' && s.principal.id === target.ownerId;
}

/**
 * Deliver one bus event to the local sockets in its channel's set. Never throws: every failure
 * ends in `resync` to the sockets it concerns, never in a guess.
 *
 * **L3 (MB53):** the instance has one delivery queue, so the whole of one event's delivery (the
 * build and the liveness query) is bounded by `bound.ms`. At the bound, the event's audience
 * sockets are told `resync` (as a failed build tells them), the queue moves on, and the abandoned
 * delivery sends and closes nothing when it ends, early or late, answered or thrown.
 */
export async function deliverEvent(
  target: ChannelTarget,
  event: BusEvent,
  sockets: readonly FrameSocket[],
  everySocket: () => Iterable<FrameSocket>,
  deps: DeliveryDeps,
  bound?: DeliveryBound,
): Promise<void> {
  if (sockets.length === 0) return;
  const run = { abandoned: false };
  const delivery = deliverInOrder(target, event, sockets, everySocket, deps, run);
  if (bound === undefined) return delivery;
  if (await withinBound(delivery, bound)) return;
  run.abandoned = true;
  deps.log.warn(
    { kind: event.kind, thread_id: event.thread_id, audience: target.audience, bound_ms: bound.ms },
    'realtime delivery: an event was not delivered within its bound; its sockets told to resync, the queue moves on',
  );
  for (const s of sockets) if (inAudience(target, s)) s.send({ type: 'resync' });
}

/** `true` when `work` settles within the bound (its rejection passed on), `false` at the bound.
 *  `work`'s outcome is always handled here, however late: never an unhandled rejection (LR5). */
function withinBound(work: Promise<void>, bound: DeliveryBound): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = bound.setTimeout(() => resolve(false), bound.ms);
    work.then(
      () => {
        bound.clearTimeout(timer);
        resolve(true);
      },
      (err: unknown) => {
        bound.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * One event, in this order (L1, MB53): **build** the frame, **then** run the one liveness query
 * (OM2 + LR16), **then** send. A principal removed while the frame was being built is closed 4403
 * and sent nothing: the window between OM2's check and the send is that one query, never the
 * build. `run.abandoned` (set at L3's bound) stops it before any close or send.
 */
async function deliverInOrder(
  target: ChannelTarget,
  event: BusEvent,
  sockets: readonly FrameSocket[],
  everySocket: () => Iterable<FrameSocket>,
  deps: DeliveryDeps,
  run: { abandoned: boolean },
): Promise<void> {
  let build: FrameFor | null = null;
  let buildFailed = false;
  if (sockets.some((s) => inAudience(target, s))) {
    try {
      build = await frameFor(target, event, deps);
    } catch (err) {
      buildFailed = true;
      if (!run.abandoned) {
        deps.log.warn(
          { err_message: err instanceof Error ? err.message : String(err), kind: event.kind },
          'realtime delivery: a frame could not be built; its sockets told to resync',
        );
      }
    }
  }
  if (run.abandoned) return;

  let live: MirrorPrincipal[];
  try {
    const seen = new Map<string, MirrorPrincipal>();
    for (const s of sockets) seen.set(principalKey(s.principal), s.principal);
    live = await deps.livePrincipals([...seen.values()]);
  } catch (err) {
    if (run.abandoned) return;
    // LR7: deliver nothing, close nothing; every local socket refetches.
    deps.log.warn(
      { err_message: err instanceof Error ? err.message : String(err) },
      'realtime delivery: the liveness check failed; nothing delivered, every socket told to resync',
    );
    for (const s of everySocket()) s.send({ type: 'resync' });
    return;
  }
  if (run.abandoned) return;

  const liveByKey = new Map(live.map((p) => [principalKey(p), p]));
  const reachable: FrameSocket[] = [];
  for (const s of sockets) {
    const row = liveByKey.get(principalKey(s.principal));
    if (row === undefined) {
      s.close(REALTIME_CLOSE_CODES.forbidden);
      continue;
    }
    if (row.kind === 'staff' && s.principal.kind === 'staff' && row.role !== s.principal.role) {
      s.close(REALTIME_CLOSE_CODES.forbidden); // LR16: it re-derives what it hears on reconnect
      continue;
    }
    reachable.push(s);
  }

  const misplaced = reachable.filter((s) => !inAudience(target, s));
  if (misplaced.length > 0) {
    deps.log.error(
      { audience: target.audience, sockets: misplaced.length, kind: event.kind },
      "realtime routing fault: a socket outside this channel's audience was in its set; nothing sent to it",
    );
  }
  const audience = reachable.filter((s) => inAudience(target, s));
  if (audience.length === 0) return;
  if (buildFailed) {
    for (const s of audience) s.send({ type: 'resync' });
    return;
  }
  if (build === null) return;
  for (const s of audience) {
    const frame = build(s);
    if (frame !== null) s.send(frame);
  }
}
