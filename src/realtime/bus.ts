import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { MAX_MESSAGE_SEQ, type MessageReceiptState } from '../contracts/wire.js';
import { env } from '../env.js';
import { redis as sharedRedis } from '../redis.js';
import type { MirrorPrincipal } from '../auth/mirror.js';

/**
 * The realtime bus (9.2.0; design §3 rules 2 and 7, §4 "No silent staleness", A2 FL5, FL6, OL10,
 * brief LR5, LR17): Redis pub/sub between API instances.
 *
 * · **The server picks what a socket hears.** An owner hears `rt:<prefix>:owner:<owners.id>`; a
 *   live staffer (never the system row) hears `rt:<prefix>:staff` (`channelsFor`). There is no
 *   subscribe frame.
 * · **One publish choke point**, `publishForThread(row, event)`: the channels come from the
 *   committed thread row's `owner_id` (`channelsForThread`), and the payload's `owner_id` and
 *   `thread_id` are copied from that row, never from a caller's argument. This file is the
 *   only one allowed to call `.publish(` (ESLint `no-restricted-properties`), and its
 *   publisher connection is never exported.
 * · **Ids only, never content** (H4): a payload is `{v, kind, thread_id, owner_id, …ids}`. No
 *   text, no names, no URLs; each instance builds every frame itself, per audience
 *   (`frames.ts`). The choke point parses every event against the bus schema before it is
 *   published, so this holds at run time, not by TypeScript alone (L2, MB53).
 * · **`live` means vouched for** (FL5): the subscriber is subscribed AND a probe this instance
 *   published came back through it. Until then, and after any publish failure or subscriber
 *   loss, the state is `degraded` and every local socket polls. **Every exit from `degraded`**,
 *   whatever caused it, tells every local socket `resync` and then `live`, once a fresh probe
 *   returns (item 9, MB57; MB23 (9)). **While `live`
 *   it is vouched for again every heartbeat (O-M1, MB54):** a probe that fails or is not heard
 *   back in time is a silent path (half-open: no FIN, no RST), handled as a drop. The publisher
 *   has a command timeout and both connections a TCP keepalive, so no publish hangs forever.
 * · **Total and quiet**: `publishForThread` never throws and never rejects; every listener body
 *   is one `try/catch` (LR5); bus trouble is logged once per state change, never per event
 *   (OL10), at warn, below the pager's level-50 tap.
 */

export type Audience = 'owner' | 'staff';
export type BusState = 'degraded' | 'live';

/** FL6's order: the named override, then Railway's environment name, then `local`. */
export function resolveChannelPrefix(
  source: { REALTIME_CHANNEL_PREFIX?: string; RAILWAY_ENVIRONMENT_NAME?: string } = env,
): string {
  return source.REALTIME_CHANNEL_PREFIX ?? source.RAILWAY_ENVIRONMENT_NAME ?? 'local';
}

export function ownerChannel(prefix: string, ownerId: string): string {
  return `rt:${prefix}:owner:${ownerId}`;
}

export function staffChannel(prefix: string): string {
  return `rt:${prefix}:staff`;
}

function probeChannel(prefix: string, instanceId: string): string {
  return `rt:${prefix}:probe:${instanceId}`;
}

/** `*`, `?`, `[`, `]` and `\` are glob syntax in PSUBSCRIBE: a prefix carrying one would match
 *  other deployments' channels. */
function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
}

/** The instance's one PSUBSCRIBE pattern. */
export function channelPattern(prefix: string): string {
  return `rt:${escapeGlob(prefix)}:*`;
}

/** What a principal's socket hears: derived by the server, never named by the client. */
export function channelsFor(principal: MirrorPrincipal, prefix: string): string[] {
  return principal.kind === 'owner' ? [ownerChannel(prefix, principal.id)] : [staffChannel(prefix)];
}

/** The channels an event about this thread goes to, from the committed row's `owner_id`. */
export function channelsForThread(
  row: { owner_id: string },
  audiences: readonly Audience[],
  prefix: string,
): string[] {
  const channels: string[] = [];
  if (audiences.includes('owner')) channels.push(ownerChannel(prefix, row.owner_id));
  if (audiences.includes('staff')) channels.push(staffChannel(prefix));
  return channels;
}

