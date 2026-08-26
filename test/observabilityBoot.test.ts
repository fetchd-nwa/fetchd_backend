import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { AddressInfo, createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * **The pager's own wire-up, proven against the REAL entry point.**
 *
 * D20-A3 §A3.2, executed by the attack lane: `initObservability()` was a bare
 * statement in `src/index.ts`, and a transitive import walk over 107 test entry
 * files / 291 modules found `src/index.ts` reachable from **none** of them.
 * Delete the line and the gate stays GREEN while a production process with
 * `SENTRY_DSN` set, `env.ts`'s guard satisfied, and a healthy `/health` sends
 * **zero** envelopes — round 6's `?? NOOP_LOG` defect one layer up, and the
 * boot smoke, the shutdown flush and the bind-failure flush all unpinned with it.
 *
 * The only honest answer is to boot the actual entrypoint. So this file starts
 * `src/index.ts` as a real child process, in `NODE_ENV=production`, pointed at a
 * local HTTP listener standing in for Sentry ingest, and asserts an envelope
 * ARRIVES. Nothing here is stubbed except the destination host.
 *
 * That single test closes the hole rather than one of its symptoms — it fails
 * if the init line goes, if `server.ts` drops the `hooks:` wiring, if the smoke
 * stops travelling the tap (§A3.3), or if the envelope stops being an envelope.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything `env.ts` requires. Nothing here connects to anything: the pool and
 * the Redis client are both lazy, so a production boot that only binds and logs
 * never dials either one — which keeps this test hermetic.
 */
const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://user:pass@db.invalid:5432/postgres',
  REDIS_URL: 'redis://redis.invalid:6379',
  SUPABASE_JWKS_URL: 'https://project.invalid/auth/v1/.well-known/jwks.json',
  SUPABASE_JWT_AUD: 'authenticated',
  SUPABASE_JWT_ISS: 'https://project.invalid/auth/v1',
  SUPABASE_AUTH_WEBHOOK_SECRET: 'whsec_placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  SCHEDULER_WEBHOOK_SECRET: 'scheduler_placeholder',
  R2_ACCOUNT_ID: 'placeholder',
  R2_ACCESS_KEY_ID: 'placeholder',
  R2_SECRET_ACCESS_KEY: 'placeholder',
  R2_BUCKET: 'nwa-media-test',
};

/**
 * Obviously fake, never dialed. `.invalid` is RFC 2606's reserved TLD. The
 * project id is `424242` rather than `0` because `0` is Sentry's own example
 * project id and now fails CLOSED at boot (D20-A5.4) — a DSN that no longer
 * parses would fail these tests on the wrong step.
 */
const UNREACHABLE_DSN = 'https://not-a-real-key@example.sentry.invalid/424242';

interface CapturedEnvelope {
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  lines: string[];
}

