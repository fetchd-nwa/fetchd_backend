import { childEnv, waitUntil } from './_realtime.js';
import { realBoot } from './_realBoot.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { countLostStaffMessagePushes } from '../../src/lib/messageNotice.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * The boot count's call site, through the real entry point (O-MSG-LIVE pass 3 item 4; design
 * messaging-live-v1 A2 FM2 and FH1; brief LR5, FM2-b, FH1-d). After `app.listen` and
 * `startBus()`, `src/index.ts` counts the staff message pushes a crash lost (claimed over a
 * minute ago, never stamped with tickets) in one line, through `fireAndForget`: never awaited, so
 * a database that is behind rs3, or that refuses the count, is one warn line and the process
 * stays up. `observability.ts` exits the process on an `unhandledRejection` or an
 * `uncaughtException` and says so on stderr (`[observability] … process will exit 1`), so "no
 * unhandledRejection" here reads as: that line never printed, and the process is still up.
 *
 * Each case spawns `src/index.ts` itself on `childEnv()` (NODE_ENV=staging: no `.env*` load;
 * this pair's URLs; an explicit ephemeral PORT). No case sends a message, so no child can reach
 * Expo (`EXPO_PUSH_URL` is hard-coded). Pass 2 pinned the count's function in-process
 * (`message-notice.test.ts`, FM2-b and FH1-d); this file pins that the process calls it.
 */

registerFixtureHooks();

/** pass 2's sentences (`src/lib/messageNotice.ts`): the count, and the table missing. */
const BOOT_COUNT = 'boot: staff message pushes claimed over a minute ago and never sent';
const BOOT_TABLE_MISSING =
  'boot: message_pushes is missing (the database is behind rs3), so no lost push is counted';
/** `fireAndForget`'s own line for this call site (`settle.ts`: `${what} failed (not retried)`). */
const BOOT_COUNT_FAILED = 'boot: the lost staff message push count failed (not retried)';

/** The name `message_pushes` takes while FH1-d's child boots (this pair only; restored). */
const ASIDE = 'message_pushes_f3b_fh1d';

type Line = Record<string, unknown> & { level?: number; msg?: string };

interface BootedApi {
  port: number;
  /** Every JSON line the child wrote on stdout so far, in order. */
  lines(): Line[];
  stderr(): string;
  exitCode(): number | null;
  /** SIGTERM, then the exit code (SIGKILL after 15 s). */
  stop(): Promise<number | null>;
}

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

/** Boot `src/index.ts` in a child and wait for "Server listening". */
async function bootIndex(extra: Record<string, string> = {}): Promise<BootedApi> {
  // An empty working directory of its own, whatever this tree holds (`_realBoot.ts`).
  const boot = realBoot();
  const port = await freePort();
  const proc = spawn(process.execPath, boot.args, {
    cwd: boot.cwd,
    env: { ...childEnv({ PORT: String(port), LOG_LEVEL: 'info', ...extra }), ...boot.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let code: number | null = null;
  let exitedFlag = false;
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    proc.on('close', (c) => {
      code = c;
      exitedFlag = true;
      boot.dispose();
      resolve(c);
    }),
  );
  const lines = (): Line[] =>
    out
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Line);
  try {
    await waitUntil(
      () => {
        if (exitedFlag) throw new Error(`the API exited during boot (code ${code}): ${err}`);
        return lines().some(
          (l) => typeof l.msg === 'string' && l.msg.startsWith('Server listening'),
        )
          ? true
          : undefined;
      },
      30_000,
      'the API to listen',
    );
  } catch (e) {
    if (!exitedFlag) proc.kill('SIGKILL');
    throw e;
  }
  return {
    port,
    lines,
    stderr: () => err,
    exitCode: () => (exitedFlag ? code : null),
    async stop() {
      if (exitedFlag) return code;
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
      const c = await exited;
      clearTimeout(timer);
      return c;
    },
  };
}

function withMsg(api: BootedApi, msg: string): Line[] {
  return api.lines().filter((l) => l.msg === msg);
}

/** The first line with this `msg`; fails at once, with the exit code and stderr, if the child exits. */
async function waitForMsg(api: BootedApi, msg: string, what: string): Promise<Line> {
  return waitUntil(
    () => {
      const code = api.exitCode();
      if (code !== null) {
        throw new Error(
          `the API exited (code ${code}) before ${what}; stderr tail:\n${api.stderr().slice(-1500)}`,
        );
      }
      return withMsg(api, msg)[0];
    },
    10_000,
    what,
  );
}

/** Every line the count's call site can print: the count, the table missing, the failure. */
function countLines(api: BootedApi): Line[] {
  return api
    .lines()
    .filter(
      (l) => l.msg === BOOT_COUNT || l.msg === BOOT_TABLE_MISSING || l.msg === BOOT_COUNT_FAILED,
    );
}

function indexOfMsg(api: BootedApi, match: (msg: string) => boolean): number {
  return api.lines().findIndex((l) => typeof l.msg === 'string' && match(l.msg));
}

/** Up = not exited, and still answering HTTP (any status: a 503 is an answer, not a crash). */
async function assertUp(api: BootedApi): Promise<void> {
  // A window for an escape: `crashAfterAlarm` exits only after its flush.
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(api.exitCode(), null, `the API process exited; stderr:\n${api.stderr()}`);
  const res = await fetch(`http://127.0.0.1:${api.port}/health`);
  assert.equal(typeof res.status, 'number');
  await res.arrayBuffer();
  assert.equal(api.exitCode(), null, 'the API process is still running after an HTTP answer');
}

function assertNothingEscaped(api: BootedApi): void {
  assert.doesNotMatch(
    api.stderr(),
    /\[observability\] (unhandledRejection|uncaughtException)/,
    'an un-awaited path escaped and the process was told to exit',
  );
  const paged = api.lines().filter((l) => typeof l.level === 'number' && l.level >= 50);
  assert.deepEqual(paged, [], 'nothing at level >= 50 (the pager tap)');
}

async function restoreTable(): Promise<void> {
  const { rows } = await db.execute<{ aside: boolean; present: boolean }>(sql`
    SELECT to_regclass(${`public.${ASIDE}`}) IS NOT NULL AS aside,
           to_regclass('public.message_pushes') IS NOT NULL AS present`);
  if (rows[0]?.aside === true && rows[0]?.present === false) {
    await db.execute(sql.raw(`ALTER TABLE ${ASIDE} RENAME TO message_pushes`));
  }
}

after(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  // A case that died between its rename and its finally must not leave the pair behind rs3.
  await restoreTable();
});

test(
  'FM2-b through the real boot: one stale unsent claim → the child prints the count 1, once, after listen (a fresh claim and a stamped one are not lost)',
  SKIP_WHEN_NO_DB,
  async () => {
    assert.equal(await countLostStaffMessagePushes(), 0, 'precondition: no lost push on the pair');
    const stale = FIXTURE_IDS.message1Id;
    const fresh = FIXTURE_IDS.message2Id;
    const stamped = FIXTURE_IDS.message3Id;
    await db.execute(sql`
      INSERT INTO message_pushes (message_id, claimed_at, tickets_ok, tickets_error) VALUES
        (${stale}, now() - interval '2 minutes', NULL, NULL),
        (${fresh}, now(), NULL, NULL),
        (${stamped}, now() - interval '2 minutes', 1, 0)`);
    let api: BootedApi | undefined;
    try {
      assert.equal(await countLostStaffMessagePushes(), 1, 'precondition: exactly one lost push');
      api = await bootIndex();
      const booted = api;
      const line = await waitForMsg(booted, BOOT_COUNT, 'the boot count line');
      await assertUp(booted);
      assert.equal(countLines(booted).length, 1, 'exactly one boot-count line');
      assert.equal(line?.lostPushes, 1);
      assert.equal(line?.level, 40, 'a lost push is a warn, below the pager');
      const listening = indexOfMsg(booted, (m) => m.startsWith('Server listening'));
      assert.ok(
        listening >= 0 && indexOfMsg(booted, (m) => m === BOOT_COUNT) > listening,
        'the count runs after listen',
      );
      assertNothingEscaped(booted);
      assert.equal(await booted.stop(), 0);
    } finally {
      await api?.stop();
      await db.execute(
        sql`DELETE FROM message_pushes WHERE message_id IN (${stale}, ${fresh}, ${stamped})`,
      );
    }
  },
);

test(
  'FH1-d through the real boot: message_pushes missing (a database behind rs3) → one warn, the count 0, no unhandledRejection, the process up',
  SKIP_WHEN_NO_DB,
  async () => {
    let api: BootedApi | undefined;
    await db.execute(sql.raw(`ALTER TABLE message_pushes RENAME TO ${ASIDE}`));
    try {
      api = await bootIndex();
      const booted = api;
      const line = await waitForMsg(booted, BOOT_TABLE_MISSING, 'the missing-table warn');
      await assertUp(booted);
      assert.equal(countLines(booted).length, 1, 'exactly one boot-count line');
      assert.equal(line?.level, 40);
      assert.equal(line?.lostPushes, 0);
      assertNothingEscaped(booted);
      assert.equal(await booted.stop(), 0);
    } finally {
      await api?.stop();
      await restoreTable();
    }
    const { rows } = await db.execute<{ present: boolean }>(
      sql`SELECT to_regclass('public.message_pushes') IS NOT NULL AS present`,
    );
    assert.equal(rows[0]?.present, true, 'the table is back');
  },
);

test(
  'FH1-d, the count rejecting (the database refuses at boot): one warn from fireAndForget, no unhandledRejection, the process up and serving',
  SKIP_WHEN_NO_DB,
  async () => {
    // Nothing listens on this port: the count's first query rejects. A Postgres blip at boot is
    // FH1's own case ("one DB blip … would drop every socket"); `listen` needs no database, so
    // the boot reaches the count. No database is touched.
    const closed = await freePort();
    const api = await bootIndex({
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${closed}/no_database_listens_here`,
    });
    try {
      const line = await waitForMsg(api, BOOT_COUNT_FAILED, "fireAndForget's warn for the count");
      await assertUp(api);
      assert.equal(countLines(api).length, 1, 'exactly one boot-count line');
      assert.equal(line?.level, 40, 'a warn, below the pager');
      assertNothingEscaped(api);
    } finally {
      await api.stop();
    }
  },
);
