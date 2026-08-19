import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertTestDatabaseUrl } from './_dbGuard.js';

const TEST_DB_URL = 'postgres://postgres:postgres@localhost:5433/postgres';
const DEV_DB_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

describe('assertTestDatabaseUrl', () => {
  it('accepts the isolated db-test container on :5433', () => {
    assertTestDatabaseUrl(TEST_DB_URL);
  });

  it('refuses the dev database on :5432', () => {
    assert.throws(() => assertTestDatabaseUrl(DEV_DB_URL), /REFUSING/);
  });

  it('refuses a portless URL (implicit :5432)', () => {
    assert.throws(
      () => assertTestDatabaseUrl('postgres://postgres:postgres@localhost/postgres'),
      /REFUSING/,
    );
  });

  it('refuses an unparseable URL', () => {
    assert.throws(() => assertTestDatabaseUrl('not-a-url'), /REFUSING/);
  });

  it('never echoes credentials in the refusal', () => {
    assert.throws(
      () => assertTestDatabaseUrl('postgres://user:hunter2@localhost:5432/db'),
      (error: unknown) => error instanceof Error && !error.message.includes('hunter2'),
    );
  });
});

/**
 * The wiring proof. The unit tests above stay green even if `_fixture.ts`
 * stops CALLING the guard — which is exactly the failure that would re-open
 * the 2026-08-13 incident (bare `tsx --test`, `.env.local` wins, teardown
 * hard-DELETEs against the dev DB). So import the real fixture module in a
 * child process with DATABASE_URL mis-pointed and assert it dies at module
 * load; the :5433 control proves the harness itself can pass. Importing
 * `_fixture.ts` opens no connection — the pg pool is lazy — so neither child
 * needs a database and neither can touch one.
 */
function importFixture(databaseUrl: string): ReturnType<typeof spawnSync<string>> {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "await import('./test/contracts/_fixture.ts');",
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

describe('_fixture.ts wires the guard at module load', () => {
  it('a mis-pointed DATABASE_URL kills the fixture before it can connect', () => {
    const result = importFixture(DEV_DB_URL);
    assert.notStrictEqual(result.status, 0, 'fixture loaded clean against a non-:5433 URL');
    assert.match(result.stderr, /REFUSING to run contract tests/);
  });

  it('control: the :5433 URL loads clean, so the harness can pass', () => {
    const result = importFixture(TEST_DB_URL);
    assert.strictEqual(result.status, 0, result.stderr);
  });
});