/** A local stand-in for Sentry ingest: accept the POST, keep the bytes. */
async function startIngestListener(): Promise<{
  port: number;
  envelopes: CapturedEnvelope[];
  close: () => Promise<void>;
}> {
  const envelopes: CapturedEnvelope[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      envelopes.push({
        url: req.url ?? '',
        auth: req.headers['x-sentry-auth'] as string | undefined,
        contentType: req.headers['content-type'],
        lines: Buffer.concat(chunks).toString('utf-8').split('\n'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    envelopes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** An ephemeral port the API can bind. `PORT=0` is refused by the env contract. */
async function reserveFreePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms: ${describe()}`);
}

async function stop(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  return exited;
}

test('the REAL entrypoint boots and an envelope reaches ingest (D20-A3 §A3.2.3)', async () => {
  const ingest = await startIngestListener();
  const port = await reserveFreePort();
  let stderr = '';
  let stdout = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...BASE_ENV,
      PORT: String(port),
      // The real DSN shape, pointed at the listener above. `parseDsn` turns
      // this into `http://127.0.0.1:<port>/api/424242/envelope/`.
      SENTRY_DSN: `http://examplepublickey@127.0.0.1:${ingest.port}/424242`,
      SENTRY_BOOT_SMOKE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf-8')));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf-8')));

  try {
    await waitFor(
      () => ingest.envelopes.length > 0 || child.exitCode !== null,
      20_000,
      () =>
        `no envelope arrived. exit=${String(child.exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.equal(
      child.exitCode,
      null,
      `the process must still be running, not dead. stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.equal(
      ingest.envelopes.length,
      1,
      `exactly one boot smoke; got ${ingest.envelopes.length}`,
    );

    const envelope = ingest.envelopes[0];
    assert.ok(envelope !== undefined);
    assert.equal(envelope.url, '/api/424242/envelope/');
    assert.equal(envelope.contentType, 'application/x-sentry-envelope');
    assert.equal(
      envelope.auth,
      'Sentry sentry_key=examplepublickey, sentry_version=7, sentry_client=fetchd-backend/1.0',
    );

    const payload = JSON.parse(envelope.lines[2] ?? '') as Record<string, unknown>;
    assert.equal(payload['level'], 'error');
    assert.deepStrictEqual(payload['message'], {
      formatted: 'day-20 paging smoke — unset SENTRY_BOOT_SMOKE',
    });
    assert.equal(payload['environment'], 'production');
    // D20-A3 §A3.3: `logger: 'pino'` is the whole point. The smoke used to call
    // `captureAlarm` DIRECTLY (logger 'boot-smoke'), which proved transport →
    // Sentry → phone and proved nothing about the tap, the `hooks:` wiring, or
    // the effective LOG_LEVEL — the exact path every real money alarm takes.
    assert.equal(
      payload['logger'],
      'pino',
      'the smoke must travel the tap, not shortcut past the machinery it exists to prove',
    );
    const extra = payload['extra'] as Record<string, unknown>;
    assert.equal(extra['node_env'], 'production');
    assert.equal(extra['port'], port);
  } finally {
    const code = await stop(child);
    await ingest.close();
    assert.equal(code, 0, `SIGTERM must drain cleanly; stderr:\n${stderr}`);
  }
});

test('production `buildApp()` REFUSES to build without an installed pager (§A3.2.1)', () => {
  const run = (prelude: string): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `${prelude}
         const { buildApp } = await import('./src/server.js');
         buildApp();
         process.stdout.write('BUILT');`,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...BASE_ENV, SENTRY_DSN: UNREACHABLE_DSN },
        encoding: 'utf-8',
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  // Control: with the pager installed, production builds. Without this, the
  // refusal below would pass on any unrelated import failure.
  const withPager = run(
    `const o = await import('./src/lib/observability.js');
     o.initObservability({ installProcessHandlers: false });`,
  );
  assert.equal(withPager.status, 0, `control must build; stderr: ${withPager.stderr}`);
  assert.equal(withPager.stdout, 'BUILT');

  // The §A3.2 mutant, made permanent: `initObservability()` never ran, the DSN
  // is set, `env.ts` is satisfied — and this is now a hard boot failure instead
  // of a healthy process whose money alarms go nowhere.
  const withoutPager = run('');
  assert.equal(withoutPager.status, 1, `expected exit 1; stdout: ${withoutPager.stdout}`);
  assert.equal(withoutPager.stdout, '', 'the app must not be built');
  assert.match(withoutPager.stderr, /no pager is installed/);
  assert.match(withoutPager.stderr, /initObservability\(\) must run before buildApp\(\)/);
});

test('a URL-shaped but malformed SENTRY_DSN kills the boot at index.ts (D20-A2 §A2.5.3)', async () => {
  // `env.ts` only proves the value is a URL, and `envProductionGuards.test.ts`
  // imports only `src/env.js` — so "a malformed DSN refuses to boot" was true
  // by INFERENCE and pinned by nothing. All three of these satisfy Zod, so a
  // valid PORT is passed deliberately: the only thing that may stop this boot
  // is the DSN, and the assertion below insists on exactly that message rather
  // than accepting any refusal.
  const port = await reserveFreePort();
  for (const dsn of [
    'https://sentry.example.com/424242', // no key
    'https://key@sentry.example.com', // no project id
    'https://key@sentry.example.com/not-a-project', // non-numeric project id
  ]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT,
      env: { ...BASE_ENV, PORT: String(port), SENTRY_DSN: dsn },
      encoding: 'utf-8',
    });
    assert.equal(result.status, 1, `${dsn} must kill the boot; stdout: ${result.stdout}`);
    assert.match(
      result.stderr,
      /is not a Sentry DSN/,
      `${dsn}: the boot must die naming the DSN; got ${result.stderr}`,
    );
  }
});
