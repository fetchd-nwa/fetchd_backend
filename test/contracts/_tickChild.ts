import Fastify from 'fastify';
import Stripe from 'stripe';
import { registerAuth } from '../../src/auth/plugin.js';
import { env } from '../../src/env.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { makeLogCapture } from './_harness.js';

/**
 * A SECOND server process for P22 B-8 (`stripe-events-unfinished-alarm.test.ts`): what a
 * deploy or a restart is to the unfinished-claim alarm, whose "first time a process sees
 * it" memory is the process's. It runs the production `POST /workers/tick` route, its own
 * logger captured, `ticks` times, and writes the captured lines the test reads to stdout as
 * one JSON array. Stripe is offline here: every SDK verb the tick could reach rejects, so
 * this process cannot touch the network whatever the test database holds.
 */
const ticks = Number(process.argv[2] ?? '1');

const probe = new Stripe('sk_test_tick_child_offline');
const offline = (): Promise<never> =>
  Promise.reject(new Stripe.errors.StripeConnectionError({ message: 'no network in tests' }));
for (const resource of [probe.paymentIntents, probe.refunds, probe.customers, probe.paymentMethods, probe.setupIntents]) {
  const proto = Object.getPrototypeOf(resource) as Record<string, unknown>;
  for (const verb of ['create', 'retrieve', 'list', 'cancel', 'capture', 'confirm', 'update', 'detach']) {
    if (typeof proto[verb] === 'function') proto[verb] = offline;
  }
}

const capture = makeLogCapture();
const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
registerAuth(app);
registerWorkersTickRoute(app);
const statuses: number[] = [];
for (let i = 0; i < ticks; i += 1) {
  const res = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  statuses.push(res.statusCode);
}
const kept = capture.lines.filter(
  (l) => l.workerTick === 'stripe-events-unfinished' || l.msg === 'scheduler tick complete',
);
process.stdout.write(`${JSON.stringify({ statuses, lines: kept })}\n`);
await app.close();
process.exit(0);
