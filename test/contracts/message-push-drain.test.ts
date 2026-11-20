import {
  FIXTURE_MANAGER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
} from './_harness.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import type { ExpoPushClient, ExpoPushMessage, ExpoPushTicket } from '../../src/lib/expoPush.js';
import { drainInFlight, inFlightCount } from '../../src/realtime/settle.js';
import { SHUTDOWN_BOUND_MS, runShutdown } from '../../src/realtime/shutdown.js';
import {
  ownerApp,
  removePlantedStaffTraces,
  staffApp,
  staffReply,
  startThread,
} from './_messaging.js';
import { makeR2Stub } from './_r2Stub.js';
import { childEnv, waitUntil } from './_realtime.js';

/**
 * A deploy must not lose a push it could send (design messaging-live-v1 A2 FM2; brief LR9;
 * O-MSG-LIVE pass 3 item 4, row FM2-a, ruling Q9).
 *
 *   · In-process (Q9): a REAL staff reply (`POST /staff/threads/:id/messages`, pass 2's route)
 *     whose push is stalled at an Expo fake (the real ticket shape, a real 1.5 s delay), then the
 *     API's own shutdown sequence (`runShutdown`, as `src/index.ts` calls it, with
 *     `drain: drainInFlight`): `closeDb` (a spy) runs only after the push settled and its claim
 *     was stamped, and nothing is in flight after. No test reaches Expo: `EXPO_PUSH_URL` is
 *     hard-coded, so the push always goes to the injected fake.
 *   · The entry point's half: the case above hands `runShutdown` its own `drain`, so it cannot
 *     see `src/index.ts` drop it. A spawned `src/index.ts` with a preload
 *     (`_bootDrainProbe.ts`) that tracks one stalled thunk in the process's own in-flight set at
 *     SIGTERM shows the real sequence waits for the set before it closes the pool. It sends no
 *     staff message (a spawned API must never send one).
 */

registerFixtureHooks();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Expo answers this long after the call: longer than `app.close()` takes on an idle app. */
const EXPO_DELAY_MS = 1_500;

interface StalledExpo extends ExpoPushClient {
  readonly calls: ExpoPushMessage[][];
  /** When Expo answered (epoch ms), once it has. */
  answeredAt(): number | undefined;
  /** Resolves when Expo has answered. */
  readonly answered: Promise<void>;
}

/** Expo, stalled: every batch answers after `delayMs`, one `ok` ticket per message, as Expo does. */
function stalledExpo(delayMs: number): StalledExpo {
  const calls: ExpoPushMessage[][] = [];
  let at: number | undefined;
  let markAnswered: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    markAnswered = resolve;
  });
  return {
    calls,
    answered,
    answeredAt: () => at,
    async sendBatch(messages): Promise<ExpoPushTicket[]> {
      calls.push(messages.slice());
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      at = Date.now();
      markAnswered();
      return messages.map(() => ({ status: 'ok' as const, id: randomUUID() }));
    },
  };
}

async function claimOf(
  messageId: string,
): Promise<{ tickets_ok: number | null; tickets_error: number | null } | undefined> {
  const { rows } = await db.execute<{ tickets_ok: number | null; tickets_error: number | null }>(
    sql`SELECT tickets_ok, tickets_error FROM message_pushes WHERE message_id = ${messageId}`,
  );
  return rows[0];
}

afterEach(async () => {
  await drainInFlight();
  await removePlantedStaffTraces();
});
after(async () => {
  await removeFamilies();
});