/** A receipt's step on the bus: the contract's `receipt` frame never carries `sent`. */
export type ReceiptStep = Exclude<MessageReceiptState, 'sent'>;

/** The most message ids one `staff.read` carries (`PostStaffThreadsReadRequest`'s 1–500). */
export const MAX_STAFF_READ_IDS = 500;

/**
 * An event as a caller names it: the thread's ids are added from the row. Ids, integers and
 * one instant only (H4): never text, a name or a URL.
 *   · `message.created`: the message's id and `seq`; every frame is built per audience from the
 *     row (`frames.ts`).
 *   · `receipt`: the messages of `side` (`owner`: the family's; `staff`: the school's) were
 *     `delivered` or `read` up to `up_to_seq`, at `at` (ISO-8601). Heard ONLY by that side.
 *   · `staff.read`: the staffer `staff_id` read these family messages (1–500 ids). Staff only.
 */
export type BusEventInput =
  | { kind: 'typing'; from: 'owner' }
  | { kind: 'typing'; from: 'staff'; staff_id: string }
  | { kind: 'thread.changed' }
  | { kind: 'bell.changed' }
  | { kind: 'message.created'; message_id: string; seq: number }
  | { kind: 'receipt'; side: Audience; state: ReceiptStep; up_to_seq: number; at: string }
  | { kind: 'staff.read'; staff_id: string; message_ids: string[] };

/** An event as it travels: ids only. */
export type BusEvent = BusEventInput & { thread_id: string; owner_id: string };

/** Who may hear each kind. A caller may narrow this (a `thread.changed` for one side), never
 *  widen it: `bell.changed`, `staff.read`, an owner's typing and the school's receipt never go
 *  to an owner channel, and the family's receipt never goes to the staff channel. */
export function audiencesFor(event: BusEventInput): readonly Audience[] {
  switch (event.kind) {
    case 'typing':
      return event.from === 'owner' ? ['staff'] : ['owner', 'staff'];
    case 'thread.changed':
      return ['owner', 'staff'];
    case 'bell.changed':
      return ['staff'];
    case 'message.created':
      return ['owner', 'staff'];
    case 'receipt':
      return [event.side];
    case 'staff.read':
      return ['staff'];
  }
}

const uuid = z.string().uuid();
const seq = z.number().int().min(0).max(MAX_MESSAGE_SEQ);
const busEventSchema = z.union([
  z
    .object({
      v: z.literal(1),
      kind: z.literal('typing'),
      thread_id: uuid,
      owner_id: uuid,
      from: z.literal('owner'),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      kind: z.literal('typing'),
      thread_id: uuid,
      owner_id: uuid,
      from: z.literal('staff'),
      staff_id: uuid,
    })
    .strict(),
  z
    .object({ v: z.literal(1), kind: z.literal('thread.changed'), thread_id: uuid, owner_id: uuid })
    .strict(),
  z
    .object({ v: z.literal(1), kind: z.literal('bell.changed'), thread_id: uuid, owner_id: uuid })
    .strict(),
  z
    .object({
      v: z.literal(1),
      kind: z.literal('message.created'),
      thread_id: uuid,
      owner_id: uuid,
      message_id: uuid,
      seq,
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      kind: z.literal('receipt'),
      thread_id: uuid,
      owner_id: uuid,
      side: z.enum(['owner', 'staff']),
      state: z.enum(['delivered', 'read']),
      up_to_seq: seq,
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      kind: z.literal('staff.read'),
      thread_id: uuid,
      owner_id: uuid,
      staff_id: uuid,
      message_ids: z.array(uuid).min(1).max(MAX_STAFF_READ_IDS),
    })
    .strict(),
]);

/** The kinds `busEventSchema` knows, for L2's error line (a kind outside it is logged as
 *  `unknown`, never echoed). */
