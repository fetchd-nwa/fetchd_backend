import fastifyWebsocket from '@fastify/websocket';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import {
  MAX_MESSAGE_SEQ,
  REALTIME_CLIENT_FRAME_TYPES,
  REALTIME_CLOSE_CODES,
  REALTIME_PROTOCOL_VERSION,
  type RealtimeClientFrameWire,
  type RealtimeCloseCode,
  type RealtimeServerFrameWire,
} from '../contracts/wire.js';
import { bypassHeaderEnabled } from '../env.js';
import { verifyAccessToken, type VerifiedToken } from '../auth/jwks.js';
import { resolvePrincipal, resolvePrincipalById, type MirrorPrincipal } from '../auth/mirror.js';
import { parseDevPrincipal } from '../auth/plugin.js';
import type { Principal } from '../auth/principal.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import {
  RealtimeBus,
  channelsFor,
  ownerChannel,
  resolveChannelPrefix,
  staffChannel,
  type BusEvent,
  type BusOptions,
  type BusState,
  type ChannelTarget,
  type ThreadPublisher,
} from './bus.js';
import {
  defaultDeliveryDeps,
  deliverEvent,
  threadOwnerOf,
  type DeliveryDeps,
  type FrameSocket,
  type MessageElementFor,
} from './frames.js';

/**
 * `GET /realtime` (9.2.0; the contract's route doc on `RealtimeClientFrameWire`; design §3 rules
 * 1–6 as A2 amends them; brief LR5, LR6, LR9, LR13, CR4, CR15, CR43, MB13's rulings).
 *
 * **Auth is the first frame**, within 5 s (else 4408): nothing is sent to a socket before it.
 *   · `protocol` must be `REALTIME_PROTOCOL_VERSION`, else 4426.
 *   · The token arm verifies exactly as an HTTP bearer: the HTTP `verify`, then
 *     `resolvePrincipal` (no row: 4403).
 *   · The `dev_principal` arm exists only while `bypassHeaderEnabled` (`src/env.ts`, forced off
 *     under `NODE_ENV=production`) is on; with it off the frame is an auth with no token, 4401
 *     (MB13). It goes through `parseDevPrincipal`, the `X-Dev-Principal` grammar (bad grammar:
 *     4401).
 *   · **Both arms end in `resolvePrincipalById`** (OM5): a null answer (an expired row, the
 *     system row) is 4403. The socket records the ROW's role; a dev header claiming another role
 *     is 4403 (MB13).
 *   · A malformed `auth` frame is 4401. Any other frame before auth is dropped unanswered.
 *   · A re-`auth` must resolve to the same row with the same role (else 4403; a bad token 4401)
 *     and gets no reply (CR15). At the token's `exp` with no new token: 4401.
 * **After `ready`** (sent only once the socket is registered, so nothing published after it is
 * missed, OL4): `.strict()` frames over `REALTIME_CLIENT_FRAME_TYPES`. A malformed frame, a
 * malformed id, an out-of-range `up_to_seq` or a failed thread check is dropped silently, logged
 * at warn, and counted; three in a minute close 4403 (CR4). `typing` and `ack` each re-resolve
 * the principal before the thread check (as HTTP checks it). `typing` is relayed at most once a
 * second; `ack` is coalesced to the highest `up_to_seq` per thread, at most one a second, and
 * handed to the injected `onAck` with the bus (`buildApp()` wires *Delivered* there,
 * `delivered.ts`; this file writes no SQL for it). There is no default sink: a hub without one
 * is refused at construction (MB27 Q6).
 * **Timers:** every 25 s the principal is re-resolved by id (gone or role changed: 4403; the
 * read throwing: 1011, FH1-b); 60 s with no inbound frame ends the socket (`terminate()`, LR13).
 * **Limits:** frames ≤ 16 KB (1009); 5 sockets per family, 20 per staffer, the next evicting the
 * oldest (4429); 200 unauthenticated per instance (1013).
 * **Never fatal (LR5):** listeners are attached before anything else and every listener and
 * timer body is caught; a socket `error` is a warn line; anything unexpected closes that one
 * socket 1011.
 * **Shutdown (LR9):** the plugin's `preClose` stops upgrades, sends 1012 to every socket and
 * `terminate()`s any still open after 1 s, so `app.close()` never waits on a silent phone.
 */

