import './_realtimePrefix.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';
import { registerAuth } from '../../src/auth/plugin.js';
import type { MirrorPrincipal } from '../../src/auth/mirror.js';
import type { PublisherLike } from '../../src/realtime/bus.js';
import { deliveredAckSink } from '../../src/realtime/delivered.js';
import { messageElementFromGet } from '../../src/realtime/messageElement.js';
import {
  decorateRealtime,
  registerRealtimeRoute,
  type RealtimeHub,
  type RealtimeOptions,
} from '../../src/realtime/server.js';
import { registerMediaRoute } from '../../src/routes/media.js';
import { registerStaffThreadsRoute } from '../../src/routes/staffThreads.js';
import { registerThreadsRoute } from '../../src/routes/threads.js';
import { makeLogCapture, type LogCapture } from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';
import {
  connect,
  devAuthFrame,
  testVerify,
  waitUntil,
  type PublishedEvent,
  type RtClient,
} from './_realtime.js';

/**
 * Pass 3 phase F: the real routes with the live channel on ONE listening app, shaped as
 * `buildApp()` shapes it: `app.realtime` decorated before the routes register (they read their
 * bus at registration), `GET /realtime` last. The three route families share one R2 stub, and
 * the element builder is the real one (`messageElementFromGet`) on that stub, so a frame's
 * `message` can be deep-equalled with the GET's. The ack sink is the real *Delivered* stamp. HTTP
 * goes through the real `authenticate` with `X-Dev-Principal` (the suite runs with the bypass on),
 * so one app serves every principal. Every publish is recorded and passed through (`published`).
 * `failPublishes` makes the bus's Redis publisher throw (B9).
 */

export interface RouteTestApp {
  app: FastifyInstance;
  hub: RealtimeHub;
  url: string;
  logs: LogCapture;
  r2: R2Stub;
  published: PublishedEvent[];
  /** While true, the bus's Redis publisher throws synchronously on every publish. */
  failPublishes: { on: boolean };
  close(): Promise<void>;
}

export async function startRouteApp(
  opts: Partial<RealtimeOptions> & { startBus?: boolean } = {},
): Promise<RouteTestApp> {
  const logs = makeLogCapture();
  const app = Fastify({ logger: { level: 'trace', stream: logs.stream } });
  registerAuth(app);
  const r2 = makeR2Stub();
  const failPublishes = { on: false };
  const { startBus, ...realtime } = opts;
  const hub = decorateRealtime(app, {
    verify: testVerify,
    bypassEnabled: true,
    onAck: deliveredAckSink,
    messageElement: messageElementFromGet(r2),
    ...realtime,
    bus: {
      probeRetryMs: 200,
      createPublisher: (base: Redis): PublisherLike => {
        const real = base.duplicate({ maxRetriesPerRequest: 1 });
        return {
          publish: (channel, message) => {
            if (failPublishes.on) throw new Error('forced publisher failure (B9)');
            // `call`, so the publish lint rule keeps meaning "only bus.ts publishes".
            return real.call('PUBLISH', channel, message);
          },
          on: (event, listener) => real.on(event, listener),
          disconnect: () => real.disconnect(),
        };
      },
      ...realtime.bus,
    },
  });
  const published: PublishedEvent[] = [];
  const through = hub.bus.publishForThread.bind(hub.bus);
  hub.bus.publishForThread = (row, event, only) => {
    published.push({ row, event, only });
    through(row, event, only);
  };
  registerThreadsRoute(app, { r2 });
  registerStaffThreadsRoute(app, { r2, expoPush: makeExpoPushStub() });
  registerMediaRoute(app, { r2 });
  registerRealtimeRoute(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  if (startBus !== false) {
    hub.startBus();
    await waitUntil(() => (hub.busState() === 'live' ? true : undefined), 5_000, 'the bus live');
  }
  return {
    app,
    hub,
    url: `ws://127.0.0.1:${address.port}/realtime`,
    logs,
    r2,
    published,
    failPublishes,
    close: () => app.close(),
  };
}

/** `X-Dev-Principal` for a mirror principal (the HTTP dev arm's grammar). */
export function devPrincipal(p: MirrorPrincipal): string {
  return p.kind === 'owner' ? `owner:${p.id}` : `staff:${p.id}:${p.role}`;
}

/** A socket authenticated by the dev arm, `ready` received. */
export async function socketFor(url: string, p: MirrorPrincipal): Promise<RtClient> {
  const client = await connect(url, (c) => c.send(devAuthFrame(devPrincipal(p))));
  await client.waitForType('ready');
  return client;
}

/** One request as `p`, with an Idempotency-Key (fresh unless given). */
export function call(
  app: FastifyInstance,
  p: MirrorPrincipal,
  method: 'POST' | 'DELETE' | 'GET',
  url: string,
  payload?: unknown,
  key: string = `rt-${randomUUID()}`,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      'x-dev-principal': devPrincipal(p),
      ...(method === 'GET' ? {} : { 'idempotency-key': key }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