const BUS_KINDS: ReadonlySet<string> = new Set<BusEventInput['kind']>([
  'typing',
  'thread.changed',
  'bell.changed',
  'message.created',
  'receipt',
  'staff.read',
]);

const probeSchema = z
  .object({ v: z.literal(1), kind: z.literal('probe'), instance: z.string(), nonce: z.string() })
  .strict();

/** Which audience a channel is, read back from its name. */
export type ChannelTarget = { audience: 'owner'; ownerId: string } | { audience: 'staff' };

function parseChannel(prefix: string, channel: string): ChannelTarget | { probe: string } | null {
  const root = `rt:${prefix}:`;
  if (!channel.startsWith(root)) return null;
  const rest = channel.slice(root.length);
  if (rest === 'staff') return { audience: 'staff' };
  if (rest.startsWith('owner:')) {
    const ownerId = rest.slice('owner:'.length);
    return uuid.safeParse(ownerId).success ? { audience: 'owner', ownerId } : null;
  }
  if (rest.startsWith('probe:')) return { probe: rest.slice('probe:'.length) };
  return null;
}

/** What a publishing route holds (`publish.ts`'s `threadPublisherFor`): the bus, and in a bare
 *  test app the recording bus `withTestBus` decorates. */
export interface ThreadPublisher {
  publishForThread(
    row: { id: string; owner_id: string },
    event: BusEventInput,
    only?: readonly Audience[],
  ): void;
}

/** The one publish method the bus needs; an ioredis client satisfies it. */
export interface PublisherLike {
  publish(channel: string, message: string): Promise<unknown>;
  on(event: 'error' | 'ready', listener: (...args: unknown[]) => void): unknown;
  disconnect(): void;
}

export interface BusHandlers {
  /** A parsed event for a channel this instance hears. Called synchronously from the
   *  subscriber's listener; the handler must not throw (the hub queues the delivery). */
  onEvent(target: ChannelTarget, event: BusEvent): void;
  /** The state changed (`degraded` ↔ `live`). */
  onState(state: BusState): void;
  /** Events may have been missed: called on every exit from `degraded`, immediately before
   *  `onState('live')` (item 9, MB57). */
  onResync(): void;
}

export interface BusOptions {
  prefix: string;
  log: FastifyBaseLogger;
  /** The client the bus duplicates its two connections from. Default: the shared client
   *  (`src/redis.ts`), whose `lazyConnect: true` and `maxRetriesPerRequest: 1` each duplicate
   *  inherits unless overridden (FL6). */
  base?: Redis;
  instanceId?: string;
  /** Test seam: the publisher (default `base.duplicate({maxRetriesPerRequest: 1, commandTimeout,
   *  keepAlive})`). */
  createPublisher?: (base: Redis) => PublisherLike;
  /** The subscriber's reconnect backoff (default: 200 ms a try, capped at 2 s). */
  retryStrategy?: (times: number) => number | null;
  /** How long a probe may take before another is sent while `degraded` (default 1 s). */
  probeRetryMs?: number;
  /** O-M1 (MB54): while `live`, a probe every this often (default 25 s, the socket heartbeat). */
  liveProbeMs?: number;
  /** O-M1: how long a heartbeat probe may take to come back before the instance is `degraded`
   *  and the subscriber reconnects, as on a drop (default 5 s). */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_RETRY_MS = 1000;
const DEFAULT_LIVE_PROBE_MS = 25_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** O-M1: a publish that has not settled in this long rejects (and turns the instance
 *  `degraded`), so a silent path never holds a publish forever. Publisher only: the subscriber
 *  waits on messages, and its liveness is the heartbeat probe's to judge. */
const PUBLISH_TIMEOUT_MS = 5_000;
/** O-M1: TCP keepalive's first probe after this much idle time, on both connections (ioredis's
 *  default 0 leaves the OS default, about 2 h on Linux). */
const KEEPALIVE_MS = 10_000;

function subscriberBackoff(times: number): number {
  return Math.min(times * 200, 2000);
}

function errSummary(err: unknown): Record<string, unknown> {
  return err instanceof Error ? { err_message: err.message } : { err_message: String(err) };
}

export class RealtimeBus implements ThreadPublisher {
  readonly prefix: string;
  readonly instanceId: string;
  private readonly log: FastifyBaseLogger;
  private state: BusState = 'degraded';
  private publisher: PublisherLike | undefined;
  private subscriber: Redis | undefined;
  private started = false;
  private stopped = false;
  private subscribed = false;
  private subscriberFailing = false;
  private publisherFailing = false;
  private pendingProbe: string | undefined;
  private probeTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: BusOptions,
    private readonly handlers: BusHandlers,
  ) {
    this.prefix = opts.prefix;
    this.instanceId = opts.instanceId ?? randomUUID();
    this.log = opts.log;
  }

