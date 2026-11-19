import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import {
  EXPO_PUSH_TIMEOUT_MS,
  defaultExpoPushClient,
  makeExpoPushClient,
  type ExpoPushMessage,
} from '../src/lib/expoPush.js';

/**
 * The Expo sender (O-MSG-LIVE pass 2a; designs/messaging-live-v1.md A1 D8, A2 FM1):
 *   - every `fetch` to Expo carries a 10 s abort, so a stalled Expo can never hold a
 *     staff reply's push (or the shutdown that drains it) longer than that;
 *   - `ExpoPushMessage.badge` and `data.thread_id` reach the wire when set and are
 *     ABSENT when not (a `badge` of 0 would wipe her icon badge on every notice push).
 *
 * The fake Expo is a real HTTP server on port 0 answering Expo's real response shape
 * (`{ data: ExpoPushTicket[] }`) after a real delay, so the client's real `fetch` (undici)
 * is what is aborted. Only the 10 s timer is injected: the test fires it by hand instead
 * of waiting ten seconds.
 */

type Mode =
  | { kind: 'answer'; delayMs: number; status?: number }
  | { kind: 'stall-headers' }
  | { kind: 'stall-body' };

interface FakeExpo {
  url: string;
  /** Each request's parsed JSON body, in arrival order. */
  received: unknown[];
  /** Resolves once a request's body has been read (the fetch is in flight). */
  nextRequest(): Promise<void>;
  /** Resolves when the server sees the in-flight response's connection close. */
  nextClose(): Promise<void>;
  setMode(mode: Mode): void;
  close(): Promise<void>;
}

