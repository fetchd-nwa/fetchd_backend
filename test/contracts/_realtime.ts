import './_realtimePrefix.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { sql } from 'drizzle-orm';
import { env } from '../../src/env.js';
import { makeVerifyAccessToken } from '../../src/auth/jwks.js';
import { registerAuth } from '../../src/auth/plugin.js';
import { db } from '../../src/db/client.js';
import type { MessageWire } from '../../src/contracts/wire.js';
import { pgTimestampToIso } from '../../src/lib/pgTimestamp.js';
import type { Audience, BusEventInput } from '../../src/realtime/bus.js';
import {
  decorateRealtime,
  registerRealtimeRoute,
  type RealtimeClock,
  type RealtimeHub,
  type RealtimeOptions,
} from '../../src/realtime/server.js';
import { makeLogCapture, type LogCapture } from './_harness.js';

/**
 * The realtime suite's helpers (brief "Backend" → test helpers; CR24). Listed in the rt lane's
 * hand-back; nothing here is added to `_harness.ts`.
 *   · `connect` / `RtClient`: a real `ws` client against a real listening server (port 0).
 *   · `signToken` / `testVerify`: JWTs from a local key set, verified by the HTTP verifier
 *     (`makeVerifyAccessToken`), exactly as `test/auth.test.ts` does.
 *   · `FakeClock`: the injected clock for the 5 s / 25 s / 60 s / `exp` timers.
 *   · `startRealtimeApp`: a Fastify app with `GET /realtime` and a captured log.
 *   · `startRedisProxy`: a test-local TCP proxy in front of the shared Redis, closed and reopened
 *     to take Redis "down and back" without ever stopping it; `closedPortUrl` for "down at boot".
 *   · `seedOwnerB` / `removeOwnerB`, `systemRowId`, and the row flips B5 needs.
 */

// ---- the ws client (no @types/ws in this repo: a minimal local type) --------------------------

export interface WsClient {
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number): void;
  terminate(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

type WsConstructor = new (url: string) => WsClient;
const requireCjs = createRequire(import.meta.url);
const WebSocketClient = requireCjs('ws') as WsConstructor;

export type Frame = Record<string, unknown>;

export interface RtClient {
  readonly ws: WsClient;
  readonly frames: Frame[];
  closeCode(): number | undefined;
  send(frame: unknown): void;
  sendRaw(data: string | Buffer): void;
  waitFor(match: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  waitForType(type: string, ms?: number): Promise<Frame>;
  waitClosed(ms?: number): Promise<number>;
  ofType(type: string): Frame[];
  end(): void;
}

function poll<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out after ${ms} ms waiting for ${what}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Open a socket; `onOpen` runs inside the `open` listener (the same tick, LR6-a). */
export function connect(url: string, onOpen?: (client: RtClient) => void): Promise<RtClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketClient(url);
    const frames: Frame[] = [];
    let code: number | undefined;
    const client: RtClient = {
      ws,
      frames,
      closeCode: () => code,
      send: (frame) => ws.send(JSON.stringify(frame)),
      sendRaw: (data) => ws.send(data),
      waitFor: (match, ms = 3000) => poll(() => frames.find(match), ms, 'a matching frame'),
      waitForType: (type, ms = 3000) =>
        poll(() => frames.find((f) => f.type === type), ms, `a '${type}' frame`),
      waitClosed: (ms = 3000) => poll(() => code, ms, 'the socket to close'),
      ofType: (type) => frames.filter((f) => f.type === type),
      end: () => {
        try {
          ws.terminate();
        } catch {
          // gone already
        }
      },
    };
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString('utf8')) as Frame);
    });
    ws.on('close', (closeCode) => {
      code = closeCode;
    });
    ws.on('error', (err) => {
      if (code === undefined && ws.readyState !== 1) reject(err);
    });
    ws.on('open', () => {
      onOpen?.(client);
      resolve(client);
    });
  });
}

/** Wait a fixed time (a negative's window: "hears nothing in N ms"). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- tokens ------------------------------------------------------------------------------------

const KID = 'realtime-test-key';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

/** The HTTP verifier, bound to a local key set instead of Supabase's remote JWKS. */
export const testVerify = makeVerifyAccessToken(createLocalJWKSet({ keys: [jwk] }));

