import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client.js';
import { staff, threads } from '../db/schema/schema.js';
import type { MirrorPrincipal } from '../auth/mirror.js';
import type { RealtimeCloseCode, RealtimeServerFrameWire } from '../contracts/wire.js';
import { REALTIME_CLOSE_CODES } from '../contracts/wire.js';
import type { BusEvent, ChannelTarget } from './bus.js';

/**
 * Delivery, per audience (9.2.0; design §3 rule 7, A2 OM2, OM3, OL1, OL9; brief LR7, LR14,
 * LR16). Every frame is built here, by each instance, from ids on the bus and rows in the
 * database, so nothing a socket receives was carried through Redis.
 *
 * For each event, in order:
 *   1. **Liveness at delivery (OM2 + LR16).** One query over the principals of the sockets the
 *      event would reach: live owners, and live staff that are not the system row, with their
 *      role. A socket whose row is gone, or whose role differs from the one it authenticated
 *      with, closes 4403 and gets nothing. **If that query fails (LR7), nothing is delivered and
 *      nothing is closed**: an unknown answer is never "missing"; every local socket is told
 *      `resync` instead.
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
 *   `message.created`, `receipt` and `staff.read` are built at integration (pass 3 proper),
 *   through `wireManyMessages`, on the same path.
 */

/** What delivery needs from a local socket. */
export interface FrameSocket {
  /** The row it authenticated as, with that row's role (never the client's claim). */
  readonly principal: MirrorPrincipal;
  send(frame: RealtimeServerFrameWire): void;
  close(code: RealtimeCloseCode): void;
}

export interface DeliveryDeps {
  livePrincipals(principals: readonly MirrorPrincipal[]): Promise<MirrorPrincipal[]>;
  threadOwner(threadId: string): Promise<string | null>;
  staffFirstName(staffId: string): Promise<string | null>;
  log: FastifyBaseLogger;
}

function principalKey(p: { kind: string; id: string }): string {
  return `${p.kind}:${p.id}`;
}

/**
 * OM2's one query (LR16: with the role). Raw fragment, listed for integration: `NOT
 * is_system_account`, to become pass 1's `livePrincipal()`.
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
    SELECT 'staff' AS kind, s.id::text AS id, s.role::text AS role
      FROM staff s
     WHERE s.id = ANY(${sql.param(staffIds)}::uuid[]) AND s.expired_at IS NULL AND NOT is_system_account
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

export const defaultDeliveryDeps = {
  livePrincipals: livePrincipalsAmong,
  threadOwner: threadOwnerOf,
  staffFirstName: staffFirstNameOf,
} satisfies Omit<DeliveryDeps, 'log'>;

type FrameFor = (socket: FrameSocket) => RealtimeServerFrameWire | null;

/** Build the frame for one audience, or `null` to send nothing. */
async function frameFor(
  target: ChannelTarget,
  event: BusEvent,
  deps: DeliveryDeps,
): Promise<FrameFor | null> {
  if (target.audience === 'owner') {
    // A staff-audience kind on an owner channel is a routing bug (LR14).
    if (event.kind === 'bell.changed' || (event.kind === 'typing' && event.from === 'owner')) {
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
    if (event.kind === 'typing') {
      const frame: RealtimeServerFrameWire = {
        type: 'typing',
        thread_id: event.thread_id,
        from: 'school',
      };
      return () => frame;
    }
    const frame: RealtimeServerFrameWire = { type: 'thread.changed', thread_id: event.thread_id };
    return () => frame;
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
  }
}

/**
 * Deliver one bus event to the local sockets in its channel's set. Never throws: every failure
 * ends in `resync` to the sockets it concerns, never in a guess.
 */
export async function deliverEvent(
  target: ChannelTarget,
  event: BusEvent,
  sockets: readonly FrameSocket[],
  everySocket: () => Iterable<FrameSocket>,
  deps: DeliveryDeps,
): Promise<void> {
  if (sockets.length === 0) return;

  let live: MirrorPrincipal[];
  try {
    const seen = new Map<string, MirrorPrincipal>();
    for (const s of sockets) seen.set(principalKey(s.principal), s.principal);
    live = await deps.livePrincipals([...seen.values()]);
  } catch (err) {
    // LR7: deliver nothing, close nothing; every local socket refetches.
    deps.log.warn(
      { err_message: err instanceof Error ? err.message : String(err) },
      'realtime delivery: the liveness check failed; nothing delivered, every socket told to resync',
    );
    for (const s of everySocket()) s.send({ type: 'resync' });
    return;
  }

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

  const inAudience = (s: FrameSocket): boolean =>
    target.audience === 'staff'
      ? s.principal.kind === 'staff'
      : s.principal.kind === 'owner' && s.principal.id === target.ownerId;
  const misplaced = reachable.filter((s) => !inAudience(s));
  if (misplaced.length > 0) {
    deps.log.error(
      { audience: target.audience, sockets: misplaced.length, kind: event.kind },
      "realtime routing fault: a socket outside this channel's audience was in its set; nothing sent to it",
    );
  }
  const audience = reachable.filter(inAudience);
  if (audience.length === 0) return;

  let build: FrameFor | null;
  try {
    build = await frameFor(target, event, deps);
  } catch (err) {
    deps.log.warn(
      { err_message: err instanceof Error ? err.message : String(err), kind: event.kind },
      'realtime delivery: a frame could not be built; its sockets told to resync',
    );
    for (const s of audience) s.send({ type: 'resync' });
    return;
  }
  if (build === null) return;
  for (const s of audience) {
    const frame = build(s);
    if (frame !== null) s.send(frame);
  }
}
