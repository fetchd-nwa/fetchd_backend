/**
 * Child processes for the realtime suite (not a test file). Each mode prints plain lines on
 * stdout and exits on its own.
 *
 *   prefix                       imports the harness FIRST (as every contract test does), then
 *                                prints the prefix the bus resolves (CR1 / MB13 M5).
 *   listen                       the harness, then a bus on the resolved prefix: prints
 *                                `LIVE <prefix>` once live and `EVENT <json>` per event, until
 *                                stdin closes (or 15 s).
 *   publish <owner> <thread>     the harness, then a bus: waits for live, publishes one
 *                                `thread.changed`, prints `PUBLISHED <prefix>`.
 *   prod-dev-arm <owner>         NOT the harness: a bare app with the default realtime options
 *                                (the parent sets NODE_ENV=production), one `dev_principal` auth,
 *                                prints `BYPASS <bool>` and `CLOSE <code>`.
 */

const mode = process.argv[2];

async function main(): Promise<void> {
  if (mode === 'prod-dev-arm') {
    const ownerId = process.argv[3]!;
    const { createRequire } = await import('node:module');
    const Fastify = (await import('fastify')).default;
    const { bypassHeaderEnabled } = await import('../../src/env.js');
    const { registerRealtimeRoute } = await import('../../src/realtime/server.js');
    process.stdout.write(`BYPASS ${String(bypassHeaderEnabled)}\n`);
    const app = Fastify({ logger: false });
    // Every default but the ack sink, which has none (MB27 Q6): the dev arm's gate is the subject.
    registerRealtimeRoute(app, { onAck: () => undefined });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const WebSocket = createRequire(import.meta.url)('ws') as new (url: string) => {
      on(event: string, listener: (...args: unknown[]) => void): void;
      send(data: string): void;
    };
    const code = await new Promise<unknown>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'auth', protocol: 1, dev_principal: `owner:${ownerId}` })),
      );
      ws.on('close', (closeCode) => resolve(closeCode));
    });
    process.stdout.write(`CLOSE ${String(code)}\n`);
    await app.close();
    return;
  }

  await import('./_harness.js');
  const { resolveChannelPrefix, RealtimeBus } = await import('../../src/realtime/bus.js');
  const prefix = resolveChannelPrefix();
  if (mode === 'prefix') {
    process.stdout.write(`PREFIX ${prefix}\n`);
    return;
  }

  const Fastify = (await import('fastify')).default;
  const { env } = await import('../../src/env.js');
  const { baseRedis } = await import('./_realtime.js');
  const base = baseRedis(env.REDIS_URL);
  const log = Fastify({ logger: { level: 'error' } }).log;
  let live = false;
  const bus = new RealtimeBus(
    { prefix, log, base, probeRetryMs: 200 },
    {
      onEvent: (target, event) => {
        process.stdout.write(`EVENT ${JSON.stringify({ target, event })}\n`);
      },
      onState: (state) => {
        live = state === 'live';
        if (live) process.stdout.write(`LIVE ${prefix}\n`);
      },
      onResync: () => undefined,
    },
  );
  bus.start();
  const deadline = Date.now() + 10_000;
  while (!live && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (!live) throw new Error('the bus never went live');

  if (mode === 'publish') {
    bus.publishForThread(
      { id: process.argv[4]!, owner_id: process.argv[3]! },
      { kind: 'thread.changed' },
    );
    await new Promise((r) => setTimeout(r, 300));
    process.stdout.write(`PUBLISHED ${prefix}\n`);
  } else if (mode === 'listen') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      process.stdin.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      process.stdin.resume();
    });
  } else {
    throw new Error(`unknown mode ${String(mode)}`);
  }
  await bus.stop();
  base.disconnect();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