export async function signToken(
  sub: string,
  opts: { expSeconds?: number; extraClaims?: Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(opts.extraClaims ?? {})
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(sub)
    .setAudience(env.SUPABASE_JWT_AUD)
    .setIssuer(env.SUPABASE_JWT_ISS)
    .setIssuedAt(now)
    .setExpirationTime(opts.expSeconds ?? now + 300)
    .sign(privateKey);
}

export function authFrame(token: string): Frame {
  return { type: 'auth', protocol: 1, token };
}

export function devAuthFrame(devPrincipal: string): Frame {
  return { type: 'auth', protocol: 1, dev_principal: devPrincipal };
}

// ---- the injected clock -----------------------------------------------------------------------

export class FakeClock implements RealtimeClock {
  private current: number;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.now()) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.current + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].fn();
    }
    this.current = end;
  }
}

// ---- the app -------------------------------------------------------------------------------------

export interface RealtimeTestApp {
  app: FastifyInstance;
  hub: RealtimeHub;
  url: string;
  logs: LogCapture;
  close(): Promise<void>;
}

/**
 * A listening app (port 0, 127.0.0.1) with `GET /realtime`, a plain `GET /test-http` route, and a
 * log captured at trace. The HTTP verifier on the local key set and the bypass ON are the
 * defaults; every `RealtimeOptions` key can be overridden. `startBus` opens the bus and, unless
 * `waitLive: false`, waits for `live`. The ack sink defaults to a test no-op here, in a test
 * helper only (`src/` has no default: MB27 Q6); a row about acks passes its own or the real one.
 */
export async function startRealtimeApp(
  opts: Partial<RealtimeOptions> & { startBus?: boolean; waitLive?: boolean } = {},
): Promise<RealtimeTestApp> {
  const logs = makeLogCapture();
  const app = Fastify({ logger: { level: 'trace', stream: logs.stream } });
  registerAuth(app);
  app.get('/test-http', async () => ({ ok: true }));
  const { startBus, waitLive, ...realtime } = opts;
  const hub = registerRealtimeRoute(app, {
    verify: testVerify,
    bypassEnabled: true,
    onAck: () => undefined,
    ...realtime,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  if (startBus === true) {
    hub.startBus();
    if (waitLive !== false)
      await poll(() => (hub.busState() === 'live' ? true : undefined), 5000, 'the bus to go live');
  }
  return {
    app,
    hub,
    url: `ws://127.0.0.1:${address.port}/realtime`,
    logs,
    close: () => app.close(),
  };
}

/** Lines at error or above (level ≥ 50: what the pager tap would forward). */
export function pagerLines(logs: LogCapture): Array<Record<string, unknown>> {
  return logs.lines.filter((line) => typeof line.level === 'number' && line.level >= 50);
}

export function linesMatching(
  logs: LogCapture,
  pattern: RegExp,
  level?: number,
): Array<Record<string, unknown>> {
  return logs.lines.filter(
    (line) =>
      typeof line.msg === 'string' &&
      pattern.test(line.msg) &&
      (level === undefined || line.level === level),
  );
}

export function waitUntil<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  return poll(probe, ms, what);
}

// ---- Redis down and back, never stopping Redis (CR24) -------------------------------------------

function redisTarget(): { host: string; port: number; dbIndex: string } {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname,
    port: Number(url.port || 6379),
    dbIndex: url.pathname.replace('/', '') || '0',
  };
}

export interface RedisProxy {
  /** A Redis URL through the proxy, on the suite's db. */
  readonly url: string;
  /** Drop every proxied connection and refuse new ones (Redis "down"). */
  down(): Promise<void>;
  /** Accept again on the same port (Redis "back"). */
  up(): Promise<void>;
  close(): Promise<void>;
}

export async function startRedisProxy(): Promise<RedisProxy> {
  const target = redisTarget();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  const port = await listen(0);
  let listening = true;
  const down = async (): Promise<void> => {
    if (!listening) return;
    listening = false;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await closed;
  };
  return {
    url: `redis://127.0.0.1:${port}/${target.dbIndex}`,
    down,
    up: async () => {
      if (listening) return;
      await listen(port);
      listening = true;
    },
    close: down,
  };
}

/** A Redis URL at a port nothing listens on ("down at boot"). */
export async function closedPortUrl(): Promise<string> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `redis://127.0.0.1:${port}/${redisTarget().dbIndex}`;
}

// ---- child processes ---------------------------------------------------------------------------

/**
 * The COMPLETE environment a test hands a child process: never `...process.env`. PATH, every
 * variable `src/env.ts` requires as a shape-valid placeholder (`test/cors.test.ts` BASE_ENV), and
 * `NODE_ENV=staging`, under which `env.ts` loads no `.env*` file (the backend's `.env` is
 * production). This suite's own pair and prefix are passed by name; `withPrefix: false` leaves
 * the prefix out (CR1's "unset" case). `extra` names anything else (`PORT`,
 * `BYPASS_HEADER_ENABLED`, which staging honours and production never does).
 */