async function startFakeExpo(): Promise<FakeExpo> {
  let mode: Mode = { kind: 'answer', delayMs: 40 };
  const received: unknown[] = [];
  let requestWaiters: Array<() => void> = [];
  let closeWaiters: Array<() => void> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
      received.push(parsed);
      const waiting = requestWaiters;
      requestWaiters = [];
      for (const w of waiting) w();
      res.on('close', () => {
        const closing = closeWaiters;
        closeWaiters = [];
        for (const w of closing) w();
      });
      const current = mode;
      if (current.kind === 'stall-headers') return; // never answers
      if (current.kind === 'stall-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"data":['); // headers and half a body, then nothing
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [];
      setTimeout(() => {
        res.writeHead(current.status ?? 200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: messages.map((_m, i) =>
              i === 1
                ? {
                    status: 'error',
                    message:
                      '"ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]" is not a registered push notification recipient',
                    details: { error: 'DeviceNotRegistered' },
                  }
                : { status: 'ok', id: `0a1b2c3d-0000-4000-8000-00000000000${i}` },
            ),
          }),
        );
      }, current.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/--/api/v2/push/send`,
    received,
    nextRequest: () => new Promise<void>((resolve) => requestWaiters.push(resolve)),
    nextClose: () => new Promise<void>((resolve) => closeWaiters.push(resolve)),
    setMode(next) {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface ManualTimer {
  scheduled: Array<{ fn: () => void; ms: number; cleared: boolean; handle: object }>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

function makeManualTimer(): ManualTimer {
  const scheduled: ManualTimer['scheduled'] = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      const handle = {};
      scheduled.push({ fn, ms, cleared: false, handle });
      return handle;
    },
    clearTimer(handle) {
      const entry = scheduled.find((s) => s.handle === handle);
      if (entry !== undefined) entry.cleared = true;
    },
  };
}

function withinMs<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms),
    ),
  ]);
}

const fake = await startFakeExpo();
after(async () => {
  await fake.close();
});

const ONE: ExpoPushMessage[] = [
  { to: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', title: 'Amber', body: 'See you at 6!' },
];

test('the abort is 10 s', () => {
  assert.equal(EXPO_PUSH_TIMEOUT_MS, 10_000);
});

test('a stalled Expo (no headers) is aborted when the 10 s timer fires', async () => {
  fake.setMode({ kind: 'stall-headers' });
  const timer = makeManualTimer();
  const client = makeExpoPushClient({ url: fake.url, ...timer });
  const inFlight = fake.nextRequest();
  const closed = fake.nextClose();
  const sending = client.sendBatch(ONE);
  sending.catch(() => undefined); // observed below; never an unhandled rejection
  await withinMs(inFlight, 5000, 'the request to reach the fake Expo');

  assert.equal(timer.scheduled.length, 1, 'one abort timer per send');
  assert.equal(timer.scheduled[0]!.ms, 10_000, 'scheduled at 10 s');
  assert.equal(timer.scheduled[0]!.cleared, false, 'still armed while Expo stalls');

  timer.scheduled[0]!.fn(); // ten seconds pass
  await assert.rejects(withinMs(sending, 2000, 'the aborted send to settle'), /abort/i);
  // The socket really closed: the fetch was aborted, not merely a promise rejected.
  await withinMs(closed, 2000, 'the fake Expo to see the connection close');
});

test('a stalled Expo body (headers sent, body never ends) is aborted too', async () => {
  fake.setMode({ kind: 'stall-body' });
  const timer = makeManualTimer();
  const client = makeExpoPushClient({ url: fake.url, ...timer });
  const inFlight = fake.nextRequest();
  const sending = client.sendBatch(ONE);
  sending.catch(() => undefined);
  await withinMs(inFlight, 5000, 'the request to reach the fake Expo');
  // Let the headers and the half body arrive, so the client is inside `response.json()`.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(timer.scheduled[0]!.cleared, false, 'the timer covers the body read');
  timer.scheduled[0]!.fn();
  await assert.rejects(withinMs(sending, 2000, 'the aborted body read to settle'), /abort/i);
});

test('a slow Expo inside the window answers its real tickets, and the timer is cleared', async () => {
  fake.setMode({ kind: 'answer', delayMs: 60 });
  const timer = makeManualTimer();
  const client = makeExpoPushClient({ url: fake.url, ...timer });
  const tickets = await client.sendBatch([
    ...ONE,
    { to: 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]', title: 'Amber', body: 'Hi' },
  ]);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0]!.status, 'ok');
  assert.equal(tickets[1]!.status, 'error');
  assert.equal(tickets[1]!.details?.error, 'DeviceNotRegistered');
  assert.equal(timer.scheduled.length, 1);
  assert.equal(timer.scheduled[0]!.cleared, true, 'no armed timer outlives the send');
});

test('an Expo 5xx still throws, and the timer is cleared', async () => {
  fake.setMode({ kind: 'answer', delayMs: 20, status: 503 });
  const timer = makeManualTimer();
  const client = makeExpoPushClient({ url: fake.url, ...timer });
  await assert.rejects(client.sendBatch(ONE), /expo push: HTTP 503/);
  assert.equal(timer.scheduled[0]!.cleared, true);
});

test('badge and data.thread_id serialize when set and are absent when not', async () => {
  fake.setMode({ kind: 'answer', delayMs: 30 });
  const client = makeExpoPushClient({ url: fake.url });
  const before = fake.received.length;
  await client.sendBatch([
    {
      to: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      title: 'Amber',
      body: 'Small scrape on her paw — was it there this morning?',
      sound: 'default',
      badge: 3,
      data: {
        type: 'message-received',
        notification_id: '9b2f6a10-0000-4000-8000-000000000001',
        deep_link_path: '/chat/7c0d1e20-0000-4000-8000-000000000002',
        thread_id: '7c0d1e20-0000-4000-8000-000000000002',
      },
    },
    {
      to: 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]',
      title: 'Booking confirmed',
      body: 'Waffles is booked for Day School on Friday.',
      data: { type: 'booking-confirmed', notification_id: '9b2f6a10-0000-4000-8000-000000000003' },
    },
  ]);
  assert.equal(fake.received.length, before + 1, 'one POST for the batch');
  const wire = fake.received[before] as Array<Record<string, unknown>>;
  assert.deepEqual(wire[0], {
    to: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    title: 'Amber',
    body: 'Small scrape on her paw — was it there this morning?',
    sound: 'default',
    badge: 3,
    data: {
      type: 'message-received',
      notification_id: '9b2f6a10-0000-4000-8000-000000000001',
      deep_link_path: '/chat/7c0d1e20-0000-4000-8000-000000000002',
      thread_id: '7c0d1e20-0000-4000-8000-000000000002',
    },
  });
  assert.deepEqual(wire[1], {
    to: 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]',
    title: 'Booking confirmed',
    body: 'Waffles is booked for Day School on Friday.',
    data: { type: 'booking-confirmed', notification_id: '9b2f6a10-0000-4000-8000-000000000003' },
  });
  assert.equal('badge' in wire[1]!, false, 'no badge key: a notice push never touches her icon');
  assert.equal(
    'thread_id' in (wire[1]!.data as Record<string, unknown>),
    false,
    'no thread_id on a non-message push',
  );
});

test('an empty batch sends nothing', async () => {
  let calls = 0;
  const client = makeExpoPushClient({
    url: fake.url,
    fetch: async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return fetch(...args);
    },
  });
  assert.deepEqual(await client.sendBatch([]), []);
  assert.equal(calls, 0);
});

test('the default client is the production seam (never called here)', () => {
  assert.equal(typeof defaultExpoPushClient.sendBatch, 'function');
});