/** The subset of a `ws` WebSocket this file uses (the plugin's socket type is untyped here). */
interface RtSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
}

const WS_OPEN = 1;

export interface RealtimeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: RealtimeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface RealtimeLimits {
  authTimeoutMs: number;
  heartbeatMs: number;
  idleMs: number;
  maxFrameBytes: number;
  ownerSockets: number;
  staffSockets: number;
  unauthenticatedSockets: number;
  failedChecks: number;
  failedCheckWindowMs: number;
  typingIntervalMs: number;
  ackIntervalMs: number;
  closeGraceMs: number;
}

export const REALTIME_LIMITS: Readonly<RealtimeLimits> = {
  authTimeoutMs: 5_000,
  heartbeatMs: 25_000,
  idleMs: 60_000,
  maxFrameBytes: 16 * 1024,
  ownerSockets: 5,
  staffSockets: 20,
  unauthenticatedSockets: 200,
  failedChecks: 3,
  failedCheckWindowMs: 60_000,
  typingIntervalMs: 1_000,
  ackIntervalMs: 1_000,
  closeGraceMs: 1_000,
};

/** Where an `ack` that passed its checks goes, with the bus to publish its `receipt` on. The
 *  serving app's is `delivered.ts`'s `deliveredAckSink`. */
export type AckSink = (
  principal: MirrorPrincipal,
  threadId: string,
  upToSeq: number,
  publisher: ThreadPublisher,
) => void | Promise<void>;

export interface RealtimeOptions {
  verify?: (token: string) => Promise<VerifiedToken>;
  resolve?: (supabaseUid: string) => Promise<Principal | null>;
  resolveById?: (ref: { kind: 'owner' | 'staff'; id: string }) => Promise<MirrorPrincipal | null>;
  /** Default: `bypassHeaderEnabled` from `src/env.ts`. */
  bypassEnabled?: boolean;
  /** The owner's thread check, as `GET /threads/:id/messages` runs it. */
  ownsThread?: (threadId: string, ownerId: string) => Promise<boolean>;
  /** The staff thread check (a live thread, as `existsLive`), returning its `owner_id`. */
  threadOwner?: (threadId: string) => Promise<string | null>;
  delivery?: Partial<Omit<DeliveryDeps, 'log' | 'messageElement'>>;
  /** Required, with no default (MB27 Q6; memory "prove the alarm channel"): a hub without an
   *  ack sink is refused at construction, never a silent no-op. */
  onAck: AckSink;
  /** The `message.created` element builder (`frames.ts`). No default: without one a hub builds
   *  no `message.created` frame, and `threadPublisherFor` refuses to hand it to a route. */
  messageElement?: MessageElementFor;
  clock?: RealtimeClock;
  limits?: Partial<RealtimeLimits>;
  bus?: Partial<Omit<BusOptions, 'log'>>;
  log?: FastifyBaseLogger;
}

const threadIdSchema = z.string().uuid();
const AUTH_FRAME = z.union([
  z
    .object({
      type: z.literal('auth'),
      protocol: z.literal(REALTIME_PROTOCOL_VERSION),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('auth'),
      protocol: z.literal(REALTIME_PROTOCOL_VERSION),
      dev_principal: z.string().min(1).max(200),
    })
    .strict(),
]);

type ClientFrameType = (typeof REALTIME_CLIENT_FRAME_TYPES)[number];

/** One `.strict()` schema per member of `REALTIME_CLIENT_FRAME_TYPES` (a missing one does not
 *  compile). CR4's bounds: ids are uuids, `up_to_seq` an integer from 0 to `MAX_MESSAGE_SEQ`. */
const FRAME_SCHEMAS = {
  auth: AUTH_FRAME,
  typing: z.object({ type: z.literal('typing'), thread_id: threadIdSchema }).strict(),
  ack: z
    .object({
      type: z.literal('ack'),
      thread_id: threadIdSchema,
      up_to_seq: z.number().int().min(0).max(MAX_MESSAGE_SEQ),
    })
    .strict(),
  ping: z.object({ type: z.literal('ping') }).strict(),
} satisfies Record<ClientFrameType, z.ZodTypeAny>;

