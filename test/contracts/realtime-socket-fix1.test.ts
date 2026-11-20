import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { Redis, type RedisOptions } from 'ioredis';
import {
  FakeClock,
  OWNER_B,
  authFrame,
  baseRedis,
  connect,
  devAuthFrame,
  linesMatching,
  pagerLines,
  plantMessage,
  plantThread,
  recordingElement,
  removeOwnerB,
  removeThreads,
  seedOwnerB,
  setStaffExpired,
  signToken,
  sleep,
  startRealtimeApp,
  waitUntil,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { env } from '../../src/env.js';
import { REALTIME_CLOSE_CODES } from '../../src/contracts/wire.js';
import {
  channelPattern,
  ownerChannel,
  staffChannel,
  type Audience,
  type BusEventInput,
  type PublisherLike,
} from '../../src/realtime/bus.js';
import { deliveredAckSink } from '../../src/realtime/delivered.js';
import type { MessageElementFor } from '../../src/realtime/frames.js';

/**
 * O-MSG-LIVE socket fix 1 (MB53): the Fable socket-layer seat's findings, each pinned here.
 *   · M1: the client frames' thread ids are lower-cased, so the ack limit, the coalescing and
 *     the typing relay see one spelling of a thread.
 *   · L1: liveness is checked at the send, after the frame is built (OM2: "closes every socket
 *     whose principal is missing, then delivers").
 *   · L2: `publishForThread` parses what it publishes; a non-conforming event is never published.
 *   · L3: one event's delivery is bounded, so a hung build cannot stall every family's frames.
 *   · N4: a token `exp` past a Node timer's 2^31-1 ms does not close the socket at once.
 *   · m2, m8, m4: the seat's surviving mutants (Q2's highest seq moved; `only` never widens; the
 *     owner-typing arm of the owner channel's routing fault).
 *   · MB54 (the Opus seat): O-M1, a Redis path that goes silent while `live` is found by a
 *     heartbeat probe, a hung publish times out, both connections keep alive; O-N1, a dev-arm
 *     re-auth keeps the token's `exp`.
 * Every case is a real server, a real bus on the suite's Redis (its own prefix) and real
 * sockets, except m8's, whose publisher records the channels and sends nothing.
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const DONAVAN = FIXTURE_IDS.staffDonavanId;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;
const RACHEL = FIXTURE_IDS.staffRachelId;
const RACHEL_UID = FIXTURE_IDS.staffRachelSupabaseUid;
const HER = { kind: 'owner', id: A } as const;
const SCHOOL = { kind: 'staff', id: DONAVAN } as const;

async function authed(url: string, uid: string, token?: string): Promise<RtClient> {
  const signed = token ?? (await signToken(uid));
  const client = await connect(url, (c) => c.send(authFrame(signed)));
  await client.waitForType('ready');
  return client;
}

function letterPositions(id: string): number[] {
  return [...id].map((ch, i) => (/[a-f]/.test(ch) ? i : -1)).filter((i) => i >= 0);
}

/** A planted thread of A's whose id has at least `letters` hex letters (2^letters spellings). */
async function letteredThread(letters: number): Promise<string> {
  for (;;) {
    const t = await plantThread(A);
    if (letterPositions(t).length >= letters) return t;
    await removeThreads([t]);
  }
}

/** `count` distinct spellings of `id` that differ only in letter case, none of them `id`. */
function caseSpellings(id: string, count: number): string[] {
  const letters = letterPositions(id);
  const out: string[] = [];
  for (let mask = 1; out.length < count; mask++) {
    assert.ok(mask < 2 ** letters.length, 'enough letters for the spellings');
    const chars = [...id];
    letters.forEach((pos, bit) => {
      if ((mask >> bit) & 1) chars[pos] = chars[pos]!.toUpperCase();
    });
    out.push(chars.join(''));
  }
  return out;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(err: Error): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A test that ends before the gate is used must not leave a rejection unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

// ---- M1: one spelling of a thread ----------------------------------------------------------------

test("M1 (typing): a family's typing naming her thread in upper case reaches staff with the thread's canonical, lower-case id", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await letteredThread(1);
  try {
    const upper = t.toUpperCase();
    assert.notEqual(upper, t);
    a.send({ type: 'typing', thread_id: upper });
    const typing = await donavan.waitForType('typing');
    assert.deepEqual(typing, { type: 'typing', thread_id: t, from: 'owner' });
    assert.equal(a.closeCode(), undefined);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('M1 (ack): 300 acks for ONE thread in one burst, each in a different letter case, are one thread: one hand-on to the real sink at once, the rest coalesced to one more a second later with the highest, both under the canonical id; the socket stays open', async () => {
  const clock = new FakeClock();
  const calls: Array<{ threadId: string; upToSeq: number }> = [];
  let settled = 0;
  const rt = await startRealtimeApp({
    clock,
    startBus: true,
    onAck: async (principal, threadId, upToSeq, publisher) => {
      calls.push({ threadId, upToSeq });
      try {
        await deliveredAckSink(principal, threadId, upToSeq, publisher);
      } finally {
        settled += 1;
      }
    },
  });
  const a = await authed(rt.url, A_UID);
  const t = await letteredThread(9);
  try {
    await plantMessage(t, SCHOOL);
    await plantMessage(t, SCHOOL);
    const spellings = caseSpellings(t, 300);
    assert.equal(new Set(spellings).size, 300);
    spellings.forEach((s, i) =>
      a.send({ type: 'ack', thread_id: s, up_to_seq: i === 150 ? 2 : 1 }),
    );
    await sleep(1000); // real time for 300 frames; the injected clock has not moved
    assert.deepEqual(
      calls,
      [{ threadId: t, upToSeq: 1 }],
      'one hand-on at once, under the canonical id (the seat saw 300 in 440 ms)',
    );
    await waitUntil(() => (settled === calls.length ? true : undefined), 5000, 'the hand-on');
    clock.advance(1000);
    await waitUntil(() => (calls.length >= 2 ? true : undefined), 3000, 'the coalesced hand-on');
    await sleep(300);
    assert.deepEqual(
      calls,
      [
        { threadId: t, upToSeq: 1 },
        { threadId: t, upToSeq: 2 },
      ],
      'one more a second later, with the highest of the burst',
    );
    assert.equal(a.closeCode(), undefined);
    assert.equal(linesMatching(rt.logs, /failed its check/).length, 0);
  } finally {
    a.end();
    await rt.close();
    // Never throws here: a red run reports its assertion, not this wait.
    await waitUntil(() => (settled === calls.length ? true : undefined), 10_000, 'the sink').catch(
      () => undefined,
    );
    await removeThreads([t]);
  }
});

// ---- L1: liveness at the send ----------------------------------------------------------------------

test('L1: a staffer removed while a message.created frame is being built (800 ms) gets nothing and closes 4403, because liveness is checked after the build; a live colleague hears it', async () => {
  const clock = new FakeClock(); // the heartbeat is frozen: only delivery's own check can catch her
  const rt = await startRealtimeApp({
    clock,
    startBus: true,
    messageElement: recordingElement([], 800),
  });
  const rachel = await authed(rt.url, RACHEL_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const m = await plantMessage(t, HER);
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      { kind: 'message.created', message_id: m.id, seq: m.seq },
      ['staff'],
    );
    await sleep(250); // the element is being built
    await setStaffExpired(RACHEL, true);
    const frame = await donavan.waitForType('message.created', 3000);
    assert.equal(frame.thread_id, t);
    assert.equal(await rachel.waitClosed(), REALTIME_CLOSE_CODES.forbidden);
    assert.equal(rachel.ofType('message.created').length, 0, 'the removed staffer got nothing');
  } finally {
    await setStaffExpired(RACHEL, false);
    rachel.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

// ---- L2: the choke point parses ---------------------------------------------------------------------

test("L2: publishForThread parses at the choke point: a spread row's text never reaches Redis, nothing of a non-conforming event is published, one error line each names no content; a conforming event still flows", async () => {
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement() });
  const spy = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const seen: Array<{ channel: string; message: string }> = [];
  await spy.psubscribe(channelPattern(rt.hub.prefix));
  spy.on('pmessage', (_pattern: string, channel: string, message: string) => {
    seen.push({ channel, message });
  });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const m = await plantMessage(t, SCHOOL);
    // What a careless call site could write: a row spread into the event. TypeScript's excess
    // property check does not look inside a spread.
    const row = { text: 'FIX1-SECRET the vet called about Biscuit', sender_name: 'Amber' };
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      { kind: 'message.created', message_id: m.id, seq: m.seq, ...row },
    );
    // A field one step off: a receipt whose `at` is the raw Postgres string.
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      {
        kind: 'receipt',
        side: 'staff',
        state: 'delivered',
        up_to_seq: 1,
        at: '2026-11-19 16:52:00.1+00',
      },
    );
    await sleep(1000);
    const events = seen.filter((s) => !s.channel.includes(':probe:'));
    assert.deepEqual(events, [], 'nothing of either event reached Redis');
    const errors = linesMatching(rt.logs, /did not pass the bus schema/, 50);
    assert.equal(errors.length, 2, 'one error line per refused event');
    assert.deepEqual(
      errors.map((e) => e.kind),
      ['message.created', 'receipt'],
    );
    assert.ok(!JSON.stringify(rt.logs.lines).includes('FIX1-SECRET'), 'nor is the text logged');
    assert.equal(linesMatching(rt.logs, /no known shape/).length, 0, 'no instance had to drop it');
    assert.equal(rt.hub.busState(), 'live', 'a code bug is not bus trouble');
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      { kind: 'message.created', message_id: m.id, seq: m.seq },
    );
    await a.waitForType('message.created');
    await donavan.waitForType('message.created');
  } finally {
    spy.disconnect();
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

// ---- L3: one event's delivery is bounded --------------------------------------------------------------

test("L3: a frame build that hangs in A's thread is bounded: its sockets are told `resync` and the queue moves on, so B's and staff's later frames arrive; the hung build's late answer sends nothing and its late failure is caught", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown): void => {
    unhandled.push(err);
  };
  process.on('unhandledRejection', onUnhandled);
  const gates = { owner: deferred(), staff: deferred() };
  const base = recordingElement();
  const element: MessageElementFor = async (row, audience) => {
    await gates[audience].promise;
    return base(row, audience);
  };
  const rt = await startRealtimeApp({
    startBus: true,
    messageElement: element,
    limits: { deliveryBoundMs: 400 },
  });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const m = await plantMessage(t, SCHOOL);
    const started = Date.now();
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      { kind: 'message.created', message_id: m.id, seq: m.seq },
    );
    await sleep(100);
    rt.hub.bus.publishForThread(
      { id: OWNER_B.threadId, owner_id: OWNER_B.id },
      { kind: 'thread.changed' },
    );
    await b.waitForType('thread.changed', 3000);
    await donavan.waitFor(
      (f) => f.type === 'thread.changed' && f.thread_id === OWNER_B.threadId,
      3000,
    );
    const elapsed = Date.now() - started;
    // Two hung deliveries (A's channel, the staff channel) are each cut at 400 ms.
    assert.ok(elapsed < 2000, `B and staff heard theirs in ${elapsed} ms`);
    await a.waitForType('resync');
    await donavan.waitForType('resync');
    assert.deepEqual(a.ofType('resync'), [{ type: 'resync' }]);
    assert.deepEqual(donavan.ofType('resync'), [{ type: 'resync' }]);
    assert.equal(b.ofType('resync').length, 0, "B is not told to refetch for A's event");
    assert.equal(rt.hub.busState(), 'live');
    // The hung builds end late: one answers, one throws. Neither sends anything.
    gates.owner.resolve();
    gates.staff.reject(new Error('fix1: the hung build fails late'));
    await sleep(600);
    for (const c of [a, b, donavan]) assert.equal(c.ofType('message.created').length, 0);
    assert.deepEqual(unhandled, []);
    assert.equal(linesMatching(rt.logs, /within its bound/, 40).length, 2, 'one warn line each');
    assert.deepEqual(pagerLines(rt.logs), []);
    // The queue is free: the next event is delivered at once.
    rt.hub.bus.publishForThread({ id: t, owner_id: A }, { kind: 'thread.changed' });
    await a.waitForType('thread.changed', 1000);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    gates.owner.resolve();
    gates.staff.resolve();
    a.end();
    b.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

// ---- N4: a token exp past a Node timer's range ----------------------------------------------------------

test("N4: a token whose exp is 30 days out (past a Node timer's 2^31-1 ms) keeps its socket open; it is not closed 4401 at once", async () => {
  const rt = await startRealtimeApp(); // the system clock: Node's own timers
  try {
    const expSeconds = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const a = await authed(rt.url, A_UID, await signToken(A_UID, { expSeconds }));
    await sleep(500);
    assert.equal(a.closeCode(), undefined);
    a.send({ type: 'ping' });
    await a.waitForType('pong');
    a.end();
  } finally {
    await rt.close();
  }
});

test('N4: with the injected clock, a 30-day exp is still kept: open after 2^31-1 ms (the longest timer), 4401 at the exp', async () => {
  const clock = new FakeClock();
  const LONG = 40 * 86_400_000;
  const rt = await startRealtimeApp({ clock, limits: { heartbeatMs: LONG, idleMs: LONG } });
  try {
    const expSeconds = Math.floor(clock.now() / 1000) + 30 * 86_400;
    const a = await authed(rt.url, A_UID, await signToken(A_UID, { expSeconds }));
    await sleep(200);
    clock.advance(2 ** 31 - 1);
    await sleep(300);
    assert.equal(a.closeCode(), undefined, 'still open once the longest timer has run');
    clock.advance(expSeconds * 1000 - clock.now() - 10);
    await sleep(300);
    assert.equal(a.closeCode(), undefined, 'still open 10 ms before the exp');
    clock.advance(20);
    assert.equal(await a.waitClosed(), REALTIME_CLOSE_CODES.token_invalid);
  } finally {
    await rt.close();
  }
});

// ---- the seat's surviving mutants --------------------------------------------------------------------

test("Q2 (m2): her ack of 7, with the school's highest message at 6 and her own at 7, sends staff one receipt `delivered` whose up_to_seq is 6, the highest seq moved, not the ack's", async () => {
  const rt = await startRealtimeApp({ startBus: true, onAck: deliveredAckSink });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const school = [];
    for (let i = 0; i < 6; i++) school.push(await plantMessage(t, SCHOOL));
    const mine = await plantMessage(t, HER);
    assert.deepEqual(
      [...school, mine].map((m) => m.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
    a.send({ type: 'ack', thread_id: t, up_to_seq: 7 });
    const receipt = await donavan.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    assert.equal(receipt.state, 'delivered');
    assert.equal(receipt.up_to_seq, 6);
    await sleep(400);
    assert.equal(donavan.ofType('receipt').length, 1);
    assert.equal(a.ofType('receipt').length, 0);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test("`only` never widens (m8): the publisher's channels for a staff-only kind asked for the owner, each side's receipt asked for the other, and her typing asked for both: no owner channel, and never the other side's", async () => {
  const sent: string[] = [];
  const recording: PublisherLike = {
    publish: async (channel: string) => {
      sent.push(channel);
      return 0;
    },
    on: () => undefined,
    disconnect: () => undefined,
  };
  const rt = await startRealtimeApp({
    startBus: true,
    waitLive: false,
    bus: { createPublisher: () => recording },
  });
  try {
    const prefix = rt.hub.prefix;
    const row = { id: FIXTURE_IDS.thread1Id, owner_id: A };
    const own = ownerChannel(prefix, A);
    const staff = staffChannel(prefix);
    const at = new Date().toISOString();
    const cases: Array<[string, BusEventInput, readonly Audience[], string[]]> = [
      ['bell.changed asked for the owner', { kind: 'bell.changed' }, ['owner'], []],
      [
        'staff.read asked for both',
        { kind: 'staff.read', staff_id: DONAVAN, message_ids: [FIXTURE_IDS.thread1Id] },
        ['owner', 'staff'],
        [staff],
      ],
      [
        "the school's receipt asked for the owner",
        { kind: 'receipt', side: 'staff', state: 'read', up_to_seq: 1, at },
        ['owner'],
        [],
      ],
      [
        "the family's receipt asked for staff",
        { kind: 'receipt', side: 'owner', state: 'read', up_to_seq: 1, at },
        ['staff'],
        [],
      ],
      [
        'her own typing asked for both',
        { kind: 'typing', from: 'owner' },
        ['owner', 'staff'],
        [staff],
      ],
      ['control: thread.changed narrowed to her', { kind: 'thread.changed' }, ['owner'], [own]],
      [
        'control: thread.changed for both',
        { kind: 'thread.changed' },
        ['owner', 'staff'],
        [own, staff],
      ],
    ];
    for (const [label, event, only, expected] of cases) {
      sent.length = 0;
      rt.hub.bus.publishForThread(row, event, only);
      assert.deepEqual(
        sent.filter((c) => !c.includes(':probe:')),
        expected,
        label,
      );
    }
  } finally {
    await rt.close();
  }
});

test("m4: her own typing forged onto her owner channel reaches her as nothing (never 'the school is typing'), with one error line; the school's typing still reaches her", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const raw = baseRedis(env.REDIS_URL);
  const t = await plantThread(A);
  try {
    const forged = JSON.stringify({
      v: 1,
      kind: 'typing',
      from: 'owner',
      thread_id: t,
      owner_id: A,
    });
    // A raw PUBLISH, as a routing bug elsewhere would send it (`call`: the lint rule keeps
    // meaning "only bus.ts publishes" for product code).
    await raw.call('PUBLISH', ownerChannel(rt.hub.prefix, A), forged);
    await sleep(800);
    assert.equal(a.ofType('typing').length, 0);
    assert.equal(
      linesMatching(rt.logs, /a staff-audience event arrived on an owner channel/, 50).length,
      1,
    );
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      { kind: 'typing', from: 'staff', staff_id: DONAVAN },
    );
    const typing = await a.waitForType('typing');
    assert.deepEqual(typing, { type: 'typing', thread_id: t, from: 'school' });
  } finally {
    raw.disconnect();
    a.end();
    await rt.close();
    await removeThreads([t]);
  }
});

// ---- MB54 O-M1: a Redis path that goes silent while `live` -------------------------------------------

function watchEscapes(): { seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const record = (e: unknown): void => {
    seen.push(e);
  };
  process.on('unhandledRejection', record);
  process.on('uncaughtException', record);
  return {
    seen,
    stop() {
      process.off('unhandledRejection', record);
      process.off('uncaughtException', record);
    },
  };
}

/** A TCP proxy in front of the suite's Redis (its own ephemeral port) that can FREEZE: stop
 *  forwarding both ways while keeping every socket open (a half-open path: no FIN, no RST), and
 *  THAW: forward again, including what was buffered. The Opus seat's P1 proxy, with a thaw. */
async function startFreezableProxy(): Promise<{
  url: string;
  freeze(): void;
  thaw(): void;
  close(): Promise<void>;
}> {
  const target = new URL(env.REDIS_URL);
  const host = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname;
  const port = Number(target.port || 6379);
  const pairs: Array<[net.Socket, net.Socket]> = [];
  let frozen = false;
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    pairs.push([client, upstream]);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
    if (frozen) {
      client.pause();
      upstream.pause();
      return;
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${address.port}${target.pathname}`,
    freeze() {
      frozen = true;
      for (const [client, upstream] of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    thaw() {
      frozen = false;
      for (const [client, upstream] of pairs) {
        if (client.destroyed || upstream.destroyed) continue;
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        upstream.resume();
      }
    },
    async close() {
      for (const [client, upstream] of pairs) {
        client.destroy();
        upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function types(c: RtClient): string[] {
  return c.frames.map((f) => String(f.type));
}

test("O-M1 (the Opus seat's P1): a Redis path that goes silent (no FIN, no RST) while `live` is found by the heartbeat probe: the instance's sockets get `degraded` within the heartbeat plus the probe's timeout; on thaw, `resync`, then `live`, and events flow again; nothing escapes", async () => {
  const escapes = watchEscapes();
  const proxy = await startFreezableProxy();
  const xBase = baseRedis(proxy.url);
  const x = await startRealtimeApp({
    startBus: true,
    bus: { base: xBase, probeRetryMs: 200, liveProbeMs: 500, probeTimeoutMs: 1000 },
  });
  const y = await startRealtimeApp({ startBus: true }); // the same prefix, Redis direct
  const owner = await authed(x.url, A_UID);
  const row = { id: FIXTURE_IDS.thread1Id, owner_id: A };
  try {
    y.hub.bus.publishForThread(row, { kind: 'thread.changed' });
    await owner.waitForType('thread.changed', 5000);
    await sleep(1500); // heartbeat probes that come back change nothing
    assert.equal(x.hub.busState(), 'live');
    assert.deepEqual(types(owner), ['ready', 'thread.changed']);

    proxy.freeze();
    const t0 = Date.now();
    y.hub.bus.publishForThread(row, { kind: 'thread.changed' });
    await owner.waitForType('degraded', 4000);
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed <= 2500,
      `degraded ${elapsed} ms after the freeze (heartbeat 500 + timeout 1000)`,
    );
    assert.equal(x.hub.busState(), 'degraded');
    await sleep(2500); // the deaf subscriber is torn down (ioredis's 2 s disconnect timeout)

    proxy.thaw();
    await owner.waitForType('live', 15_000);
    assert.deepEqual(
      types(owner),
      ['ready', 'thread.changed', 'degraded', 'resync', 'live'],
      'degraded, then resync, then live; the event lost in the freeze is never replayed',
    );
    assert.equal(x.hub.busState(), 'live');
    y.hub.bus.publishForThread(row, { kind: 'thread.changed' });
    await waitUntil(
      () => (owner.ofType('thread.changed').length === 2 ? true : undefined),
      5000,
      'the next event through the thawed path',
    );
    assert.deepEqual(escapes.seen, [], 'nothing escapes');
    assert.deepEqual(pagerLines(x.logs), []);
  } finally {
    escapes.stop();
    owner.end();
    await x.close();
    await y.close();
    await proxy.close();
    xBase.disconnect();
  }
});

test('O-M1: a publish on a frozen path rejects at the publisher command timeout (5 s) and degrades the instance (heartbeat probe out of the way); on thaw it is `live` again; nothing escapes', async () => {
  const escapes = watchEscapes();
  const proxy = await startFreezableProxy();
  const xBase = baseRedis(proxy.url);
  const x = await startRealtimeApp({
    startBus: true,
    bus: { base: xBase, probeRetryMs: 200, liveProbeMs: 120_000 },
  });
  const owner = await authed(x.url, A_UID);
  const row = { id: FIXTURE_IDS.thread1Id, owner_id: A };
  try {
    proxy.freeze();
    const t0 = Date.now();
    x.hub.bus.publishForThread(row, { kind: 'thread.changed' });
    await owner.waitForType('degraded', 9000);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 4000, `degraded by the command timeout, ${elapsed} ms after the publish`);
    assert.equal(x.hub.busState(), 'degraded');
    proxy.thaw();
    await owner.waitForType('live', 15_000);
    assert.deepEqual(escapes.seen, [], 'nothing escapes');
  } finally {
    escapes.stop();
    owner.end();
    await x.close();
    await proxy.close();
    xBase.disconnect();
  }
});

test('O-M1: both bus connections are opened with an explicit TCP keepAlive delay, and the publisher with a command timeout', async () => {
  const real = baseRedis(env.REDIS_URL);
  const made: Array<Partial<RedisOptions>> = [];
  const duplicate = real.duplicate.bind(real);
  real.duplicate = (override?: Partial<RedisOptions>) => {
    made.push({ ...override });
    return duplicate(override);
  };
  const rt = await startRealtimeApp({ startBus: true, bus: { base: real } });
  try {
    assert.equal(made.length, 2, 'a publisher and a subscriber');
    const subscriber = made.find((o) => o.lazyConnect === false);
    const publisher = made.find((o) => o !== subscriber);
    assert.ok(subscriber !== undefined && publisher !== undefined);
    for (const o of [publisher, subscriber]) {
      assert.ok(
        typeof o.keepAlive === 'number' && o.keepAlive > 0,
        `keepAlive ${String(o.keepAlive)}`,
      );
    }
    assert.ok(
      typeof publisher.commandTimeout === 'number' && publisher.commandTimeout > 0,
      `commandTimeout ${String(publisher.commandTimeout)}`,
    );
    assert.equal(
      subscriber.commandTimeout,
      undefined,
      'never on the subscriber: it waits on messages',
    );
  } finally {
    await rt.close();
    real.disconnect();
  }
});

// ---- MB54 O-N1: a dev-arm re-auth keeps the token's exp ----------------------------------------------

test("O-N1: where the bypass is on, a token socket that re-auths on the dev arm as itself keeps its token's exp: 4401 at the exp (injected clock)", async () => {
  const clock = new FakeClock();
  const LONG = 40 * 86_400_000;
  const rt = await startRealtimeApp({ clock, limits: { heartbeatMs: LONG, idleMs: LONG } });
  try {
    const expSeconds = Math.floor(clock.now() / 1000) + 60;
    const a = await authed(rt.url, A_UID, await signToken(A_UID, { expSeconds }));
    await sleep(200);
    const before = types(a); // `ready` (and `degraded`: this app's bus is not started)
    a.send(devAuthFrame(`owner:${A}`));
    await sleep(300);
    assert.equal(a.closeCode(), undefined, 'the dev re-auth as itself is accepted');
    assert.deepEqual(types(a), before, 'and gets no frame (CR15)');
    clock.advance(expSeconds * 1000 - clock.now() - 10);
    await sleep(300);
    assert.equal(a.closeCode(), undefined, 'open 10 ms before the exp');
    clock.advance(20);
    assert.equal(await a.waitClosed(), REALTIME_CLOSE_CODES.token_invalid);
  } finally {
    await rt.close();
  }
});

// ---- MB57 item 9: every exit from `degraded` sends `resync` before `live` ---------------------------

test('item 9 (MB57; MB23 (9)): one ordinary publish fails (no subscriber drop), then the bus heals: every socket gets `degraded`, then `resync`, then `live`, in that order, and events flow again', async () => {
  // One event's publish fails: `thread.changed` goes out on two channels (hers and staff's), so
  // the next two non-probe channel publishes are refused, and nothing after them.
  let failNext = 0;
  let failed = 0;
  const rt = await startRealtimeApp({
    startBus: true,
    bus: {
      probeRetryMs: 200,
      createPublisher: (base): PublisherLike => {
        const real = base.duplicate({ maxRetriesPerRequest: 1 });
        return {
          publish: (channel, message) => {
            if (failNext > 0 && !channel.includes(':probe:')) {
              failNext -= 1;
              failed += 1;
              return Promise.reject(new Error('fix1 item 9: one publish refused'));
            }
            return real.call('PUBLISH', channel, message);
          },
          on: (event, listener) => real.on(event, listener),
          disconnect: () => real.disconnect(),
        };
      },
    },
  });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const row = { id: FIXTURE_IDS.thread1Id, owner_id: A };
  try {
    failNext = 2;
    rt.hub.bus.publishForThread(row, { kind: 'thread.changed' });
    await a.waitForType('live', 5000);
    await donavan.waitForType('live', 5000);
    await sleep(300);
    assert.equal(failed, 2, "exactly one event's publish failed, on both its channels");
    for (const c of [a, donavan]) {
      assert.deepEqual(types(c), ['ready', 'degraded', 'resync', 'live']);
    }
    assert.equal(rt.hub.busState(), 'live');
    rt.hub.bus.publishForThread(row, { kind: 'thread.changed' });
    await a.waitForType('thread.changed');
    await donavan.waitForType('thread.changed');
  } finally {
    a.end();
    donavan.end();
    await rt.close();
  }
});

test('item 9 (MB57): the first exit from `degraded` at boot also sends `resync` before `live` to a socket that connected while the bus was not yet vouched for', async () => {
  const gate = deferred();
  const rt = await startRealtimeApp({
    startBus: true,
    waitLive: false,
    bus: {
      probeRetryMs: 200,
      createPublisher: (base): PublisherLike => {
        const real = base.duplicate({ maxRetriesPerRequest: 1 });
        return {
          publish: (channel, message) =>
            gate.promise.then(() => real.call('PUBLISH', channel, message)),
          on: (event, listener) => real.on(event, listener),
          disconnect: () => real.disconnect(),
        };
      },
    },
  });
  try {
    const a = await authed(rt.url, A_UID);
    await sleep(300);
    assert.equal(rt.hub.busState(), 'degraded');
    assert.deepEqual(types(a), ['ready', 'degraded']);
    gate.resolve();
    await a.waitForType('live', 5000);
    await sleep(300);
    assert.deepEqual(types(a), ['ready', 'degraded', 'resync', 'live']);
    a.end();
  } finally {
    gate.resolve();
    await rt.close();
  }
});