  get current(): BusState {
    return this.state;
  }

  /** Open the two connections. Idempotent; the API calls it after `listen` (`index.ts`). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const base = this.opts.base ?? sharedRedis;

    const publisher = (
      this.opts.createPublisher ??
      ((b: Redis) =>
        b.duplicate({
          maxRetriesPerRequest: 1,
          commandTimeout: PUBLISH_TIMEOUT_MS,
          keepAlive: KEEPALIVE_MS,
        }))
    )(base);
    this.publisher = publisher;
    // LR17: without a listener ioredis prints "[ioredis] Unhandled error event" on every
    // reconnect attempt. Once per state change, at warn.
    publisher.on('error', (err) => {
      try {
        if (this.publisherFailing || this.stopped) return;
        this.publisherFailing = true;
        this.log.warn(
          errSummary(err),
          'realtime publisher: Redis connection error (logged once until it recovers)',
        );
      } catch {
        // a listener body never throws (LR5)
      }
    });
    publisher.on('ready', () => {
      try {
        if (!this.publisherFailing) return;
        this.publisherFailing = false;
        this.log.info('realtime publisher: Redis connection back');
      } catch {
        // a listener body never throws (LR5)
      }
    });

    // FL6: its own connection, connecting now, never giving up on a command, with a capped
    // backoff. Resubscribed by hand on every `ready`, so the probe follows the PSUBSCRIBE.
    const subscriber = base.duplicate({
      lazyConnect: false,
      maxRetriesPerRequest: null,
      keepAlive: KEEPALIVE_MS,
      autoResubscribe: false,
      retryStrategy: this.opts.retryStrategy ?? subscriberBackoff,
    });
    this.subscriber = subscriber;
    subscriber.on('error', (err: unknown) => {
      try {
        if (this.subscriberFailing || this.stopped) return;
        this.subscriberFailing = true;
        this.log.warn(
          errSummary(err),
          'realtime subscriber: Redis connection error (logged once until it recovers)',
        );
      } catch {
        // a listener body never throws (LR5)
      }
    });
    subscriber.on('ready', () => {
      try {
        this.onSubscriberReady();
      } catch (err) {
        this.quietWarn(err, 'realtime subscriber: ready handler failed');
      }
    });
    subscriber.on('close', () => {
      try {
        if (this.stopped) return;
        this.subscribed = false;
        this.pendingProbe = undefined;
        this.setState('degraded', 'subscriber connection lost');
      } catch (err) {
        this.quietWarn(err, 'realtime subscriber: close handler failed');
      }
    });
    subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      // LR5: one try/catch per event; a bad payload never escapes into ioredis's parser.
      try {
        this.onMessage(channel, message);
      } catch (err) {
        this.quietWarn(err, 'realtime bus: an event could not be handled and was dropped');
      }
    });
  }

  /**
   * Publish an event about one thread. Total: never throws, never rejects. A failure turns the
   * instance `degraded` (one warn line per state change) and re-probes.
   *
   * **L2 (MB53): what is published is parsed first**, against the same `.strict()` schema every
   * receiving instance parses with. TypeScript does not look inside a spread, so a call site that
   * spreads a row into its event would otherwise put message text on Redis, and every instance
   * would then drop the event as "no known shape". A non-conforming event is never published:
   * one error line here (a code bug at the call site; it pages once, at the source), naming its
   * kind and its key names, never a value.
   */
  publishForThread(
    row: { id: string; owner_id: string },
    event: BusEventInput,
    only?: readonly Audience[],
  ): void {
    try {
      const parsed = busEventSchema.safeParse({
        v: 1,
        ...event,
        thread_id: row.id,
        owner_id: row.owner_id,
      });
      if (!parsed.success) {
        this.refuse(event, row);
        return;
      }
      const allowed = audiencesFor(event);
      const audiences = only === undefined ? allowed : allowed.filter((a) => only.includes(a));
      const payload = JSON.stringify(parsed.data);
      for (const channel of channelsForThread(row, audiences, this.prefix)) {
        this.send(channel, payload);
      }
    } catch (err) {
      this.publishFailed(err);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    try {
      this.publisher?.disconnect();
    } catch {
      // closing anyway
    }
    try {
      this.subscriber?.disconnect();
    } catch {
      // closing anyway
    }
  }

  private send(
    channel: string,
    payload: string,
    failed: (err: unknown) => void = (err) => this.publishFailed(err),
  ): void {
    const publisher = this.publisher;
    if (publisher === undefined || this.stopped) {
      failed(new Error('realtime bus not started'));
      return;
    }
    try {
      publisher.publish(channel, payload).then(undefined, (err: unknown) => {
        failed(err);
      });
    } catch (err) {
      failed(err);
    }
  }

  /** L2: one error line for an event that failed the bus schema; no value is logged. */
  private refuse(event: BusEventInput, row: { id: string }): void {
    const kind: unknown = (event as { kind?: unknown }).kind;
    this.log.error(
      {
        kind: typeof kind === 'string' && BUS_KINDS.has(kind) ? kind : 'unknown',
        thread_id: row.id,
        keys: Object.keys(event).sort(),
      },
      'realtime bus: an event that did not pass the bus schema was not published (ids only, never content: a code bug at its call site)',
    );
  }

  private publishFailed(err: unknown): void {
    try {
      if (this.stopped) return;
      if (this.state === 'live') {
        this.setState('degraded', 'publish failed', err);
        this.scheduleProbe();
      }
      // Already degraded: silent (OL10); the probe loop is running.
    } catch {
      // never throws (publish is total)
    }
  }

  private onSubscriberReady(): void {
    if (this.stopped || this.subscriber === undefined) return;
    if (this.subscriberFailing) {
      this.subscriberFailing = false;
      this.log.info('realtime subscriber: Redis connection back');
    }
    // A reconnect's `resync` is sent on the way to `live` (`setState`, item 9), once the probe
    // has come back through this subscription.
    this.subscriber.psubscribe(channelPattern(this.prefix)).then(
      () => {
        if (this.stopped) return;
        this.subscribed = true;
        this.probe();
      },
      (err: unknown) => {
        this.quietWarn(err, 'realtime subscriber: PSUBSCRIBE failed; retried on reconnect');
      },
    );
  }

  /**
   * Send a probe on this instance's own channel. While `degraded`, one that does not come back
   * is sent again (FL5). **While `live` it is the heartbeat (O-M1, MB54):** one that fails to
   * publish, or is not heard back within `probeTimeoutMs`, means the path has gone silent, and
   * is handled exactly as a drop (`heartbeatLost`).
   */
  private probe(): void {
    if (this.stopped || !this.subscribed) return;
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    const nonce = randomUUID();
    this.pendingProbe = nonce;
    const heartbeat = this.state === 'live';
    this.send(
      probeChannel(this.prefix, this.instanceId),
      JSON.stringify({ v: 1, kind: 'probe', instance: this.instanceId, nonce }),
      heartbeat ? (err) => this.heartbeatLost(nonce, err) : undefined,
    );
    this.probeTimer = setTimeout(
      () => {
        try {
          if (this.pendingProbe !== nonce) return; // it came back
          if (heartbeat) this.heartbeatLost(nonce);
          else if (this.state === 'degraded') this.probe();
        } catch (err) {
          this.quietWarn(err, 'realtime bus: probe retry failed');
        }
      },
      heartbeat
        ? (this.opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
        : (this.opts.probeRetryMs ?? DEFAULT_PROBE_RETRY_MS),
    );
    this.probeTimer.unref();
  }

  /** O-M1: while `live`, the next heartbeat probe in `liveProbeMs`. */
  private scheduleHeartbeat(): void {
    if (this.stopped) return;
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      try {
        if (this.state === 'live') this.probe();
      } catch (err) {
        this.quietWarn(err, 'realtime bus: heartbeat probe failed');
      }
    }, this.opts.liveProbeMs ?? DEFAULT_LIVE_PROBE_MS);
    this.probeTimer.unref();
  }

