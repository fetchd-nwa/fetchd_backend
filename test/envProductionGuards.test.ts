import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * **The two Day-20 boot refusals, proven against a real boot.**
 *
 * `src/env.ts` ends in `process.exit(1)` on a bad contract, which is not
 * something an in-process test can observe — and observing the Zod schema
 * instead would prove that a schema object rejects, not that THE SERVER
 * REFUSES TO START. Those are different claims, and the second one is the
 * product behavior. (Same lesson as the round-6 alarm channel: test the
 * production entry-point shape, not a convenient stand-in.)
 *
 * So each case here spawns a real Node process that imports `src/env.js` with
 * a synthetic environment, and reads its exit code and stderr.
 *
 * What is being guarded:
 *
 *   - `NODE_ENV=production` with no `SENTRY_DSN` — a production API that pages
 *     nobody. This is the `?? NOOP_LOG` defect of 2026-08-24 (12000c refunded
 *     to an owner, zero operator-facing output) relocated to the config layer,
 *     where it can be refused instead of discovered.
 *   - `NODE_ENV=production` with `LOG_LEVEL=fatal` — demotion-by-config.
 *     Verified against the installed pino 10.3.1: `hooks.logMethod` is NOT
 *     invoked for calls suppressed below the active level, so at `fatal` every
 *     error-level alarm is silently dropped BEFORE the tap can forward it,
 *     while the process looks perfectly healthy.
 *
 * The first test is the control. Without a production env that DOES boot,
 * "production refuses" proves nothing — any typo in the fixture below would
 * produce the same red, and the two guards would be untested.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Obviously fake, never dialed. It exists only to satisfy `z.string().url()`;
 * `.invalid` is the reserved never-resolvable TLD (RFC 2606). A real DSN is a
 * write credential for a Sentry project and never belongs in a repo.
 *
 * The project id is `424242`, not `0`: `0` is the project id in Sentry's own
 * example DSN and fails CLOSED at boot since D20-A5.4, which would make these
 * guards refuse for a reason none of them is about.
 */
const PLACEHOLDER_DSN = 'https://not-a-real-key@example.sentry.invalid/424242';

/**
 * Everything `env.ts` requires, minus the Day-20 vars under test. Values are
 * shape-valid and point nowhere: nothing here connects to anything — importing
 * `env.ts` parses and returns.
 */
const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
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

interface BootResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Boot `src/env.ts` in a fresh process with EXACTLY the given environment.
 * `env` is replaced wholesale (not merged onto `process.env`) so the runner's
 * own DATABASE_URL / NODE_ENV can't leak in and quietly satisfy the contract.
 */
