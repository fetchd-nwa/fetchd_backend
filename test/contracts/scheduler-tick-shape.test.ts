import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import { env } from '../../src/env.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { runSchedulerTickOnce, type SchedulerTickResult } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * The tick's shape after P17: the phases that survive, by name, from a REAL tick
 * rather than from a fixture typed to match. `SchedulerTickResult` is what
 * `POST /workers/tick` answers and the completion log line is the nominated authority
 * on whether a tick ran, and the log keys are read by name by people and alarms, so
 * neither may gain or lose a key without this file saying so.
 */

registerFixtureHooks();

const SURVIVING_PHASES = [
  'captureReconciler',
  'cardExpiry',
  'creditExpiryWarnings',
  'duplicateRefundRetry',
  'idempotencyKeysSwept',
  'mediaDerivatives',
  'orderSweeper',
  'scheduledNotifications',
];

const LOG_KEYS = [
  'captureReconcilerAbandoned',
  'captureReconcilerAbandonedTruncated',
  'captureReconcilerAbandonedUncollected',
  'captureReconcilerCaptured',
  'captureReconcilerLostHolds',
  'captureReconcilerRefundedPostWithdraw',
  'captureReconcilerRefundedSurplus',
  'captureReconcilerScanned',
  'captureReconcilerSettledInvoices',
  'captureReconcilerWithdrawnReleased',
  'cardExpiryEnqueued',
  'cardExpiryScanned',
  'creditExpiryWarningsEnqueued',
  'creditExpiryWarningsScanned',
  'duplicateRefundRetryAbandoned',
  'duplicateRefundRetryAbandonedClientKeyed',
  'duplicateRefundRetryAbandonedCovered',
  'duplicateRefundRetryAbandonedNeverSent',
  'duplicateRefundRetryAbandonedRowKeyed',
  'duplicateRefundRetryAbandonedStripeFailed',
  'duplicateRefundRetryAbandonedTruncated',
  'duplicateRefundRetryScanned',
  'duplicateRefundRetrySent',
  'idempotencyKeysSwept',
  'mediaDerivativesScanned',
  'orderSweeperAbandoned',
  'orderSweeperFailed',
  'orderSweeperLateRefunded',
  'orderSweeperLeft',
  'orderSweeperScanned',
  'orderSweeperSettled',
  'pushTicketsError',
  'pushTicketsOk',
  'scheduledFailed',
  'scheduledParked',
  'scheduledParkedTotal',
  'scheduledQueueOk',
  'scheduledScanned',
  'scheduledSent',
];

/** What every pino line carries, and what this line carries to name itself. */
const ENVELOPE_KEYS = new Set(['hostname', 'level', 'msg', 'pid', 'reqId', 'time', 'workerTick']);

test('a real tick answers the surviving phases and no others', SKIP_WHEN_NO_DB, async () => {
  const result: SchedulerTickResult = await runSchedulerTickOnce({
    expoPush: makeExpoPushStub(),
    stripe: makeStripeStub(),
  });
  assert.deepEqual(Object.keys(result).sort(), SURVIVING_PHASES);
});

test(
  'POST /workers/tick: the completion line carries exactly the surviving keys',
  SKIP_WHEN_NO_DB,
  async () => {
    const lines: Array<Record<string, unknown>> = [];
    const app = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(msg: string): void {
            lines.push(JSON.parse(msg) as Record<string, unknown>);
          },
        },
      },
    });
    registerAuth(app);
    const expoPush = makeExpoPushStub();
    const stripe = makeStripeStub();
    registerWorkersTickRoute(app, {
      runTick: ({ log }) => runSchedulerTickOnce({ expoPush, stripe, log }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    await app.close();

    const complete = lines.find((line) => line['msg'] === 'scheduler tick complete');
    assert.ok(complete !== undefined, 'no completion line');
    assert.deepEqual(
      Object.keys(complete)
        .filter((key) => !ENVELOPE_KEYS.has(key))
        .sort(),
      LOG_KEYS,
    );
  },
);
