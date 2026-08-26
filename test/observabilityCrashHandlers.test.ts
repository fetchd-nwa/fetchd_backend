import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * **The crash handlers must not swallow the crash.**
 *
 * `initObservability` installs `uncaughtException` / `unhandledRejection`
 * listeners so the fatal alarm leaves the process before it dies. Installing a
 * listener SUPPRESSES Node's default behavior — which is exactly how a
 * well-meaning observability hook turns a loud crash into a zombie process
 * that Railway never restarts. So the claim "today's crash semantics are
 * preserved" has to be measured, not asserted: same exit code, same stack on
 * stderr, with and without the handlers installed.
 *
 * Only a real process can answer that (the handler ends in `process.exit(1)`),
 * so each case spawns one. The injected transport resolves immediately and
 * touches no network.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Install the pager with a silent in-memory transport, then crash. */
const WITH_HANDLERS = `
  const o = await import('./src/lib/observability.js');
  o.initObservability({ transport: { send: () => Promise.resolve() } });
`;

interface CrashResult {
  status: number | null;
  stderr: string;
}

function runCrasher(prelude: string, crash: string): CrashResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', prelude + crash], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return { status: result.status, stderr: result.stderr };
}

const THROW_LATER = `
  setTimeout(() => { throw new Error('synthetic uncaught boom'); }, 0);
`;
const REJECT_LATER = `
  setTimeout(() => { Promise.reject(new Error('synthetic unhandled rejection')); }, 0);
`;

test('control: without the handlers, an uncaught throw exits 1 and prints the stack', () => {
  const crashed = runCrasher('', THROW_LATER);
  assert.equal(crashed.status, 1, 'this is the behavior Day-20 must not change');
  assert.match(crashed.stderr, /synthetic uncaught boom/);
});

test('uncaughtException: the handler pages, then still exits 1 with the stack on stderr', () => {
  const crashed = runCrasher(WITH_HANDLERS, THROW_LATER);
  assert.equal(
    crashed.status,
    1,
    `observing a crash must not survive it; stderr: ${crashed.stderr}`,
  );
  assert.match(crashed.stderr, /\[observability\] uncaughtException/);
  assert.match(crashed.stderr, /synthetic uncaught boom/, 'the stack must still reach an operator');
});

test('unhandledRejection: same — paged, then exit 1', () => {
  const crashed = runCrasher(WITH_HANDLERS, REJECT_LATER);
  assert.equal(crashed.status, 1, `stderr: ${crashed.stderr}`);
  assert.match(crashed.stderr, /\[observability\] unhandledRejection/);
  assert.match(crashed.stderr, /synthetic unhandled rejection/);
});