test(
  'FM2-a (in-process, Q9): a real staff reply whose push is stalled at Expo, then the shutdown sequence: closeDb runs only after the push settled and its claim was stamped; nothing in flight after',
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await plantFamily('The Ashworths');
    const started = await startThread(ownerApp(family.principal), {
      category: 'sessions',
      text: 'Is Biscuit in today?',
    });
    assert.equal(started.statusCode, 201, started.body);
    const threadId = (started.json() as { thread: { id: string } }).thread.id;
    const token = `ExponentPushToken[${randomUUID()}]`;
    await db.execute(sql`
      INSERT INTO device_tokens (owner_id, expo_push_token, platform)
      VALUES (${family.ownerId}, ${token}, 'ios')`);

    const expo = stalledExpo(EXPO_DELAY_MS);
    const app = staffApp(FIXTURE_MANAGER_PRINCIPAL, makeR2Stub(), expo);
    const res = await staffReply(app, threadId, { text: 'Yes, he is in the yard now.' });
    assert.equal(res.statusCode, 201, res.body);
    const reply = res.json() as { id: string; reach?: { channel: string; why: string } };
    assert.deepEqual(reply.reach, { channel: 'push', why: 'device' });
    const answeredAtReply = expo.answeredAt() !== undefined;
    const inFlightAtReply = inFlightCount();

    const lines: Array<{ level: 'warn' | 'error'; msg: string }> = [];
    let closeDbAt: number | undefined;
    let inFlightAtClose: number | undefined;
    let claimAtClose: Awaited<ReturnType<typeof claimOf>>;
    const t0 = Date.now();
    try {
      const exitCode = await runShutdown({
        closeApp: () => app.close(),
        drain: drainInFlight,
        // The spy: the pool stays open, so it can read what the push had stamped by then.
        closeDb: async () => {
          closeDbAt = Date.now();
          inFlightAtClose = inFlightCount();
          claimAtClose = await claimOf(reply.id);
        },
        closeRedis: () => undefined,
        log: {
          warn: (_o, msg) => lines.push({ level: 'warn', msg }),
          error: (_o, msg) => lines.push({ level: 'error', msg }),
        },
      });
      const elapsed = Date.now() - t0;

      const answeredAt = expo.answeredAt();
      assert.ok(
        answeredAt !== undefined && closeDbAt !== undefined && answeredAt <= closeDbAt,
        `closeDb ran before the stalled push settled (Expo answered at ${String(answeredAt)}, closeDb at ${String(closeDbAt)})`,
      );
      assert.deepEqual(
        claimAtClose,
        { tickets_ok: 1, tickets_error: 0 },
        'by closeDb, the push had finished: its claim stamped with the ticket',
      );
      assert.equal(inFlightAtClose, 0, 'nothing in flight when the pool closes');
      assert.equal(inFlightCount(), 0, 'nothing in flight after');
      assert.equal(exitCode, 0);
      assert.deepEqual(lines, [], 'no warn or error from the shutdown');
      assert.ok(elapsed < SHUTDOWN_BOUND_MS, `shutdown took ${elapsed} ms`);
      // The setting the rows above rest on: the push really was stalled and tracked at the 201.
      assert.equal(answeredAtReply, false, 'Expo had not answered when the 201 arrived');
      assert.equal(inFlightAtReply, 1, "the reply's push was in the tracked set at the 201");
      assert.equal(expo.calls.length, 1, 'one Expo batch');
      assert.deepEqual(
        expo.calls[0]?.map((m) => m.to),
        [token],
      );
    } finally {
      // Under a mutant the push outlives the shutdown: let it finish before the cleanup runs.
      await Promise.race([
        expo.answered,
        new Promise((resolve) => setTimeout(resolve, EXPO_DELAY_MS + 1_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await db.execute(sql`DELETE FROM device_tokens WHERE owner_id = ${family.ownerId}`);
    }
  },
);

async function freePort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test(
  "FM2-a, the entry point's half: src/index.ts under SIGTERM waits for its own in-flight set before it closes the pool (a preload tracks one stalled thunk; no message is sent)",
  SKIP_WHEN_NO_DB,
  async () => {
    // `env.ts` loads `.env.local` and `.env` from the working directory outside production; this
    // tree must hold neither (the backend's `.env` is production).
    for (const name of ['.env', '.env.local']) {
      assert.equal(
        fs.existsSync(path.join(REPO_ROOT, name)),
        false,
        `${name} present: refusing to boot`,
      );
    }
    const port = await freePort();
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', './test/contracts/_bootDrainProbe.ts', 'src/index.ts'],
      {
        cwd: REPO_ROOT,
        env: childEnv({ PORT: String(port), LOG_LEVEL: 'info' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const exited = new Promise<number | null>((resolve) =>
      proc.on('close', (code) => resolve(code)),
    );
    const probe = (what: string): number | undefined => {
      const line = out.split('\n').find((l) => l.startsWith(`PROBE ${what} `));
      return line === undefined ? undefined : Number(line.split(' ')[2]);
    };
    try {
      await waitUntil(
        () => (out.includes('Server listening') ? true : undefined),
        30_000,
        `the API to listen (stderr: ${err})`,
      );
      assert.notEqual(probe('loaded'), undefined, 'the probe was preloaded');
      const t0 = Date.now();
      proc.kill('SIGTERM');
      const code = await exited;
      const elapsed = Date.now() - t0;
      const tracked = probe('tracked');
      const settled = probe('settled');
      const closeDb = probe('closeDb');
      assert.ok(tracked !== undefined, 'the stalled thunk was tracked at SIGTERM');
      assert.ok(
        settled !== undefined && closeDb !== undefined && settled <= closeDb,
        `the pool closed before the in-flight set drained (settled ${String(settled)}, closeDb ${String(closeDb)})`,
      );
      assert.equal(code, 0, err);
      assert.ok(elapsed < SHUTDOWN_BOUND_MS, `exit took ${elapsed} ms`);
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  },
);