function bootEnv(overrides: Record<string, string>): BootResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "await import('./src/env.js'); process.stdout.write('ENV_OK');"],
    {
      cwd: REPO_ROOT,
      env: { ...BASE_ENV, ...overrides },
      encoding: 'utf-8',
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('control: a complete production environment boots (so the refusals below mean something)', () => {
  const boot = bootEnv({ NODE_ENV: 'production', SENTRY_DSN: PLACEHOLDER_DSN });
  assert.equal(boot.status, 0, `production env must boot; stderr: ${boot.stderr}`);
  assert.equal(boot.stdout, 'ENV_OK');
});

test('production without SENTRY_DSN refuses to boot, naming the pager as the reason', () => {
  const boot = bootEnv({ NODE_ENV: 'production' });
  assert.equal(boot.status, 1, `expected exit 1; stdout: ${boot.stdout} stderr: ${boot.stderr}`);
  assert.equal(boot.stdout, '', 'the process must not reach past the env contract');
  assert.match(boot.stderr, /Invalid environment — refusing to boot/);
  assert.match(boot.stderr, /SENTRY_DSN/);
  // The message has to say WHY, or the next person sets a dummy value to make
  // the boot pass and reinvents the silent no-op it exists to prevent.
  assert.match(boot.stderr, /pages nobody/);
});

test('production with LOG_LEVEL=fatal refuses to boot, naming the suppressed hook', () => {
  const boot = bootEnv({
    NODE_ENV: 'production',
    SENTRY_DSN: PLACEHOLDER_DSN,
    LOG_LEVEL: 'fatal',
  });
  assert.equal(boot.status, 1, `expected exit 1; stdout: ${boot.stdout} stderr: ${boot.stderr}`);
  assert.match(boot.stderr, /LOG_LEVEL/);
  assert.match(boot.stderr, /would never reach the pager/);
});

test('production missing BOTH reports both issues, not just the first', () => {
  const boot = bootEnv({ NODE_ENV: 'production', LOG_LEVEL: 'fatal' });
  assert.equal(boot.status, 1);
  assert.match(boot.stderr, /SENTRY_DSN/);
  assert.match(boot.stderr, /LOG_LEVEL/);
});

test('development and staging boot without a DSN — the guard is production-only', () => {
  for (const nodeEnv of ['development', 'staging'] as const) {
    // `.env`/`.env.local` are only loaded outside production/staging, and the
    // repo's `.env` has no SENTRY_DSN, so 'development' here is a genuine
    // no-DSN boot rather than one rescued by a file.
    const boot = bootEnv({ NODE_ENV: nodeEnv });
    assert.equal(boot.status, 0, `${nodeEnv} must boot without a DSN; stderr: ${boot.stderr}`);
    assert.equal(boot.stdout, 'ENV_OK');
  }
});

test('LOG_LEVEL=fatal is allowed outside production (nothing pages there)', () => {
  const boot = bootEnv({ NODE_ENV: 'development', LOG_LEVEL: 'fatal' });
  assert.equal(boot.status, 0, `stderr: ${boot.stderr}`);
});

/**
 * **`SENTRY_BOOT_SMOKE` is a DIAGNOSTIC a non-engineer types into a dashboard**
 * (D20-A4 §A4.4.2). As a strict `'true' | 'false'` enum, `TRUE` or `True` was
 * four crash-boots and a failed deploy (`railway.json`,
 * `restartPolicyMaxRetries: 3`) for a capitalisation — with the explanation on
 * stderr only, landing on Allison mid-production-surgery. That is D20-A2
 * §A2.2's failure shape a second time: a guard whose refusal is correct in
 * principle and unrecoverable in practice.
 *
 * Case-insensitive, and the refusal names the accepted values so a boot that IS
 * refused explains itself from the Railway log.
 */
for (const accepted of ['true', 'TRUE', 'True', 'tRuE', 'false', 'FALSE', 'False']) {
  test(`SENTRY_BOOT_SMOKE=${accepted} boots — a capitalisation must not brick a deploy`, () => {
    const boot = bootEnv({
      NODE_ENV: 'production',
      SENTRY_DSN: PLACEHOLDER_DSN,
      SENTRY_BOOT_SMOKE: accepted,
    });
    assert.equal(boot.status, 0, `expected a clean boot; stderr: ${boot.stderr}`);
    assert.equal(boot.stdout, 'ENV_OK');
  });
}

test('SENTRY_BOOT_SMOKE=1 is still refused, and the refusal NAMES the accepted values', () => {
  // Not everything is accepted — the point is that a refusal must be
  // actionable from the log alone, not that the contract is abandoned.
  const boot = bootEnv({
    NODE_ENV: 'production',
    SENTRY_DSN: PLACEHOLDER_DSN,
    SENTRY_BOOT_SMOKE: '1',
  });
  assert.equal(boot.status, 1, `expected exit 1; stdout: ${boot.stdout}`);
  assert.match(boot.stderr, /SENTRY_BOOT_SMOKE/);
  assert.match(boot.stderr, /true/, 'the message must say what IS accepted');
  assert.match(boot.stderr, /false/);
  assert.match(boot.stderr, /case-insensitive/i);
});
