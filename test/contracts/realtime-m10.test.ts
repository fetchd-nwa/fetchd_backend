import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { MirrorPrincipal } from '../../src/auth/mirror.js';
import { resolvePrincipalById } from '../../src/auth/mirror.js';
import { livePrincipalsAmong } from '../../src/realtime/frames.js';
import {
  FakeClock,
  OWNER_B,
  connect,
  devAuthFrame,
  plantThread,
  removeOwnerB,
  removeThreads,
  seedOwnerB,
  setOwnerExpired,
  setStaffExpired,
  setStaffRole,
  sleep,
  type RtClient,
} from './_realtime.js';
import { call, devPrincipal, socketFor, startRouteApp } from './_realtimeRoutes.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { removePlantedStaffTraces } from './_messaging.js';

/**
 * MB13 M10, re-run on a REAL `message.created` (pass 3 phase F; split audit M10): the rt lane
 * proved these on a stand-in (`typing`, `thread.changed`), but `message.created` has its own
 * builder (a bound row read and the GET's element), so each runs again here with a real send
 * through its real route: B5 (an expired staffer, an expired owner), OM2, LR7-a, LR16, B16 (two
 * instances), OL4 (server). Stop-rule roads: a removed staffer receiving anything [A]; one family
 * hearing another's [P].
 */

registerFixtureHooks();
before(seedOwnerB);
// A staff send writes a feed row naming the staffer; another family's must go before teardown.
afterEach(removePlantedStaffTraces);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const HER: MirrorPrincipal = { kind: 'owner', id: A };
const B: MirrorPrincipal = { kind: 'owner', id: OWNER_B.id };
const DONAVAN: MirrorPrincipal = { kind: 'staff', id: FIXTURE_IDS.staffDonavanId, role: 'trainer' };
const RACHEL: MirrorPrincipal = { kind: 'staff', id: FIXTURE_IDS.staffRachelId, role: 'trainer' };
const AMBER: MirrorPrincipal = { kind: 'staff', id: FIXTURE_IDS.staffAmberId, role: 'manager' };

function created(client: RtClient, threadId: string): number {
  return client.frames.filter((f) => f.type === 'message.created' && f.thread_id === threadId)
    .length;
}

/** Fire the heartbeat and give its async re-resolve time to land. */
async function heartbeat(clock: FakeClock): Promise<void> {
  clock.advance(25_000);
  await sleep(250);
}