export function childEnv(
  extra: Record<string, string> = {},
  opts: { withPrefix?: boolean } = {},
): Record<string, string> {
  if (new URL(env.DATABASE_URL).port !== '5433') {
    throw new Error('refusing to hand a child a DATABASE_URL that is not the :5433 test container');
  }
  const named: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'staging',
    LOG_LEVEL: 'warn',
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    SUPABASE_JWKS_URL: 'https://project.invalid/auth/v1/.well-known/jwks.json',
    SUPABASE_JWT_AUD: 'authenticated',
    SUPABASE_JWT_ISS: 'https://project.invalid/auth/v1',
    SUPABASE_AUTH_WEBHOOK_SECRET: 'whsec_placeholder',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    SCHEDULER_WEBHOOK_SECRET: 'scheduler_placeholder',
    R2_ACCOUNT_ID: 'placeholder',
    R2_ACCESS_KEY_ID: 'placeholder',
    R2_SECRET_ACCESS_KEY: 'placeholder',
    R2_BUCKET: 'nwa-media-test',
  };
  if (opts.withPrefix !== false && env.REALTIME_CHANNEL_PREFIX !== undefined) {
    named.REALTIME_CHANNEL_PREFIX = env.REALTIME_CHANNEL_PREFIX;
  }
  return { ...named, ...extra };
}

/** A base client shaped like `src/redis.ts`'s (the bus duplicates its connections from it). */
export function baseRedis(url: string): Redis {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on('error', () => {});
  return client;
}

// ---- rows ---------------------------------------------------------------------------------------

/** A second family, the Hendersons, with one thread of their own (owner B in the brief's tests). */
export const OWNER_B = {
  id: 'b0b0b0b0-0000-4000-8000-0000000000b1',
  supabaseUid: 'b0b0b0b0-0000-4000-8000-0000000000b0',
  threadId: 'b0b0b0b0-0000-4000-8000-0000000000c1',
} as const;

export async function seedOwnerB(): Promise<void> {
  await db.execute(sql`
    INSERT INTO owners (id, supabase_uid, name, email)
    VALUES (${OWNER_B.id}, ${OWNER_B.supabaseUid}, 'Hendersons (realtime)', 'realtime-b@example.com')
    ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO threads (id, owner_id, category, title, sub_text)
    VALUES (${OWNER_B.threadId}, ${OWNER_B.id}, 'sessions', 'Realtime B thread', 'with the school')
    ON CONFLICT (id) DO NOTHING`);
}

export async function removeOwnerB(): Promise<void> {
  await db.execute(sql`DELETE FROM threads WHERE owner_id = ${OWNER_B.id}`);
  await db.execute(sql`DELETE FROM owners WHERE id = ${OWNER_B.id}`);
}

/** The school's system row, found by its flag, never by a hard-coded id. */
export async function systemRowId(): Promise<string> {
  const result = await db.execute(
    sql`SELECT id::text AS id FROM staff WHERE is_system_account AND expired_at IS NULL`,
  );
  const rows = result.rows as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error(`expected one live system row, found ${rows.length}`);
  return rows[0]!.id;
}

export async function setStaffExpired(id: string, expired: boolean): Promise<void> {
  await db.execute(
    expired
      ? sql`UPDATE staff SET expired_at = now() WHERE id = ${id}`
      : sql`UPDATE staff SET expired_at = NULL WHERE id = ${id}`,
  );
}

export async function setOwnerExpired(id: string, expired: boolean): Promise<void> {
  await db.execute(
    expired
      ? sql`UPDATE owners SET expired_at = now() WHERE id = ${id}`
      : sql`UPDATE owners SET expired_at = NULL WHERE id = ${id}`,
  );
}

export async function setStaffRole(
  id: string,
  role: 'owner' | 'manager' | 'trainer',
): Promise<void> {
  await db.execute(sql`UPDATE staff SET role = ${role}::staff_role WHERE id = ${id}`);
}

// ---- planted threads and messages (pass 3 phase R) ---------------------------------------------
// Raw inserts, as `seedOwnerB` plants its rows (no route, no `_messaging.ts`). `thread_seq` is
// the trigger's (rs3 M5.29). A planted thread names a participant, so it is never the family's
// one live school thread on its topic (`threads_owner_school_topic_uidx`).