  /**
   * O-M1: a heartbeat probe failed or never came back, so the path is silent (half-open: no
   * FIN, no RST, so no `close` will come). As on a drop: `degraded` now (every local socket
   * polls), and the subscriber is made to reconnect; its `ready` re-subscribes and probes, and
   * `resync` then `live` follow only once a probe comes back (FL5, item 9).
   */
  private heartbeatLost(nonce: string, err?: unknown): void {
    try {
      if (this.stopped || this.pendingProbe !== nonce) return;
      this.pendingProbe = undefined;
      if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
      this.subscribed = false;
      this.setState('degraded', 'a heartbeat probe did not come back', err);
      this.subscriber?.disconnect(true);
    } catch (caught) {
      this.quietWarn(caught, 'realtime bus: a lost heartbeat could not be handled');
    }
  }

  private scheduleProbe(): void {
    if (this.stopped) return;
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      try {
        this.probe();
      } catch (err) {
        this.quietWarn(err, 'realtime bus: probe failed');
      }
    }, this.opts.probeRetryMs ?? DEFAULT_PROBE_RETRY_MS);
    this.probeTimer.unref();
  }

  private onMessage(channel: string, message: string): void {
    if (this.stopped) return;
    const target = parseChannel(this.prefix, channel);
    if (target === null) return;
    let body: unknown;
    try {
      body = JSON.parse(message);
    } catch {
      this.log.warn(
        { channel_kind: 'audience' in target ? target.audience : 'probe' },
        'realtime bus: a payload that is not JSON was dropped',
      );
      return;
    }
    if ('probe' in target) {
      if (target.probe !== this.instanceId) return; // another instance's probe
      const probe = probeSchema.safeParse(body);
      if (probe.success && probe.data.nonce === this.pendingProbe) {
        this.pendingProbe = undefined;
        this.setState('live', 'probe returned');
        this.scheduleHeartbeat(); // O-M1: `live` is vouched for again, every heartbeat
      }
      return;
    }
    const parsed = busEventSchema.safeParse(body);
    if (!parsed.success) {
      this.log.warn(
        { channel_kind: target.audience },
        'realtime bus: a payload of no known shape was dropped',
      );
      return;
    }
    const { v: version, ...event } = parsed.data;
    if (version !== 1) return;
    this.handlers.onEvent(target, event);
  }

  private setState(next: BusState, reason: string, err?: unknown): void {
    if (this.state === next) return;
    this.state = next;
    if (next === 'degraded') {
      this.log.warn(
        { reason, ...(err === undefined ? {} : errSummary(err)) },
        'realtime bus degraded: live delivery is not vouched for, sockets poll',
      );
    } else {
      this.log.info({ reason }, 'realtime bus live');
      // Item 9 (MB57; MB23 (9)): EVERY exit from `degraded`, whatever caused it (a subscriber
      // reconnect, a failed publish, a lost heartbeat, boot), tells every local socket `resync`
      // immediately before `live`. A client stops polling on `live`, so it first refetches what
      // was committed while live delivery was not vouched for, with the subscription already
      // proven (the probe came back), so nothing falls between the refetch and the bus.
      this.handlers.onResync();
    }
    this.handlers.onState(next);
  }

  private quietWarn(err: unknown, msg: string): void {
    try {
      this.log.warn(errSummary(err), msg);
    } catch {
      // never throws
    }
  }
}
