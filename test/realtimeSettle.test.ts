import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  drainInFlight,
  fireAndForget,
  inFlightCount,
  trackInFlight,
  type WarnLogger,
} from '../src/realtime/settle.js';

/**
 * `src/realtime/settle.ts` (brief LR5; A2 FH1): nothing un-awaited can exit the process.
 * `observability.ts` turns an `uncaughtException` and an `unhandledRejection` alike into
 * `process.exit(1)`, so a fire-and-forget that lets either escape drops every socket and every
 * in-flight request. Each case below watches the process for both events itself.
 */

interface Escapes {
  uncaught: unknown[];
  unhandled: unknown[];
  stop(): void;
}

function watchEscapes(): Escapes {
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (err: unknown): void => {
    uncaught.push(err);
  };
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  return {
    uncaught,
    unhandled,
    stop() {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    },
  };
}

/** Long enough for an unhandled rejection to be reported (Node reports after the microtask
 *  queue drains) and for a thrown timer callback to surface. */
function settleALittle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WarnLine {
  obj: Record<string, unknown>;
  msg: string;
}

function captureWarn(): { log: WarnLogger; lines: WarnLine[] } {
  const lines: WarnLine[] = [];
  return {
    lines,
    log: {
      warn(obj, msg) {
        lines.push({ obj, msg });
      },
    },
  };
}

test('fireAndForget: a synchronous throw is caught, logged once at warn, and escapes nowhere', async () => {
  const escapes = watchEscapes();
  const { log, lines } = captureWarn();
  try {
    fireAndForget(
      () => {
        throw new Error('claim INSERT failed: connection reset');
      },
      { log, what: 'staff message push', fields: { message_id: 'm-1' } },
    );
    await settleALittle();
  } finally {
    escapes.stop();
  }
  assert.deepEqual(escapes.uncaught, []);
  assert.deepEqual(escapes.unhandled, []);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.obj.message_id, 'm-1');
  assert.match(lines[0]!.msg, /staff message push/);
});

test('fireAndForget: a rejection is caught, logged once at warn, and escapes nowhere', async () => {
  const escapes = watchEscapes();
  const { log, lines } = captureWarn();
  try {
    fireAndForget(() => Promise.reject(new Error('publish failed')), {
      log,
      what: 'realtime publish',
    });
    await settleALittle();
  } finally {
    escapes.stop();
  }
  assert.deepEqual(escapes.uncaught, []);
  assert.deepEqual(escapes.unhandled, []);
  assert.equal(lines.length, 1);
});

test('fireAndForget: a thunk that resolves logs nothing', async () => {
  const { log, lines } = captureWarn();
  let ran = false;
  fireAndForget(
    async () => {
      ran = true;
    },
    { log, what: 'nothing wrong' },
  );
  await settleALittle();
  assert.equal(ran, true);
  assert.deepEqual(lines, []);
});

test('fireAndForget: a logger that itself throws still lets nothing escape', async () => {
  const escapes = watchEscapes();
  try {
    fireAndForget(() => Promise.reject(new Error('x')), {
      log: {
        warn() {
          throw new Error('the logger is broken too');
        },
      },
      what: 'double fault',
    });
    await settleALittle();
  } finally {
    escapes.stop();
  }
  assert.deepEqual(escapes.uncaught, []);
  assert.deepEqual(escapes.unhandled, []);
});

test('trackInFlight holds the CAUGHT promise: a rejecting tracked send leaks no unhandledRejection (Opus probe p4_finally)', async () => {
  const escapes = watchEscapes();
  const { log, lines } = captureWarn();
  try {
    const tracked = trackInFlight(() => Promise.reject(new Error('Expo: socket hang up')), {
      log,
      what: 'staff message push',
    });
    assert.equal(inFlightCount(), 1, 'tracked while in flight');
    await tracked;
    await settleALittle();
  } finally {
    escapes.stop();
  }
  assert.deepEqual(escapes.unhandled, []);
  assert.deepEqual(escapes.uncaught, []);
  assert.equal(lines.length, 1);
  assert.equal(inFlightCount(), 0, 'removed once settled');
});

test('trackInFlight: a synchronous throw is caught the same way and leaves the set empty', async () => {
  const escapes = watchEscapes();
  const { log, lines } = captureWarn();
  try {
    const tracked = trackInFlight(
      () => {
        throw new Error('sync');
      },
      { log, what: 'staff message push' },
    );
    await tracked;
    await settleALittle();
  } finally {
    escapes.stop();
  }
  assert.deepEqual(escapes.uncaught, []);
  assert.deepEqual(escapes.unhandled, []);
  assert.equal(lines.length, 1);
  assert.equal(inFlightCount(), 0);
});

test('drainInFlight waits for a stalled send, and for one tracked while it drains', async () => {
  const { log } = captureWarn();
  const settled: string[] = [];
  trackInFlight(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          settled.push('first');
          // A send started while the drain is already waiting (a reply that commits during
          // `app.close()`): the drain must wait for it too.
          trackInFlight(
            () =>
              new Promise<void>((r) =>
                setTimeout(() => {
                  settled.push('second');
                  r();
                }, 60),
              ),
            { log, what: 'late send' },
          );
          resolve();
        }, 60),
      ),
    { log, what: 'stalled send' },
  );
  await drainInFlight();
  assert.deepEqual(settled, ['first', 'second']);
  assert.equal(inFlightCount(), 0);
});

test('drainInFlight never rejects, even when every tracked send rejected (LR9-b)', async () => {
  const escapes = watchEscapes();
  const { log } = captureWarn();
  try {
    trackInFlight(() => Promise.reject(new Error('a')), { log, what: 'push' });
    trackInFlight(() => Promise.reject(new Error('b')), { log, what: 'push' });
    await drainInFlight();
    await settleALittle();
  } finally {
    escapes.stop();
  }
  assert.deepEqual(escapes.unhandled, []);
  assert.equal(inFlightCount(), 0);
});

test('drainInFlight with nothing in flight resolves at once', async () => {
  const t0 = Date.now();
  await drainInFlight();
  assert.ok(Date.now() - t0 < 50);
});