function parseClientFrame(value: unknown): RealtimeClientFrameWire | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  if (!(REALTIME_CLIENT_FRAME_TYPES as readonly string[]).includes(type)) return null;
  const parsed = FRAME_SCHEMAS[type as ClientFrameType].safeParse(value);
  return parsed.success ? (parsed.data as RealtimeClientFrameWire) : null;
}

function asText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data as Buffer[]).toString('utf8');
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

function expiryOf(token: string): number | undefined {
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type AuthOutcome =
  | { row: MirrorPrincipal; expiresAt: number | undefined }
  | { close: RealtimeCloseCode };

class Connection implements FrameSocket {
  state: 'unauthenticated' | 'authenticated' | 'closed' = 'unauthenticated';
  private row: MirrorPrincipal | undefined;
  private queue: Promise<void> = Promise.resolve();
  private authTimer: unknown;
  private heartbeatTimer: unknown;
  private expiryTimer: unknown;
  private idleTimer: unknown;
  private expiresAt: number | undefined;
  private failures: number[] = [];
  private lastTypingAt: number | undefined;
  private readonly ackPending = new Map<string, number>();
  private readonly ackLastFlush = new Map<string, number>();
  private readonly ackTimers = new Map<string, unknown>();

  constructor(
    private readonly hub: Hub,
    private readonly ws: RtSocket,
  ) {}

  get principal(): MirrorPrincipal {
    if (this.row === undefined)
      throw new Error('realtime: an unauthenticated socket has no principal');
    return this.row;
  }

  get authenticated(): boolean {
    return this.state === 'authenticated';
  }

  // ---- socket events (each body caught: LR5) --------------------------------------------------

  onMessage(data: unknown, isBinary: boolean): void {
    try {
      this.touch();
      const text = isBinary ? null : asText(data);
      this.enqueue(() => this.handle(text));
    } catch (err) {
      this.fault(err, 'message listener');
    }
  }

  onSocketClosed(): void {
    try {
      this.finish();
    } catch {
      // never throws
    }
  }

  onSocketError(err: unknown): void {
    try {
      this.hub.log.warn(
        { err_message: errMessage(err) },
        'realtime socket error (the socket is closed by ws)',
      );
    } catch {
      // never throws
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  armAuthTimeout(): void {
    this.authTimer = this.timer(this.hub.limits.authTimeoutMs, () => {
      if (this.state === 'unauthenticated') this.close(REALTIME_CLOSE_CODES.auth_timeout);
    });
  }

  send(frame: RealtimeServerFrameWire): void {
    if (this.state !== 'authenticated' || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.hub.log.warn({ err_message: errMessage(err) }, 'realtime: a frame could not be written');
    }
  }

  close(code: RealtimeCloseCode): void {
    if (this.state === 'closed') return;
    this.finish();
    try {
      this.ws.close(code);
    } catch {
      // the socket is gone already
    }
  }

  terminate(): void {
    if (this.state === 'closed') return;
    this.finish();
    try {
      this.ws.terminate();
    } catch {
      // the socket is gone already
    }
  }

  /** Unregister and stop every timer; idempotent. */
  private finish(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.hub.unregister(this);
    for (const handle of [this.authTimer, this.heartbeatTimer, this.expiryTimer, this.idleTimer]) {
      if (handle !== undefined) this.hub.clock.clearTimeout(handle);
    }
    for (const handle of this.ackTimers.values()) this.hub.clock.clearTimeout(handle);
    this.ackTimers.clear();
  }

  private timer(ms: number, fn: () => void): unknown {
    return this.hub.clock.setTimeout(() => {
      try {
        fn();
      } catch (err) {
        this.fault(err, 'timer');
      }
    }, ms);
  }

  /** LR13: any inbound frame restarts the 60 s silence clock. */
  private touch(): void {
    if (this.idleTimer !== undefined) this.hub.clock.clearTimeout(this.idleTimer);
    this.idleTimer = this.timer(this.hub.limits.idleMs, () => {
      this.terminate();
    });
  }

  /** Frames of one socket are handled in order; a failure closes that socket 1011. */
  private enqueue(work: () => Promise<void> | void): void {
    this.queue = this.queue.then(work).then(undefined, (err: unknown) => {
      this.fault(err, 'frame handler');
    });
  }

  private fault(err: unknown, where: string): void {
    try {
      this.hub.log.warn(
        { where, err_message: errMessage(err) },
        'realtime: closing one socket 1011 after an unexpected failure',
      );
      this.close(REALTIME_CLOSE_CODES.server_error);
    } catch {
      // never throws
    }
  }

  // ---- frames ----------------------------------------------------------------------------------

  private async handle(text: string | null): Promise<void> {
    if (this.state === 'closed') return;
    let value: unknown;
    if (text !== null) {
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
    }
    const isAuth =
      typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'auth';
    if (this.state === 'unauthenticated') {
      // Nothing but `auth` is read before auth; anything else waits out the 5 s (4408).
      if (isAuth) await this.authenticateFirst(value as Record<string, unknown>);
      return;
    }
    if (isAuth) {
      await this.reauthenticate(value as Record<string, unknown>);
      return;
    }
    const frame = parseClientFrame(value);
    if (frame === null) {
      this.failedCheck('malformed frame');
      return;
    }
    switch (frame.type) {
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'typing':
        await this.onTyping(frame.thread_id);
        return;
      case 'ack':
        await this.onAck(frame.thread_id, frame.up_to_seq);
        return;
      case 'auth':
        return; // routed above
    }
  }

  private async verifyAuth(value: Record<string, unknown>): Promise<AuthOutcome> {
    if (value.protocol !== REALTIME_PROTOCOL_VERSION) {
      return { close: REALTIME_CLOSE_CODES.unknown_protocol };
    }
    const parsed = AUTH_FRAME.safeParse(value);
    if (!parsed.success) return { close: REALTIME_CLOSE_CODES.token_invalid };
    const deps = this.hub.deps;
    if ('token' in parsed.data) {
      const token = parsed.data.token;
      let sub: string;
      try {
        sub = (await deps.verify(token)).sub;
      } catch {
        return { close: REALTIME_CLOSE_CODES.token_invalid };
      }
      const principal = await deps.resolve(sub);
      if (principal === null) return { close: REALTIME_CLOSE_CODES.forbidden };
      const row = await deps.resolveById(
        principal.kind === 'owner'
          ? { kind: 'owner', id: principal.ownerId }
          : { kind: 'staff', id: principal.staffId },
      );
      if (row === null) return { close: REALTIME_CLOSE_CODES.forbidden };
      return { row, expiresAt: expiryOf(token) };
    }
    // The dev arm: only while the bypass is on (never under production, `env.ts`).
    if (!deps.bypassEnabled) return { close: REALTIME_CLOSE_CODES.token_invalid };
    let claimed: Principal;
    try {
      claimed = parseDevPrincipal(parsed.data.dev_principal);
    } catch {
      return { close: REALTIME_CLOSE_CODES.token_invalid };
    }
    const row = await deps.resolveById(
      claimed.kind === 'owner'
        ? { kind: 'owner', id: claimed.ownerId }
        : { kind: 'staff', id: claimed.staffId },
    );
    if (row === null) return { close: REALTIME_CLOSE_CODES.forbidden };
    if (claimed.kind === 'staff' && row.kind === 'staff' && claimed.role !== row.role) {
      return { close: REALTIME_CLOSE_CODES.forbidden };
    }
    return { row, expiresAt: undefined };
  }

  private async authenticateFirst(value: Record<string, unknown>): Promise<void> {
    const outcome = await this.verifyAuth(value);
    if (this.state !== 'unauthenticated') return; // timed out or closed meanwhile
    if ('close' in outcome) {
      this.close(outcome.close);
      return;
    }
    this.row = outcome.row;
    this.expiresAt = outcome.expiresAt;
    if (this.authTimer !== undefined) this.hub.clock.clearTimeout(this.authTimer);
    this.state = 'authenticated';
    // OL4: registered BEFORE `ready`, so nothing published after `ready` is missed.
    this.hub.admit(this);
    this.send({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION });
    if (this.hub.bus.current === 'degraded') this.send({ type: 'degraded' });
    this.armHeartbeat();
    this.armExpiry();
  }

  private async reauthenticate(value: Record<string, unknown>): Promise<void> {
    const outcome = await this.verifyAuth(value);
    if (this.state !== 'authenticated') return;
    if ('close' in outcome) {
      this.close(outcome.close);
      return;
    }
    if (!this.sameRow(outcome.row)) {
      this.close(REALTIME_CLOSE_CODES.forbidden);
      return;
    }
    // CR15: a valid re-auth gets no frame; it moves the expiry.
    this.expiresAt = outcome.expiresAt;
    this.armExpiry();
  }

  private sameRow(row: MirrorPrincipal): boolean {
    const mine = this.principal;
    if (row.kind !== mine.kind || row.id !== mine.id) return false;
    return !(row.kind === 'staff' && mine.kind === 'staff' && row.role !== mine.role);
  }

  private armHeartbeat(): void {
    this.heartbeatTimer = this.timer(this.hub.limits.heartbeatMs, () => {
      this.enqueue(async () => {
        if (this.state !== 'authenticated') return;
        if (await this.recheck()) this.armHeartbeat();
      });
    });
  }

  private armExpiry(): void {
    if (this.expiryTimer !== undefined) this.hub.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.expiresAt === undefined) return;
    const wait = Math.max(0, this.expiresAt - this.hub.clock.now());
    this.expiryTimer = this.timer(wait, () => {
      if (this.state === 'authenticated') this.close(REALTIME_CLOSE_CODES.token_invalid);
    });
  }

  /** Re-resolve by mirror row id (OM5). Gone or role changed: 4403. The read throwing: 1011. */
  private async recheck(): Promise<boolean> {
    const mine = this.principal;
    let row: MirrorPrincipal | null;
    try {
      row = await this.hub.deps.resolveById({ kind: mine.kind, id: mine.id });
    } catch (err) {
      this.hub.log.warn(
        { err_message: errMessage(err), kind: mine.kind, id: mine.id },
        'realtime: the principal read failed; closing that socket 1011',
      );
      this.close(REALTIME_CLOSE_CODES.server_error);
      return false;
    }
    if (this.state !== 'authenticated') return false;
    if (row === null || !this.sameRow(row)) {
      this.close(REALTIME_CLOSE_CODES.forbidden);
      return false;
    }
    return true;
  }

  /** The thread check, as HTTP runs it; returns the thread's `owner_id`, or `null`. */
  private async threadCheck(threadId: string): Promise<string | null> {
    const mine = this.principal;
    if (mine.kind === 'owner') {
      return (await this.hub.deps.ownsThread(threadId, mine.id)) ? mine.id : null;
    }
    return this.hub.deps.threadOwner(threadId);
  }

  private failedCheck(reason: string): void {
    const now = this.hub.clock.now();
    const windowMs = this.hub.limits.failedCheckWindowMs;
    this.failures = this.failures.filter((at) => now - at < windowMs);
    this.failures.push(now);
    const mine = this.row;
    this.hub.log.warn(
      { reason, kind: mine?.kind, id: mine?.id, in_window: this.failures.length },
      'realtime: a client frame failed its check and was dropped',
    );
    if (this.failures.length >= this.hub.limits.failedChecks) {
      this.close(REALTIME_CLOSE_CODES.forbidden);
    }
  }

  private async onTyping(threadId: string): Promise<void> {
    const now = this.hub.clock.now();
    if (
      this.lastTypingAt !== undefined &&
      now - this.lastTypingAt < this.hub.limits.typingIntervalMs
    ) {
      return; // relayed at most once a second per socket
    }
    this.lastTypingAt = now;
    if (!(await this.recheck())) return;
    const ownerId = await this.threadCheck(threadId);
    if (this.state !== 'authenticated') return;
    if (ownerId === null) {
      this.failedCheck('thread check');
      return;
    }
    const mine = this.principal;
    this.hub.bus.publishForThread(
      { id: threadId, owner_id: ownerId },
      mine.kind === 'owner'
        ? { kind: 'typing', from: 'owner' }
        : { kind: 'typing', from: 'staff', staff_id: mine.id },
    );
  }

  private async onAck(threadId: string, upToSeq: number): Promise<void> {
    const pending = this.ackPending.get(threadId);
    if (pending === undefined || upToSeq > pending) this.ackPending.set(threadId, upToSeq);
    if (this.ackTimers.has(threadId)) return; // a flush is already scheduled
    const last = this.ackLastFlush.get(threadId);
    const wait =
      last === undefined
        ? 0
        : Math.max(0, last + this.hub.limits.ackIntervalMs - this.hub.clock.now());
    if (wait === 0) {
      await this.flushAck(threadId);
      return;
    }
    this.ackTimers.set(
      threadId,
      this.timer(wait, () => {
        this.ackTimers.delete(threadId);
        this.enqueue(() => this.flushAck(threadId));
      }),
    );
  }

  private async flushAck(threadId: string): Promise<void> {
    const upToSeq = this.ackPending.get(threadId);
    if (upToSeq === undefined || this.state !== 'authenticated') return;
    this.ackPending.delete(threadId);
    this.ackLastFlush.set(threadId, this.hub.clock.now());
    if (!(await this.recheck())) return;
    const ownerId = await this.threadCheck(threadId);
    if (this.state !== 'authenticated') return;
    if (ownerId === null) {
      this.failedCheck('thread check');
      return;
    }
    try {
      await this.hub.deps.onAck(this.principal, threadId, upToSeq, this.hub.bus);
    } catch (err) {
      this.hub.log.warn(
        { err_message: errMessage(err), thread_id: threadId },
        'realtime: the ack sink failed',
      );
    }
  }
}

interface HubDeps {
  verify: (token: string) => Promise<VerifiedToken>;
  resolve: (supabaseUid: string) => Promise<Principal | null>;
  resolveById: (ref: { kind: 'owner' | 'staff'; id: string }) => Promise<MirrorPrincipal | null>;
  bypassEnabled: boolean;
  ownsThread: (threadId: string, ownerId: string) => Promise<boolean>;
  threadOwner: (threadId: string) => Promise<string | null>;
  onAck: AckSink;
  delivery: DeliveryDeps;
}

/** What the app exposes as `app.realtime`. */
export interface RealtimeHub {
  readonly prefix: string;
  readonly bus: RealtimeBus;
  /** Whether a `message.created` element builder is wired (`threadPublisherFor` requires it). */
  readonly buildsMessageFrames: boolean;
  /** Open the bus's Redis connections (the API does it after `listen`, `index.ts`). */
  startBus(): void;
  busState(): BusState;
  /** Test introspection: the live registry (mutable on purpose, for LR14's planted case). */
  inspect(): {
    channels: Map<string, Set<FrameSocket>>;
    authenticated: ReadonlySet<FrameSocket>;
    unauthenticated: number;
  };
  /** Stop the bus (an `onClose` hook calls it). */
  stop(): Promise<void>;
}

class Hub implements RealtimeHub {
  readonly prefix: string;
  readonly bus: RealtimeBus;
  readonly buildsMessageFrames: boolean;
  readonly limits: RealtimeLimits;
  readonly clock: RealtimeClock;
  readonly deps: HubDeps;
  closing = false;
  private readonly channels = new Map<string, Set<Connection>>();
  private readonly byPrincipal = new Map<string, Connection[]>();
  private readonly authenticatedSet = new Set<Connection>();
  private readonly unauthenticatedSet = new Set<Connection>();
  private readonly every = new Set<Connection>();
  private deliveries: Promise<void> = Promise.resolve();

  constructor(
    readonly log: FastifyBaseLogger,
    opts: RealtimeOptions,
  ) {
    if (typeof opts.onAck !== 'function') {
      throw new Error(
        'realtime: no ack sink was given. There is no default: buildApp() passes the Delivered ' +
          'stamp (deliveredAckSink); a test app passes its own (MB27 Q6, "prove the alarm channel").',
      );
    }
    this.buildsMessageFrames = opts.messageElement !== undefined;
    this.limits = { ...REALTIME_LIMITS, ...opts.limits };
    this.clock = opts.clock ?? systemClock;
    this.prefix = opts.bus?.prefix ?? resolveChannelPrefix();
    this.deps = {
      verify: opts.verify ?? verifyAccessToken,
      resolve: opts.resolve ?? resolvePrincipal,
      resolveById: opts.resolveById ?? resolvePrincipalById,
      bypassEnabled: opts.bypassEnabled ?? bypassHeaderEnabled,
      ownsThread:
        opts.ownsThread ?? ((threadId, ownerId) => threadsRepository.ownsThread(threadId, ownerId)),
      threadOwner: opts.threadOwner ?? threadOwnerOf,
      onAck: opts.onAck,
      delivery: {
        ...defaultDeliveryDeps,
        ...opts.delivery,
        ...(opts.messageElement === undefined ? {} : { messageElement: opts.messageElement }),
        log,
      },
    };
    this.bus = new RealtimeBus(
      { ...opts.bus, prefix: this.prefix, log },
      {
        onEvent: (target, event) => this.onBusEvent(target, event),
        onState: (state) => this.broadcast({ type: state }),
        onResync: () => this.broadcast({ type: 'resync' }),
      },
    );
  }

  startBus(): void {
    this.bus.start();
  }

  busState(): BusState {
    return this.bus.current;
  }

  inspect(): ReturnType<RealtimeHub['inspect']> {
    return {
      channels: this.channels as Map<string, Set<FrameSocket>>,
      authenticated: this.authenticatedSet,
      unauthenticated: this.unauthenticatedSet.size,
    };
  }

  async stop(): Promise<void> {
    for (const conn of [...this.every]) conn.terminate();
    await this.bus.stop();
  }

  /** The upgrade handler. LR6: listeners first, and nothing here awaits. */
  handleSocket(ws: RtSocket): void {
    const conn = new Connection(this, ws);
    ws.on('message', (data, isBinary) => conn.onMessage(data, isBinary));
    ws.on('close', () => conn.onSocketClosed());
    ws.on('error', (err) => conn.onSocketError(err));
    if (this.closing) {
      conn.close(REALTIME_CLOSE_CODES.server_restart);
      return;
    }
    if (this.unauthenticatedSet.size >= this.limits.unauthenticatedSockets) {
      conn.close(REALTIME_CLOSE_CODES.try_again_later);
      return;
    }
    this.every.add(conn);
    this.unauthenticatedSet.add(conn);
    conn.armAuthTimeout();
  }

  /** A socket that authenticated: the oldest of its principal's over the cap is evicted, then
   *  it is registered in its channels. */
  admit(conn: Connection): void {
    this.unauthenticatedSet.delete(conn);
    const principal = conn.principal;
    const key = `${principal.kind}:${principal.id}`;
    const cap = principal.kind === 'owner' ? this.limits.ownerSockets : this.limits.staffSockets;
    let mine = this.byPrincipal.get(key) ?? [];
    while (mine.length >= cap) {
      const oldest = mine[0]!;
      oldest.close(REALTIME_CLOSE_CODES.evicted);
      const after = this.byPrincipal.get(key) ?? [];
      // `close` unregisters; never loop on a socket that did not leave.
      mine = after[0] === oldest ? after.slice(1) : after;
      this.byPrincipal.set(key, mine);
    }
    this.byPrincipal.set(key, [...mine, conn]);
    this.authenticatedSet.add(conn);
    for (const channel of channelsFor(principal, this.prefix)) {
      let set = this.channels.get(channel);
      if (set === undefined) {
        set = new Set();
        this.channels.set(channel, set);
      }
      set.add(conn);
    }
  }

  unregister(conn: Connection): void {
    this.every.delete(conn);
    this.unauthenticatedSet.delete(conn);
    this.authenticatedSet.delete(conn);
    for (const [channel, set] of this.channels) {
      set.delete(conn);
      if (set.size === 0) this.channels.delete(channel);
    }
    for (const [key, list] of this.byPrincipal) {
      const rest = list.filter((c) => c !== conn);
      if (rest.length === 0) this.byPrincipal.delete(key);
      else if (rest.length !== list.length) this.byPrincipal.set(key, rest);
    }
  }

  /** Every socket still open, for shutdown's 1012 (`preClose`). */
  openConnections(): Connection[] {
    return [...this.every];
  }

  private broadcast(frame: RealtimeServerFrameWire): void {
    for (const conn of this.authenticatedSet) conn.send(frame);
  }

  private onBusEvent(target: ChannelTarget, event: BusEvent): void {
    try {
      const channel =
        target.audience === 'owner'
          ? ownerChannel(this.prefix, target.ownerId)
          : staffChannel(this.prefix);
      const targets = [...(this.channels.get(channel) ?? [])];
      if (targets.length === 0) return;
      this.deliveries = this.deliveries
        .then(() =>
          deliverEvent(target, event, targets, () => this.authenticatedSet, this.deps.delivery),
        )
        .then(undefined, (err: unknown) => {
          this.log.warn({ err_message: errMessage(err) }, 'realtime: a delivery failed');
        });
    } catch (err) {
      this.log.warn({ err_message: errMessage(err) }, 'realtime: an event could not be queued');
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The live channel (9.2.0): `GET /realtime`'s hub and the bus routes publish through. */
    realtime: RealtimeHub;
  }
}

/**
 * Build the hub and decorate `app.realtime` with it (pass 3 item 5). `buildApp()` calls this
 * before any route registers, so a publishing route reads its bus at registration
 * (`publish.ts`), and passes the *Delivered* sink here. A hub with no `onAck` is refused (no
 * default). The socket route is `registerRealtimeRoute`'s.
 */
export function decorateRealtime(app: FastifyInstance, opts: RealtimeOptions): RealtimeHub {
  const hub = new Hub(opts.log ?? app.log, opts);
  app.decorate('realtime', hub);
  return hub;
}

/**
 * Register `@fastify/websocket` and `GET /realtime` on `app` and return the hub it serves. On an
 * app `decorateRealtime` already decorated (`buildApp()`), that hub, and `opts` must be absent;
 * otherwise (a bare test app) it decorates one from `opts` first. The bus is not started here
 * (no Redis connection at build time): the API starts it after `listen`, and a test starts it
 * when it needs one.
 */
export function registerRealtimeRoute(app: FastifyInstance, opts?: RealtimeOptions): RealtimeHub {
  let hub: Hub;
  if (app.hasDecorator('realtime')) {
    if (opts !== undefined) {
      throw new Error(
        'realtime: app.realtime is already decorated; its options belong to decorateRealtime',
      );
    }
    const existing: unknown = app.realtime;
    if (!(existing instanceof Hub)) {
      throw new Error(
        'realtime: app.realtime is not a realtime hub, so GET /realtime cannot serve it',
      );
    }
    hub = existing;
  } else {
    hub = decorateRealtime(app, opts ?? ({} as RealtimeOptions)) as Hub;
  }

  void app.register(fastifyWebsocket, {
    options: { maxPayload: hub.limits.maxFrameBytes },
    // Fires for errors on an established socket (an unclean disconnect, a frame over the
    // limit). The default logs at ERROR, which pages (`server.ts`'s level-50 tap), and
    // terminates. Our own listener already logs at warn and `ws` has already closed the
    // socket, so this stays quiet; a socket still open here means our handler threw: 1011.
    errorHandler: (error, socket) => {
      try {
        hub.log.debug({ err_message: errMessage(error) }, 'realtime: websocket error (handled)');
        const ws = socket as unknown as RtSocket;
        if (ws.readyState === WS_OPEN) ws.close(REALTIME_CLOSE_CODES.server_error);
      } catch {
        // never throws
      }
    },
    // LR9: stop upgrades, 1012 to every socket, `terminate()` whatever is still open after 1 s,
    // so `app.close()` never waits on a phone that does not answer the close.
    preClose: async () => {
      hub.closing = true;
      const wss = app.websocketServer;
      for (const conn of hub.openConnections()) conn.close(REALTIME_CLOSE_CODES.server_restart);
      for (const client of wss.clients) {
        try {
          if (client.readyState === WS_OPEN) client.close(REALTIME_CLOSE_CODES.server_restart);
        } catch {
          // closing anyway
        }
      }
      const deadline = Date.now() + hub.limits.closeGraceMs;
      while (wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // gone already
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  });

  void app.register(async (scope) => {
    scope.get('/realtime', { websocket: true }, (socket) => {
      try {
        hub.handleSocket(socket as unknown as RtSocket);
      } catch (err) {
        hub.log.warn({ err_message: errMessage(err) }, 'realtime: upgrade handler failed');
        try {
          (socket as unknown as RtSocket).close(REALTIME_CLOSE_CODES.server_error);
        } catch {
          // gone already
        }
      }
    });
  });

  app.addHook('onClose', async () => {
    await hub.stop();
  });

  return hub;
}