test('M10 B5 [A]: a staffer expired mid-connection closes 4403 within one heartbeat, and a real send after reaches nothing of hers', async () => {
  const clock = new FakeClock();
  const rt = await startRouteApp({ clock });
  const rachel = await socketFor(rt.url, RACHEL);
  const donavan = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    await setStaffExpired(RACHEL.id, true);
    await heartbeat(clock);
    assert.equal(await rachel.waitClosed(), 4403);
    const before = rachel.frames.length;
    const res = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: 'after (B5)' });
    assert.equal(res.statusCode, 201);
    await donavan.waitFor(() => created(donavan, t) === 1);
    await sleep(300);
    assert.equal(rachel.frames.length, before, 'no frame after the close');
  } finally {
    await setStaffExpired(RACHEL.id, false);
    rachel.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('M10 B5 [A, P]: a family expired mid-connection closes 4403 within one heartbeat, and a real staff reply in her thread reaches nothing of hers', async () => {
  const clock = new FakeClock();
  const rt = await startRouteApp({ clock });
  const b = await socketFor(rt.url, B);
  const donavan = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(OWNER_B.id);
  try {
    await setOwnerExpired(OWNER_B.id, true);
    await heartbeat(clock);
    assert.equal(await b.waitClosed(), 4403);
    const before = b.frames.length;
    const res = await call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/messages`, {
      text: 'after (B5 owner)',
    });
    assert.equal(res.statusCode, 201);
    await donavan.waitFor(() => created(donavan, t) === 1);
    await sleep(300);
    assert.equal(b.frames.length, before);
  } finally {
    await setOwnerExpired(OWNER_B.id, false);
    b.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('M10 OM2 [A]: with the heartbeat frozen, a staffer expired 1 ms before a real send does not receive it, and that socket closes 4403', async () => {
  const clock = new FakeClock();
  const rt = await startRouteApp({ clock });
  const rachel = await socketFor(rt.url, RACHEL);
  const donavan = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    await setStaffExpired(RACHEL.id, true);
    await sleep(1);
    const res = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: 'OM2' });
    assert.equal(res.statusCode, 201);
    await donavan.waitFor(() => created(donavan, t) === 1);
    assert.equal(await rachel.waitClosed(), 4403);
    assert.equal(created(rachel, t), 0);
  } finally {
    await setStaffExpired(RACHEL.id, false);
    rachel.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('M10 LR16 [A]: with the heartbeat frozen, a staffer whose role changed 1 ms before a real send does not receive it, and closes 4403', async () => {
  const clock = new FakeClock();
  const rt = await startRouteApp({ clock });
  const donavan = await socketFor(rt.url, DONAVAN);
  const amber = await socketFor(rt.url, AMBER);
  const t = await plantThread(A);
  try {
    await setStaffRole(DONAVAN.id, 'manager');
    await sleep(1);
    const res = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: 'LR16' });
    assert.equal(res.statusCode, 201);
    await amber.waitFor(() => created(amber, t) === 1);
    assert.equal(await donavan.waitClosed(), 4403);
    assert.equal(created(donavan, t), 0);
  } finally {
    await setStaffRole(DONAVAN.id, 'trainer');
    donavan.end();
    amber.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('M10 LR7-a [A, P]: the liveness query forced to throw: a real send delivers no message.created to any socket, closes none (zero 4403s), and tells every socket `resync`; the next send is delivered', async () => {
  let failing = false;
  const escaped: unknown[] = [];
  const onEscape = (err: unknown): void => void escaped.push(err);
  process.on('unhandledRejection', onEscape);
  process.on('uncaughtException', onEscape);
  const rt = await startRouteApp({
    delivery: {
      livePrincipals: (ps) =>
        failing
          ? Promise.reject(new Error('connection terminated (test)'))
          : livePrincipalsAmong(ps),
    },
  });
  const a = await socketFor(rt.url, HER);
  const donavan = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    failing = true;
    const res = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: 'LR7-a' });
    assert.equal(res.statusCode, 201);
    await a.waitForType('resync');
    await donavan.waitForType('resync');
    await sleep(300);
    for (const c of [a, donavan]) {
      assert.equal(created(c, t), 0, 'nothing delivered on an unknown answer');
      assert.equal(c.closeCode(), undefined, 'no 4403: a failure is never "missing"');
    }
    failing = false;
    const next = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: 'LR7-a 2' });
    assert.equal(next.statusCode, 201);
    await a.waitFor(() => created(a, t) === 1);
    await donavan.waitFor(() => created(donavan, t) === 1);
    assert.deepEqual(escaped, []);
  } finally {
    process.off('unhandledRejection', onEscape);
    process.off('uncaughtException', onEscape);
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('M10 B16: two instances on one Redis: a real send on instance 1 reaches her socket and a staff socket on instance 2, each built there for its audience; instance 1 has no socket', async () => {
  const one = await startRouteApp();
  const two = await startRouteApp();
  const a = await socketFor(two.url, HER);
  const donavan = await socketFor(two.url, DONAVAN);
  const t = await plantThread(A);
  try {
    const res = await call(one.app, HER, 'POST', `/threads/${t}/messages`, { text: 'B16' });
    assert.equal(res.statusCode, 201);
    const id = res.json<{ id: string }>().id;
    const hers = await a.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
    const theirs = await donavan.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
    assert.equal((hers.message as { id: string }).id, id);
    assert.equal((theirs.message as { id: string }).id, id);
    assert.equal(one.hub.inspect().authenticated.size, 0);
  } finally {
    a.end();
    donavan.end();
    await one.close();
    await two.close();
    await removeThreads([t]);
  }
});

test('M10 OL4 (server): a real send fired the moment `ready` arrives (a slow principal read widening the window) reaches the socket: it was registered before `ready`', async () => {
  const rt = await startRouteApp({
    resolveById: async (ref) => {
      await sleep(300);
      return resolvePrincipalById(ref);
    },
  });
  const t = await plantThread(A);
  try {
    let sent: Promise<unknown> | undefined;
    const client = await connect(rt.url, (c) => c.send(devAuthFrame(devPrincipal(HER))));
    await client.waitFor((f) => {
      if (f.type === 'ready' && sent === undefined) {
        sent = call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: 'OL4' });
      }
      return f.type === 'ready';
    });
    const frame = await client.waitFor(
      (f) => f.type === 'message.created' && f.thread_id === t,
      3_000,
    );
    assert.equal(frame.thread_id, t);
    assert.equal(((await sent) as { statusCode: number }).statusCode, 201);
    client.end();
  } finally {
    await rt.close();
    await removeThreads([t]);
  }
});
