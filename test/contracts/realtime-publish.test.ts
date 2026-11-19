import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import * as helpers from './_realtime.js';

/**
 * Pass 3 phase R, item 5's machinery (ruled MB27 Q6: no silent no-op). A route that publishes
 * reads its bus from `app.realtime` AT REGISTRATION, through one helper that throws on an app
 * without it (and on a hub that cannot build what it would publish), never publishing nothing
 * at request time: a silent default is the `?? NOOP_LOG` shape (memory "prove the alarm
 * channel"). `buildApp()` decorates `app.realtime` before any route. Bare test apps decorate a
 * recording bus through `withTestBus(app)`. The call sites are phase F's.
 */

const THREAD = '11111111-1111-4111-8111-aaaaaaaaaaa1';
const OWNER = '11111111-1111-4111-8111-111111111111';

async function publishModule() {
  return import('../../src/realtime/publish.js');
}

async function serverModule() {
  return import('../../src/realtime/server.js');
}

/** A route-registration function shaped as phase F's call sites will be. */
function registerSendRoute(
  app: FastifyInstance,
  publisherFor: (app: FastifyInstance) => { publishForThread: (...args: never[]) => void },
): void {
  const bus = publisherFor(app);
  app.post('/send', async () => {
    (bus.publishForThread as (row: unknown, event: unknown) => void)(
      { id: THREAD, owner_id: OWNER },
      { kind: 'thread.changed' },
    );
    return { ok: true };
  });
}

test('item 5: a publishing route registered on an app without app.realtime throws at registration, never at request time', async () => {
  const { threadPublisherFor } = await publishModule();
  const app = Fastify({ logger: false });
  try {
    assert.throws(() => threadPublisherFor(app), /app\.realtime/);
    assert.throws(() => registerSendRoute(app, threadPublisherFor), /app\.realtime/);
  } finally {
    await app.close();
  }
});

test('item 5: a hub with no message element builder refuses a publishing route at registration (there is no default builder)', async () => {
  const { threadPublisherFor } = await publishModule();
  const { decorateRealtime } = await serverModule();
  const app = Fastify({ logger: false });
  try {
    decorateRealtime(app, { onAck: () => undefined });
    assert.throws(() => threadPublisherFor(app), /element builder/);
  } finally {
    await app.close();
  }
});

test('item 5: withTestBus(app) decorates a recording bus that a publishing route reads at registration; a publish records the event, sends nothing, and the route answers', async () => {
  const { threadPublisherFor } = await publishModule();
  const app = Fastify({ logger: false });
  try {
    const bus = helpers.withTestBus(app);
    registerSendRoute(app, threadPublisherFor);
    const res = await app.inject({ method: 'POST', url: '/send' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(bus.published, [
      { row: { id: THREAD, owner_id: OWNER }, event: { kind: 'thread.changed' }, only: undefined },
    ]);
    assert.equal(app.realtime.busState(), 'degraded', 'a recording bus never starts');
  } finally {
    await app.close();
  }
});

test('item 5: construction refuses a hub with no ack sink (the `?? noAckSink` default is gone)', async () => {
  const { decorateRealtime, registerRealtimeRoute } = await serverModule();
  const one = Fastify({ logger: false });
  const two = Fastify({ logger: false });
  try {
    assert.throws(() => decorateRealtime(one, {} as never), /ack sink/);
    assert.throws(() => registerRealtimeRoute(two, {} as never), /ack sink/);
    assert.equal(one.hasDecorator('realtime'), false, 'nothing half-built is left decorated');
  } finally {
    await one.close();
    await two.close();
  }
});

test('item 5: buildApp() decorates app.realtime before any route registers (the order in buildApp, read from src/server.ts), and GET /realtime is served from that same hub', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../../src/server.ts'), 'utf8');
  const body = source.slice(source.indexOf('export function buildApp('));
  const decorated = body.indexOf('decorateRealtime(app');
  const firstRoute = body.search(/\bregister\w*Route\(app/);
  assert.ok(decorated > 0, 'buildApp() calls decorateRealtime(app, …)');
  assert.ok(firstRoute > 0, 'buildApp() registers routes');
  assert.ok(decorated < firstRoute, 'the decoration comes before the first route');
  assert.equal(body.match(/decorateRealtime\(app/g)?.length, 1, 'once');

  const { buildApp } = await import('../../src/server.js');
  const app = buildApp();
  try {
    await app.ready();
    assert.equal(app.hasDecorator('realtime'), true);
    assert.equal(typeof app.realtime.startBus, 'function');
    assert.ok(app.hasRoute({ method: 'GET', url: '/realtime' }), 'the socket route is registered');
  } finally {
    await app.close();
  }
});