/** A live thread of `ownerId`'s with `participantStaffId` (default Donavan, a trainer). */
export async function plantThread(
  ownerId: string,
  participantStaffId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO threads (id, owner_id, participant_staff_id, category, title, sub_text)
    VALUES (${id}, ${ownerId}, ${participantStaffId}, 'sessions', 'Realtime planted thread', 'phase R')`);
  return id;
}

export type PlantedSender = { kind: 'owner'; id: string } | { kind: 'staff'; id: string };

export interface PlantedMessage {
  id: string;
  seq: number;
}

/** One message in `threadId`; `expired` plants it expired, `deliveredAt` pre-stamps it. */
export async function plantMessage(
  threadId: string,
  sender: PlantedSender,
  opts: { expired?: boolean; deliveredAt?: string } = {},
): Promise<PlantedMessage> {
  const ownerId = sender.kind === 'owner' ? sender.id : null;
  const staffId = sender.kind === 'staff' ? sender.id : null;
  const result = await db.execute(sql`
    INSERT INTO messages (thread_id, sender_kind, sender_owner_id, sender_staff_id, text, expired_at,
                          delivered_at)
    VALUES (${threadId}, ${sender.kind}::sender_kind, ${ownerId}::uuid, ${staffId}::uuid,
            'planted (phase R)', ${opts.expired === true ? sql`now()` : sql`NULL`},
            ${opts.deliveredAt ?? null}::timestamptz)
    RETURNING id::text AS id, thread_seq AS seq`);
  const row = (result.rows as Array<{ id: string; seq: number | string }>)[0]!;
  return { id: row.id, seq: Number(row.seq) };
}

/** Each message's `delivered_at` in ISO-8601 UTC to the millisecond, as `toISOString()` writes
 *  it (both truncate the microseconds), or null. */
export async function deliveredAtOf(ids: readonly string[]): Promise<Map<string, string | null>> {
  const result = await db.execute(sql`
    SELECT id::text AS id,
           to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
      FROM messages WHERE id = ANY(${sql.param([...ids])}::uuid[])`);
  return new Map(
    (result.rows as Array<{ id: string; at: string | null }>).map((r) => [r.id, r.at] as const),
  );
}

/** The database clock now, as an epoch-millisecond number (window bounds come from here). */
export async function dbNowMs(): Promise<number> {
  const result = await db.execute(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`,
  );
  return Number((result.rows as Array<{ ms: number | string }>)[0]!.ms);
}

/** Delete planted threads (their messages cascade). */
export async function removeThreads(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`DELETE FROM threads WHERE id = ANY(${sql.param([...ids])}::uuid[])`);
}

/** What a recording message-element builder was asked for. */
export interface ElementCall {
  messageId: string;
  threadId: string;
  audience: 'owner' | 'staff';
}

/**
 * A recording stand-in for the GET element builder (phase F wires the real one): it answers
 * with the real `MessageWire` shape after a real delay, its `text` naming the audience it was
 * built for, so a test can tell an owner-built element from a staff-built one.
 */
export function recordingElement(
  calls: ElementCall[] = [],
  delayMs = 15,
): (
  row: { id: string; threadId: string; threadSeq: number; sentAt: string },
  audience: 'owner' | 'staff',
) => Promise<MessageWire> {
  return async (row, audience) => {
    calls.push({ messageId: row.id, threadId: row.threadId, audience });
    await sleep(delayMs);
    return {
      id: row.id,
      thread_id: row.threadId,
      sender_id: '00000000-0000-4000-8000-000000000000',
      text: `element for ${audience}`,
      sent_at: pgTimestampToIso(row.sentAt),
      is_read: false,
      seq: row.threadSeq,
    };
  };
}

// ---- item 5: the recording bus a bare test app decorates ---------------------------------------

export interface PublishedEvent {
  row: { id: string; owner_id: string };
  event: BusEventInput;
  only: readonly Audience[] | undefined;
}

/**
 * Decorate a bare test app's `app.realtime` (pass 3 item 5; the one helper, MB27 Q6), as
 * `buildApp()` does, with a hub whose bus RECORDS each publish and sends nothing (it is never
 * started, so no Redis connection). Call it before registering the routes under test, which
 * read their bus at registration (`threadPublisherFor`). Its ack sink is a test no-op and its
 * element builder `recordingElement()`, unless given.
 */
export function withTestBus(
  app: FastifyInstance,
  opts: Partial<RealtimeOptions> = {},
): { hub: RealtimeHub; published: PublishedEvent[] } {
  const hub = decorateRealtime(app, {
    verify: testVerify,
    bypassEnabled: true,
    onAck: () => undefined,
    messageElement: recordingElement(),
    ...opts,
  });
  const published: PublishedEvent[] = [];
  hub.bus.publishForThread = (row, event, only) => {
    published.push({ row, event, only });
  };
  return { hub, published };
}
